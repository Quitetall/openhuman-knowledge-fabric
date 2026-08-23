# 0007 — A recursive policy predicate belongs in a function, not inline

- **Status:** accepted; implemented 2026-08-22
- **Date:** 2026-08-22
- **Decision owner:** OpenHuman Technologies LLC

## Context

`content.composition_input`'s row-level security policy cost about **950 milliseconds to count
three rows**. Measured twice, on two independent databases — the Testcontainers harness (958 ms)
and the development database as a non-superuser (930 ms) — so it is a property of the schema and
not of any one test.

The predicate is `exists(composition_revision)` and then a `CASE input_role` over six branches,
each an `exists` against a _different_ RLS-protected table. Every one of those tables carries four
permissive policies of its own, and its `_scope` policy references further protected tables:
`composition_input → composition_revision → document_composition → core.object`, and five more
chains beside. PostgreSQL inlines all of it into the calling query.

Depth alone was not the problem. The planner de-correlates each `exists` and rewrites it as a
**hashed** subplan — `ANY (id = (hashed SubPlan 22).col1)` — which materialises the _entire visible
set_ of each referenced table, recursively, before a single row can be filtered. That is why the
price was fixed rather than per-row, and why more rows would never have amortised it.

Two consequences were already being paid. Any query touching the table paid the fixed second. And
because the expansion is planned in one tree, combining several such reads into a single statement
was **superlinear** — four `count(*)` that cost about a second apart cost 11.8 s together, which is
what made a CI test fail against a 30 s server-side statement budget (task #156).

## Decision

**Move the predicate, unchanged, into a PL/pgSQL function and have the policy call it.**

A PL/pgSQL body is opaque to the caller's planner. Each statement inside is planned separately and
plan-cached, and the referent lookups become single-row index probes against a passed parameter
instead of whole-table visible-set materialisations.

Three properties of the function are load-bearing, and each is stated in the migration because
each is a way this could have gone wrong:

- **`SECURITY INVOKER`** (the default). The body's queries run with the _caller's_ rights, so every
  referenced table enforces its own RLS exactly as before. This is what makes the change one of
  plan shape rather than of who can see what. `SECURITY DEFINER` would bypass RLS inside the body
  and force the visibility rules to be re-implemented by hand — the version of this change that can
  silently leak.
- **Not `STRICT`.** A row sets exactly one of the five referent columns and leaves four NULL, so
  `returns null on null input` would return NULL for every row in the table, which RLS reads as
  false. It would deny everything, on every path, while looking like a tidy annotation.
- **Parallel-unsafe**, by omission. Read-only bodies are normally parallel safe, but this table is
  far too small for any test to produce a parallel plan, so marking it safe would be an assertion
  nothing in the suite could falsify.

## The part that was nearly missed

The obvious way to prove "same rows" is to compare what each access context can see before and
after. That test was written, it passed, and **it could not fail**.

A defect planted in the function — `return true` immediately after the parent check, discarding the
entire `CASE` — passed it, along with both of its controls. The reason is a domain invariant:
`add_document_composition` enforces `KF-DOC-CLASS-002`, _"composition classification must be at
least its highest visible input"_, and `content.authored_fragment_revision` is append-only. A
referent can therefore neither be created above its composition nor reclassified above it
afterwards. Every referent is at least as visible as its parent, so the leading
`exists(composition_revision)` decides the outcome by itself and the six branches never change a
visible row. There is no fixture, reachable or contrived, that makes them observable through the
policy.

So the branches are checked against a different oracle: the original predicate, **lifted verbatim
out of the bytes of the migration that created it** (`20260814000100_document_compiler.sql`) rather
than retyped, and evaluated side by side with the function over argument tuples that include
referents which do not exist. Both run as the application role with an access context set, so RLS
applies inside both. `tests/database/composition-input-visibility-equivalence.test.ts` holds both
checks; the extraction guards itself, because an extractor that grabbed the wrong span would
compare the function against nonsense and pass.

Both checks were confirmed able to fail, by planting two defects and requiring detection: the
`return true` above, and a dropped `composition` branch.

## Consequences

- Same query, same three rows, same database, minutes apart: planning 27.3 ms → 0.15 ms, execution
  799 ms → 3.5 ms.
- `tests/end-to-end/document-dogfood.test.ts` went from 5.0–7.7 s to 0.47 s, which shows the tax
  was never only on the counts — every query the test made against the table was paying it.
- The equivalence test is now the thing to keep. If the predicate changes again, it must change in
  the migration the test lifts its reference from, or the test will say so.
- A census of all 367 policies found only four with three or more `EXISTS` clauses. The other three
  are `ml.promotion_receipt`, `ml.run_lineage` and `ml.registry_registration`.

### Measured 2026-08-23, and both things this section previously said were wrong

They were called "predicted cheap; not measured", and a measurement against an empty table was
called worthless. Neither survived contact.

`select count(*)` per table, empty, as the application role with an access context bound:

| table                      | jit on    | jit off | ratio |
| -------------------------- | --------- | ------- | ----- |
| `ml.registry_registration` | 4591.6 ms | 2.84 ms | 1617x |
| `ml.run_lineage`           | 82.8 ms   | 0.35 ms | 235x  |
| `ml.promotion_receipt`     | 2.2 ms    | 1.4 ms  | —     |

**"An empty table reports it healthy" was exactly backwards.** `ml.registry_registration` with ZERO
rows took four and a half seconds. The mechanism half of that claim was right — every subplan in the
plan reads `never executed`, and the sequential scan finishes in 0.03 ms — but the conclusion drawn
from it was not, because it accounted for only one of the two costs:

- the **hashed subplans** cost scales with ROWS, and does build lazily, so an empty table hides it;
- the **JIT compilation** cost scales with PLAN SIZE, which is data-independent, so an empty table
  shows it in full. `registry_registration` expands to 33 distinct subplans, and compiling that is
  where the 4.5 s went.

Conflating the two produced a rule that would have told the next person to skip the measurement
that mattered most.

**The policies themselves are fine.** At 0.35–2.84 ms with JIT off, none of the three needs the
treatment `composition_input` got — that one is 950 ms of genuine per-query execution, a different
defect. What these three needed was `jit = off`, which `deploy/postgres/planner.conf`,
`docker-compose.yml` and the test harness now all set. Their contribution beyond that is planning
time: 8–16 ms for `registry_registration` against 0.4 ms for a plain table, paid per query and worth
knowing about, but not worth a rewrite.

The wider lesson for the JIT decision: 1617x on a real table is far outside the 8–14x measured on
the `controlled_document` and `training_requirement` shapes, so that commit understated its own
result.
