# Handoff — build the ingest CLI

This is a task brief, not a map. Read [`path-to-daily-use.md`](path-to-daily-use.md) first for
where this sits (it is step 1 of six), and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the gate
and what a commit needs. Everything below was read out of the code on 2026-08-27 and the file and
symbol names were confirmed to exist; re-check before relying on any of it, because that is the
failure this document exists to prevent.

## The job in one sentence

`kf ingest` now drives `planIngest` and the typed document actions. The planner remains the first
boundary: refusal happens before database pools, source files, or object storage are touched.

```
kf ingest --mode=copy|reference --classification=<id> --identity=dev|oidc \
  [--revision=<label>] [--kind=<k>] [--reference-manifest=<file>] \
  [--organization=<uuid> --acting-role=<uuid> --token-file=<file>] [--reason=<text>] \
  [--drive=<fileId>[@<revisionId>] ...] [--export-mime=<type>] \
  [--json] <paths...>
```

A Drive source (ADR 0022) is copy-mode only. `--drive` is repeatable and names one file — never
a folder. The bytes are fetched read-only as the service account in
`KF_DRIVE_SERVICE_ACCOUNT_FILE` (a permission-checked key file, host state per
`deploy/systemd/README.md`), hashed, stored, and attached exactly like a local file, with the
file id, the revision read, and the exporter recorded on the act and as an `external_locator`
row. A Google-native document (Docs, Sheets, Slides) is exported at its head revision only;
`--export-mime` overrides the pinned default target.

Run `pnpm kf ingest ...` from repository root (or build and invoke the API package bin as
`kf ingest ...`). The root script builds API dependencies before dispatching the command.
Development identity requires `NODE_ENV=development`, `KF_ALLOW_FIXED_IDENTITY=1`, and the
three explicit `KF_DEV_*` UUIDs. OIDC requires the existing `TokenVerifier` configuration,
`--organization`, `--acting-role`, and a permission-checked `--token-file`; bearer values are
never accepted inline or printed.

Reference metadata is a JSON object with exactly one entry per CLI path:

```json
{
  "entries": [
    {
      "path": "vendor/part.pdf",
      "source_system": "document_system",
      "authority": "evidence",
      "locator_system": "vendor-portal",
      "external_id": "ADS-1",
      "title": "Part datasheet",
      "uri": "https://vendor.example/ADS-1"
    }
  ]
}
```

Paths are matched after lexical `resolve()` from invocation cwd. `title` and `uri` are optional;
`--revision` and `--kind` apply to the whole batch. Reference mode hashes files but makes no
object-store call; copy mode stores under `ingest/<organization>/<sha256>` with conditional
create and exact upload verification. All action rows share one transaction and deterministic
content-derived idempotency keys.

## Why this task and not another

At initial measurement the Fabric held **14 objects, all fixtures**. The compiled master record contains **one item in
`your_record`, and it is the person's own node**; the other 13 are `org_view`, and every refusal
path — withholdings, entitlement exclusions, link revocations — has zero rows.

After implementation dogfood, the local database has 17 core objects, 7 artifacts, 7 artifact
versions, and 1 external locator. That proves copy and reference writes are reachable; it does
not yet prove relevance closure or a complete master record.

That is exactly what a correct empty database looks like. It is also exactly what a **broken
relevance closure** looks like, and the current data cannot tell the two apart. Ingesting real
material and seeing whether `your_record` stops being a single self-reference is the cheapest
available test of whether relevance works at all. Do this before building anything on top of it.

## What already exists — do not rewrite these

| thing                        | where                                                          | state                                      |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| The planner                  | `apps/api/src/ingest/plan.ts`                                  | done, pure, 15 tests, all guards falsified |
| The CLI                      | `apps/api/src/ingest/cli.ts`, `apps/api/src/cli.ts`            | done, copy/reference paths and identities  |
| The policy and its reasoning | `docs/decisions/0012-file-ingestion.md`                        | accepted                                   |
| The reference-mode action    | `packages/documents/src/internal/external-artifact-actions.ts` | done, wired                                |
| The copy-mode action         | `attach_evidence`, same package                                | pre-existing                               |
| Ontology registration        | `ontology/action-types.yaml`, `DECLARED_ADDITIONS`             | done                                       |

`planIngest(request: IngestRequest): IngestPlan` returns either
`{ok: true, mode, classification, items}` where each item is `{path, artifactKind, mediaType}`, or
`{ok: false, refusals: string[]}`. **The CLI's whole job on the refusal branch is to print every
refusal and exit non-zero.** Do not filter, re-order, or partially proceed — the batch is
all-or-nothing on purpose, and ADR 0012 explains why.

## The two paths, and which action each takes

**`--mode=reference`** — we do not hold the bytes. Dispatch `register_external_artifact`. Its
payload, from the materializer and effect as written:

- materializer requires: `source_system`, `title`, `artifact_kind`
- effect requires: `revision_label`, `authority`, `sha256`, `size_bytes`, `media_type`,
  `locator_system`, `external_id`; `uri` is optional

The two enumerated fields, each checked against the code by
`tests/deployment/handoff-brief.test.ts` so this cannot quietly go stale:

- accepted source_system: `git`, `cad_pdm`, `document_system`, `accounting`, `external`
- accepted authority: `authoritative`, `evidence`, `mirror`, `lookup`

`object_store` is **not** in that first list and passing it is refused by name — that claim is
`attach_evidence`, below.

You still hash the file to fill `sha256` — the digest is the whole point of a reference. You just
never write the bytes into the object store.

**`--mode=copy`** — we hold the bytes. Use `attach_evidence`
(`packages/documents/src/internal/evidence-actions.ts`), unchanged. Note it hardcodes
`source_system='object_store'` and requires a `storage_uri`; that is correct for this path and is
the reason the other action had to exist.

## The spine to copy, not invent

`apps/api/src/dogfood/runtime.ts` is the working model for a command that mutates the Fabric.
Take its shape:

1. `createPool` on owner and constrained application URLs, `withTransaction`.
2. `setResolvedAccessContext(tx, {subjectId, assignmentId, organizationId, requestedClassification})`
   and **check the returned decision** before staging any bytes.
3. Dispatch through `createFabricTransactionalDispatcher` with
   `createDocumentActionAtoms` — that is where `register_external_artifact` is already bound
   (`packages/documents/src/internal/action-atoms.ts`, materializer and effect).

Copy `assertDogfoodIdentityReady`'s discipline in particular: **validate authority before writing
object-store bytes.** A missing clearance is an expected fail-closed operator state, not a reason
to leave unreferenced data in the bucket. It distinguishes an authority refusal (`42501`, `P0001`,
or a message matching /classification|clearance/) from a real infrastructure error and does not
swallow the second.

## Acceptance

- Every `planIngest` refusal reaches the operator verbatim, and the process exits non-zero.
- A `--mode=copy` run over a path containing `vendor`, `vendors`, `supplier`, `suppliers`,
  `third-party`, `thirdparty`, `datasheets`, or a filename containing `datasheet`, refuses **the
  whole batch** and names the file and the rule.
- A reference-mode ingest produces an `artifact_version` with `storage_uri IS NULL` and a
  non-null `revision_label`, plus one `content.external_locator` row.
- Re-running the same batch does not duplicate objects. `attach_evidence` staging is already
  content-addressed with conditional create; match that property rather than assuming it.
- A reference manifest has exactly one entry per path and records no object-store write.
- Development fixed identity and OIDC identity both reach the same owner preflight and action
  transaction; OIDC tokens are read from a permission-checked file.
- `pnpm gate` green, and **every new guard falsified** — remove the check, watch the specific
  test go red, restore. See below.

## Traps that have already cost time here

**A test can pass for the wrong reason, and this file's own history proves it.** Deleting
`plan.ts`'s missing-mode check left all 14 tests of the day green, because an absent mode fell
through to the unknown-mode branch and both messages contained `--mode`, which was all the
assertion checked. The fix tightened that assertion to the specific guidance and added a 15th test
proving the two branches are distinguishable — which is why the table above says 15.

**Do not report a gate result you piped.** `pnpm gate | tail` exits with `tail`'s status. It
reported success over a real failure in this session. Redirect to a file and echo `$?`.

**`pgrep -f`/`pkill -f` match your own shell**, because the pattern is in its command line. Use a
character class — `pgrep -f 'pnpm ga[t]e'` — or a pidfile.

**Commit with `-F <file>`, never `-m`.** zsh command-substitutes backticks inside double quotes,
and commit messages here contain code spans.

**Every commit goes through external review** (`review_commit`), and reviewers run ~20–30% false
positives. Open the cited file:line and confirm the bug before changing anything; record the
findings you skipped, and why, in the follow-up commit message.

## Standing constraints that override convenience

- **PHI never enters any git repository.** Git does not forget; a reverted commit is still a
  disclosure.
- **Vendor datasheets are third-party copyright** — referenced by document number, revision and
  hash, never committed. This is the entire reason reference mode exists.
- The repository is **public**. Anything committed is permanently public.

## What is explicitly not in this task

- A watched folder or any filesystem mount. Deferred to `OW-WAR-0056`, which is not yet authored.
  The reason it is deferred: a mount that caches is a copy, and a copy outside KF is a second
  source of truth.
- Moving the reference-only rule list into the ontology. It is a short, deliberately readable list
  in code; revisit only if it grows.

## Walked implementation surface

Public parser and manifest seams are covered by `apps/api/src/ingest/cli.test.ts`. Runtime action
coverage belongs to the existing database/end-to-end harness; a live run should use only
non-PHI, organization-owned files after `pnpm gate` passes. The CLI deliberately adds no watched
folder, web viewer, or cleanup API; those remain outside this handoff and under the Warrant's
deferred work.
