# A master record's identity is its corpus, and sections are a reading of it

**Status:** accepted — implemented 2026-09-01; amends ADR 0011's identity key
**Date raised:** 2026-08-28
**Date decided:** 2026-09-01
**Decision owner:** technical authority
**Scope:** what makes two master-record compilations the same claim; where `your_record` /
`org_view` live; what "stale" means on the read surface

## The problem, measured

ADR 0011 keyed a master record uniquely by `(person, organization, permission_digest)` and said
in the same breath that `your_record` and `org_view` "are presentation partitions, never
membership filters." The runtime disagreed with the second sentence: it wrote those sections
into the manifest and into `master_record_item.section`, and the row-level-security insert policy
bound the two together.

On 2026-08-28 the first master record compiled through a real authenticated session returned 18
items — 17 `org_view`, 1 `your_record`. `core.relation` was empty, so that was arithmetically
correct. Adding one `performed_by` edge and recompiling then returned:

```
500 internal_error
duplicate key value violates unique constraint
  "master_record_person_id_organization_id_permission_digest_key"
```

The permission digest already hashed each member's `objectId`, `objectType` and
`contentDigest` (`packages/documents/src/master-record.ts`, `memberKey`) — so it was a corpus
digest under the wrong name, and it did not move when only sectioning moved. The second
compilation therefore collided on a key that was never meant to include what had changed. Worse,
`GET /master-record` computed staleness from that same digest and went on answering
`stale: false` over sectioning the graph no longer supported.

Every existing test compiled for a different person, or once per person. Nothing recompiled the
same person after a change that left permissions untouched, which is how this survived 1396
passing tests. `tests/database/master-record-recompilation.test.ts` was written first to pin the
defect, then rewritten to assert the behaviour below.

## Decision

**Identity is the corpus.** `corpus_digest` is a line-canonical SHA-256 over the sorted set of
`(object_id, object_type, content_digest, classification, item_state)` across the included and
withdrawn members. It excludes sections, relevance, and `compiled_at`. The table is
`unique (person_id, organization_id, corpus_digest)`, and compiling an unchanged corpus **returns
the existing record** rather than inserting — never a second row, never the 500. A changed
corpus — content drift, a member gained or lost, a classification moved, a withdrawal — is a new
claim with a new digest.

**Access is a separate fact.** `permission_digest` is redefined as a hash over the object ids
and the effective ceiling. It is not identity; it exists so a corpus change can be read as "your
access changed" versus "the content drifted" — the first of the pundit's three invalidation
dimensions, kept distinct from the second.

**Sections are derived, never stored.** The manifest carries no `sections`; the item table has
no `section` column. `sectionMasterRecord(manifest, closure)` produces `your_record` /
`org_view` from whatever relation graph the reader enumerates _now_, and `GET /master-record`
derives them on every read. So a new edge is visible immediately, against the same claim,
without recompiling — which is what "presentation partition" always meant.

**The database checks the identity it stores.** `content.master_record_corpus_digest(manifest)`
and `content.master_record_permission_digest(manifest, ceiling)` recompute both digests in SQL,
and CHECK constraints require the stored columns to equal them. The digests are line-canonical
(unit separator between fields, newline between lines, `"C"` collation) rather than RFC 8785
precisely so PostgreSQL can do this; the TypeScript side sorts in code-unit order, which is the
same order for the ASCII identifiers these carry. A row whose digest disagrees with its own
manifest cannot exist.

**Stale means the corpus moved.** The read surface compares the stored `corpus_digest` against a
fresh enumeration and refuses with `409 master_record_stale` when they differ. A sectioning
change is not staleness.

## Two edges named, not hidden

- **One corpus, two ceilings.** The ceiling is excluded from identity on purpose, so an identical
  corpus can be compiled under two ceilings when every member sits at or below the lower one.
  Reusing the row would return a claim whose recorded `permission_digest` belongs to the other
  request. The repository refuses that case by name rather than reusing silently. If it ever
  occurs in practice, the decision to revisit is whether the ceiling belongs in identity after
  all.
- **The CHECK recomputes a digest on every write.** `master_record_corpus_digest(manifest)` runs
  once per insert over `jsonb_array_elements` of the manifest. Dogfood manifests hold tens of
  members; a manifest of thousands is milliseconds, not seconds. If a corpus ever grows to the
  point that this shows up in a profile, the constraint should move to a trigger that verifies
  once and stores, not be dropped.

## What this does not decide

- **The projection engine.** Sections are the first projection; the general grammar, its
  definitions and its own digest are the next step, not this one.
- **Whether `compiled_at` should ever be identity.** It is not. A records model that wants every
  compilation as a dated claim regardless of content would drop the unique key entirely; this
  decision keeps one claim per corpus and records each compilation as an action.

## How this is held

`tests/database/master-record-recompilation.test.ts` proves, against a real database: an unchanged
corpus compiles to the same row; a relevance-only edge changes the derived sections and not the
record; a content change produces a new record with the same permission digest; and a stored
digest that disagrees with its manifest is refused by the CHECK. `packages/documents/src/
master-record.test.ts` proves the digests are order-independent, sensitive to every identity
field, and indifferent to relevance.

The migration is forward-only. Reverting would restore a key under which a relevance-only change
cannot be recompiled, and re-add a column ADR 0011 already said was not membership.
