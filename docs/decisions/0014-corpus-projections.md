# Every reading of a master record is a declared projection over its corpus

**Status:** accepted — implemented 2026-09-02; builds on ADR 0013
**Date raised:** 2026-09-01
**Date decided:** 2026-09-01
**Decision owner:** technical authority
**Scope:** how sections, pages, exports and agent context are derived from a master record;
where those derivations are defined and versioned; what they may and may not express

## The problem, measured

After ADR 0013 the master record was an exact corpus and its `your_record` / `org_view`
sectioning was derived at read time — by one function in `@kf/documents`, hand-coded. The web
app's `projects`, `documents`, `ml` and `search` pages were four more hand-coded readings, each
fetching and filtering on its own. `renderMasterRecord` fanned one manifest into Markdown,
HTML, PDF and DOCX; nothing else could be rendered that way. And there was no answer to "what
did the agent see" beyond whatever retrieval happened to return.

Every one of those is a reading of the same corpus. Each was a separate implementation of
"which members, in what order, under what headings", with its own chance to disagree about
authorization. The pundit's diagnosis held: `/master#projects` and `/projects` would drift,
and a new object type could disappear from every page simply because no page knew it.

## Decision

**A projection is a declared, versioned reading over a corpus.** It can partition and order
what the corpus already contains; it cannot add to it. `ontology/projections.yaml` is a section
of the ontology: loaded, checked and emitted like object and relation types, versioned with
the schema pack, and rejected by the loader if it is absent — a definition nobody compiles is
not in force.

**The grammar is a closed algebra over declared things.** An anchor (the person the corpus was
compiled for); a traversal over named relation types — or every relation declaring
`person_anchor` — with a depth ceiling, following each type's `propagation_class`; ordered
sections whose `select` is `reached`, `unreached`, `withdrawn` or `all`, optionally narrowed by
a filter on object types, lifecycle states, a classification ceiling, or item state; a
**mandatory remainder** that takes whatever no section claimed; sort keys drawn from envelope
fields; typed parameters bound at read time; and a member budget the engine refuses to exceed
rather than silently truncate. No expressions. No SQL. Anything the grammar cannot say is a
reason to add a primitive here, reviewed, rather than a query somewhere unreviewed.

The compiler checks each definition against the ontology (ONT-013 through ONT-016): an
unknown relation type would silently reach nothing; a filter on a misspelled state would
silently be empty.

**One engine, one Result.** `project(definition, parameters, corpus, graph)` in
`@kf/projections` is pure and deterministic. Its Result is canonical JSON: definition and
version, bound parameters, the source corpus digest, ordered sections of members, measurements,
and a `projectionDigest` over exactly which member sits in which section. Two invariants hold by
construction and are asserted anyway — every emitted member came from the corpus, and every
member the definition admits landed in exactly one section. A definition-level `filter` is the
one declared narrowing; what it excludes is counted in `measurements.excludedByFilter`, so a
Result can never look complete while quietly omitting members. `render(result, target)` produces Markdown, HTML
or the JSON itself from that one Result, same digest on every target.

**The API serves Results.** `GET /master-record/projections/:definitionId` evaluates a
pack-shipped definition under the same corpus-staleness rule as `GET /master-record`, and
`GET /master-record` itself now takes its section labels from the `master_sections`
evaluation. Relevance traversal moved into `@kf/projections`; `@kf/documents` re-exports it.

**Agent context is a definition family, not a format.** `agent_context` takes a
`token_budget` parameter and produces a Result with exact source ids and digests. A model may
summarize it; nothing lets it enlarge it, and the digest records what it was given.

**Custom projections are controlled records over the same grammar** — decided, not yet built.
Pack-shipped definitions are policy and change with a pack release; an organization's own
readings will be database records referencing the grammar the pack declares, so they are
auditable objects rather than code.

## What this does not decide

- **Object Views.** A per-object reading (anchor = object, depth 1, backlinks in both
  directions) is the next step; the grammar's `anchor` admits only `person` today, on purpose.
- **PDF and DOCX for arbitrary projections.** Those still run through the master-record
  renderer's pinned pandoc path; generalizing that is small and waits for a second consumer.
- **The projection digest's treatment of the relation graph.** It commits to the _outcome_
  (which member landed where), not to the edges traversed. Two graphs that section identically
  yield one digest, which is the right identity for a reading; an audit that wants the edges
  should record the graph separately.
- **Budgets beyond member count.** Depth is bounded per definition and per relation policy;
  wall-clock and row budgets on the enumeration itself belong with query governance.

## How this is held

`packages/projections/src/engine.test.ts` proves determinism (same input, same digest, any
member order), coverage (unclaimed members reach the remainder), ⊆-master (a foreign member is
refused), the budget refusal, and that an explicit relation list is a whitelist.
`tests/database/master-record-projections.test.ts` drives the real routes against a real
database: the Result is ⊆ the stored master, markdown and html carry the same projection
digest as the JSON, parameters are refused by name, and `GET /master-record`'s labels match the
engine's evaluation. `tests/ontology/planted-violations.test.ts` plants each new ONT rule. Every
guard was falsified before it was trusted.
