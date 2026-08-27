# Handoff — build the ingest CLI

This is a task brief, not a map. Read [`path-to-daily-use.md`](path-to-daily-use.md) first for
where this sits (it is step 1 of six), and [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the gate
and what a commit needs. Everything below was read out of the code on 2026-08-27 and the file and
symbol names were confirmed to exist; re-check before relying on any of it, because that is the
failure this document exists to prevent.

## The job in one sentence

Write the command that drives `planIngest` — the planner exists and is tested, nothing calls it.

```
kf ingest --mode=copy|reference --classification=<id> [--revision=<label>] [--kind=<k>] <paths...>
```

## Why this task and not another

The Fabric holds **14 objects, all fixtures**. The compiled master record contains **one item in
`your_record`, and it is the person's own node**; the other 13 are `org_view`, and every refusal
path — withholdings, entitlement exclusions, link revocations — has zero rows.

That is exactly what a correct empty database looks like. It is also exactly what a **broken
relevance closure** looks like, and the current data cannot tell the two apart. Ingesting real
material and seeing whether `your_record` stops being a single self-reference is the cheapest
available test of whether relevance works at all. Do this before building anything on top of it.

## What already exists — do not rewrite these

| thing                        | where                                                          | state                                      |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| The planner                  | `apps/api/src/ingest/plan.ts`                                  | done, pure, 15 tests, all guards falsified |
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

- materializer: `source_system` (one of `git`, `cad_pdm`, `document_system`, `accounting`,
  `external` — **never** `object_store`, which it refuses by name), `title`, `artifact_kind`
- effect: `revision_label`, `authority` (one of `authoritative`, `evidence`, `mirror`, `lookup`),
  `sha256`, `size_bytes`, `media_type`, `locator_system`, `external_id`, and optional `uri`

You still hash the file to fill `sha256` — the digest is the whole point of a reference. You just
never write the bytes into the object store.

**`--mode=copy`** — we hold the bytes. Use `attach_evidence`, unchanged. Note it hardcodes
`source_system='object_store'` and requires a `storage_uri`; that is correct for this path and is
the reason the other action had to exist.

## The spine to copy, not invent

`apps/api/src/dogfood/runtime.ts` is the working model for a command that mutates the Fabric.
Take its shape:

1. `createPool` on the owner URL, `withTransaction`.
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
- `pnpm gate` green, and **every new guard falsified** — remove the check, watch the specific
  test go red, restore. See below.

## Traps that have already cost time here

**A test can pass for the wrong reason, and this file's own history proves it.** Deleting
`plan.ts`'s missing-mode check left all 14 tests green, because an absent mode fell through to the
unknown-mode branch and both messages contained `--mode`, which was all the assertion checked.
Assert the specific guidance, and add a test that proves two branches are distinguishable.

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
