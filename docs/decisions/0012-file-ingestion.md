# A file enters the Fabric by copy or by reference, and never by default

**Status:** accepted
**Date raised:** 2026-08-27
**Date decided:** 2026-08-27
**Decision owner:** technical authority
**Scope:** how an arbitrary file becomes a registry item — which action records it, whether the
Fabric holds its bytes or points at them, and what an ingest run refuses

## The problem, measured

The Knowledge Fabric is meant to be the sole source of all information. It had no way to admit
an arbitrary file. The only `ingest` in the tree was ML metric events; everything else came in
through a dogfood loader wired to the constitution corpus.

Worse than absent — the one available path was the wrong one for a whole class of material.
`packages/documents/src/internal/evidence-actions.ts` hardcodes:

```sql
insert into content.artifact (id, artifact_kind, source_system) values ($1,$2,'object_store')
```

and requires a `storage_uri`. So `attach_evidence` **always copies bytes**, and nothing outside
export/import had ever written `content.external_locator`. A vendor datasheet is third-party
copyright and the standing rule is that it is referenced by document number, revision and hash,
never held. The lawful path did not exist and the unlawful one was the only one available.

## What the schema already said

The model was already correct; only the write path was missing. No new tables were added.

- `content.artifact.source_system` already separates `object_store` — we hold the bytes — from
  `git`, `cad_pdm`, `document_system`, `accounting` and `external`, with the comment that
  anything else "means we hold a reference and the digest, and the other system can change
  underneath us — which is precisely why the digest is recorded".
- `content.external_locator.authority` already distinguishes `authoritative`, `evidence`,
  `mirror` and `lookup`, because "a mirror must never be mistaken for the authoritative copy".
- And the constraint that settles it:

```sql
artifact_version_locatable  CHECK (storage_uri IS NOT NULL OR revision_label IS NOT NULL)
```

A version must be **locatable**: either we can produce the bytes, or we can name the revision we
saw. So "document number + revision + digest" for anything we do not hold is enforced by
PostgreSQL, not by discipline. A reference that cannot say _which_ external thing its digest
describes is refused by the database.

## Decision

**A new action, not a widened one.** `register_external_artifact` records that bytes exist
somewhere we do not hold. `attach_evidence` is unchanged.

The name of an action is what an auditor reads. "We attached this evidence" and "we recorded
that this exists elsewhere" are different claims about what the organization possesses. One verb
for both leaves the audit log unable to answer whether we actually have something — which is the
first question asked when a rights holder or a regulator writes in. The action refuses
`source_system='object_store'` explicitly, naming `attach_evidence` as the correct verb.

**Mode and classification are stated per batch; neither is defaulted.**

```
kf ingest --mode=copy|reference --classification=<id> [--revision=<label>] <paths...>
```

A run that omits either is refused. A default mode is how third-party material enters because
somebody forgot a flag; a default classification either over-discloses the batch or hides it
from the person who needed it. The judgement belongs at batch level, which is where a human is
already deciding what this pile of files is.

Reference mode additionally requires `--revision`, mirroring the CHECK constraint so the refusal
names the reason rather than surfacing a constraint violation the operator has to decode.

**Reference-only paths refuse a copy run, and refuse the whole batch.** Material under `vendor`,
`vendors`, `supplier`, `suppliers`, `third-party`, `thirdparty`, `datasheets`, or any filename
containing `datasheet`, cannot be copied. The refusal names the file and the rule, and tells the
operator to re-run in reference mode.

Whole-batch on purpose: a partial ingest that copied nine files and rejected the tenth leaves
somebody deciding whether to re-run, and that decision is where the tenth file quietly gets
copied.

**`artifact_kind` is inferred from the extension and overridable.** Unlike mode, guessing here is
safe — being wrong about whether something is a `drawing` or a `specification` misfiles it, it
does not reproduce anybody's copyright.

## What this does not decide

- **The CLI surface.** `apps/api/src/ingest/plan.ts` is a pure planner with no database or
  filesystem access; the command that drives it is not yet written.
- **A watched folder.** Drop-a-file-in ingestion is wanted and is a thin layer over this, but it
  is deferred with the rest of the filesystem surface to `OW-WAR-0056`.
- **Whether the reference-only rule list belongs in the ontology.** It is currently a short,
  explicit list in code, deliberately readable by somebody deciding whether each entry is true.
  If it grows, it should move somewhere it can be reviewed as policy rather than as source.

## How this is held

`apps/api/src/ingest/plan.test.ts` asserts each refusal, and every guard was falsified — the
check removed, the test watched go red, the check restored.

That process found a test passing for the wrong reason: deleting the missing-mode check left all
tests green, because an absent mode fell through to the unknown-mode branch and both messages
contained `--mode`, which was all the assertion checked. Forgetting a flag and mistyping one need
different help, so the test now asserts the specific guidance and a second test proves the two
branches are distinguishable.

`tests/conformance/r01-golden.test.ts` requires the new action to be named in
`DECLARED_ADDITIONS` with its reason, so this growth is recorded rather than absorbed.
