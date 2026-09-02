# An Object View is a projection anchored at the object, over the reader's own corpus

**Status:** accepted — implemented 2026-09-02; builds on ADR 0014
**Date raised:** 2026-09-01
**Date decided:** 2026-09-02
**Decision owner:** technical authority
**Scope:** what a per-object page is, where its members come from, what it may show a reader,
and why every object type gets one without per-type code

## The problem, measured

Before this, one object type had a page: `apps/web/src/app/projects/[id]` — a hand-built
cockpit reading a hand-built `GET /projects/:id`. Thirty-seven other first-class object types
had no page at all. `GET /objects/:id/history` and `GET /objects/:id/available-actions` existed
for any object, but nothing composed them with the object itself or with what touches it.
Backlinks — "which ADRs affected this product" — were derivable from `core.relation`, indexed in
both directions, and shown nowhere.

## Decision

**An Object View is the `object_view` projection.** The grammar of ADR 0014 gains an object
anchor: `anchor: object` names the member the reader asks for through a required `object_id`
parameter, and `traverse: { relations: all, max_depth: 1 }` walks the **structural
neighbourhood** — every active relation, both directions, one hop. That is a different walk
from a person reading: relevance follows propagation classes; a neighbourhood asks only "what is
connected", and a backlink is exactly as much of an answer as a forward link. The definition's
`filter: { reachability: reached }` is its declared scope — the anchor and what touches it —
and what that scope excludes is counted in `excludedByFilter`, never silent.

**It is evaluated over the reader's own master record.** The corpus is the reader's authorized
set; an anchor outside it is refused, and the route reports that as _not found_ — a reader
learns nothing about whether a record exists for somebody else. So the page carries the same
⊆-corpus guarantee as every other reading, from the same engine, with the same digest
discipline. The crossed edges are part of the Result and of its digest: for a neighbourhood,
the edges are the outcome, so a new backlink is a new reading.

**History and available actions are facets, not members.** The audit chain and the state
machines are not corpus members and are not projected; `GET /objects/:id` attaches them beside
the Result using the same queries `/objects/:id/history` and `/objects/:id/available-actions`
already run. One engine for membership; existing reads for what is not membership.

**Every object type gets the page with no per-type code.** `apps/web/src/app/objects/[id]`
renders the Result generically — envelope, typed payload as rows, relationships with direction
and relation type, actions from this state, history. A type added to the ontology is browsable
the moment it has a member in someone's corpus. Per-type custom views are the DB-authored
projections ADR 0014 defers.

Two compiler checks hold the new grammar: ONT-017 requires an object-anchored definition to
declare the `object_id` uuid parameter and a traverse, and refuses `select: anchor` on a
person-anchored definition; ONT-013 refuses a reachability filter with nothing to reach.

## What this does not decide

- **Replacing the project cockpit.** `/projects/[id]` computes progress from accepted work
  packages (KF-PROJ-001), which is a derived property, not a projection; it stays until the
  derived-property layer exists. `/objects/<project id>` already works alongside it.
- **Prominent fields per type.** The page shows every typed field as a row. Choosing which
  fields lead belongs with object-type metadata, and waits for a real reader to want it.
- **Depth beyond one hop and impact analysis.** `max_depth` is a definition value; a
  two-hop or transitive reading is a different definition, not a parameter, so that its budget
  is reviewed.

## How this is held

`packages/projections/src/engine.test.ts` proves the neighbourhood keeps the anchor and both
directions and nothing further, counts the scoped-out remainder, refuses an anchor outside the
corpus, and changes digest on a new backlink. `tests/database/master-record-projections.test.ts`
drives `GET /objects/:id` against a real database: the anchor and its backlink appear, the
facets are present, the digest header matches, and an object outside the corpus is 404.
`tests/ontology/planted-violations.test.ts` plants ONT-017 both ways.
