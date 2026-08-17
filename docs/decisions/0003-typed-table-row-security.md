# Row-level security stops at `core.object`; 77 typed tables carry none

**Status:** accepted and complete — option 1. Both stages landed 2026-08-16, in
`20260816000300_typed_table_row_security.sql` and
`20260816000500_typed_table_row_security_stage_two.sql`. Readable tables with no policies:
**77 → 47 → 20**, and all 20 are excluded on purpose, listed with reasons below and asserted
as an exact set by `tests/database/typed-table-visibility.test.ts`
**Date raised:** 2026-08-16
**Date decided:** 2026-08-16
**Decision owner:** technical authority
**Scope:** read visibility of typed domain tables for roles that connect to PostgreSQL
directly (`kf_readonly`, `kf_auditor`) and for any application query that reads a typed table
without joining `core.object`
**Decision:** option 1, staged by domain. Stage one is `quality`, `engineering`, `org` and
`finance` — 29 tables, 95 policies. See "Decision and stage one" at the foot of this record.

---

## What was measured

`20260811000400_row_security.sql` enables and FORCES row-level security on `core.object`,
`core.relation` and `core.audit_event`, on two axes: the reader's organization, and a
classification ceiling that defaults to rank `-1` so an unset context sees nothing. That part
works. Measured as `kf_readonly` with no access context bound:

```
core.object visible: 0
```

Every other table is a different story. Across the live schema, **77 tables are readable by at
least one of `kf_app`, `kf_readonly`, `kf_auditor` and have `relrowsecurity = false`** — no
policies at all, so no policy can deny. In the same unbound `kf_readonly` session that saw
zero objects:

```
quality.controlled_document visible: 3
org.person visible: 1

document_number    | revision
-------------------+---------
OH-DOC-000002-1    | R01
OH-DOC-LST-SYS-001 | R4
OH-DOC-SPC-QMS-001 | R1
```

(`org.external_identity` returned zero rows because it is empty, not because anything stopped
the read.)

The list spans every domain: `work.*` (work orders, packages, acceptance records, amendments),
`quality.*` (controlled documents, nonconformities, CAPAs, complaints, suppliers, training
records, calibration), `engineering.*` (risk controls, test definitions and executions,
verification links, decision alternatives), `product.*` (configuration items, interface
contracts, physical bindings, baselines, releases), `org.*` (persons, engagements, role
assignments, external identities), `finance.*` (invoices, lines, payments, allocations —
these are closed to `kf_readonly` but open to `kf_auditor` and `kf_app`), `ops.*` (backup runs
and copies, restore drills, recovery objectives) and `core.*` (`action`, `approval`,
`snapshot`, `outbox`, `retention_hold`, `audit_checkpoint`).

## Why this is a gap and not obviously a design

The envelope carries identity — title, enterprise id, organization, classification — and the
typed row carries the substance: a nonconformity's `description` and `containment`, a CAPA's
`root_cause`, a work order's `scope_summary`, a test execution's `result_summary` and
`invalidated_because`, a person's record. A reader who cannot see the envelope can still read
the substance, and does not need to guess an id to do it — an unqualified `select` returns
everything.

The application path is largely protected in practice, because application queries join
`core.object` and inherit its policies through the join. That is a property of how the queries
happen to be written, not a property the database enforces: a future query that reads a typed
table alone has no boundary, and nothing fails when someone writes one.

The direct-connection roles have no such protection even in practice. `kf_readonly` and
`kf_auditor` exist to connect and read; there is no query-time enforcement on that path at all.

This is the identical shape of the defect closed in `20260816000100_search_visibility_boundary.sql`
for `search.document` — a table whose visibility rule lived only in one query, reachable by
roles that never run that query. The difference is scale: that was one derived table, this is
77 authoritative ones.

Note that `core.set_access_context` is executable by `kf_readonly` and `kf_auditor`, so those
roles can bind any organization id they like. That is the fabric's existing model — the
direct-connection roles are trusted to bind truthfully, and only the application derives a
context from a verified identity — and it bounds how much any policy can achieve for them.
It does not make the current state equivalent: today they need bind nothing at all.

## Options

1. **Enable RLS on every typed table**, with a policy that derives visibility from the owning
   `core.object` row — `exists (select 1 from core.object o where o.id = <table>.id)`, the
   pattern the `secure_object` schema already uses for its leaf tables. Deny-by-default then
   holds fabric-wide, and the migration's own stated principle — "a table someone forgets to
   write a policy for leaks nothing, rather than everything" — becomes true of the tables that
   hold the records. Cost: 77 policies, a performance review of the added subquery on read
   paths, and a decision per table on whether `kf_backup` needs a `using (true)` select policy
   the way the `secure_object` tables do.

2. **Withdraw direct `select` from `kf_readonly` and `kf_auditor`** on typed tables, leaving
   them the API. Smaller change, but it removes the reason those roles exist, and it leaves
   the application path still unenforced by the database.

3. **Accept and document.** If the intent is that typed tables are reachable only through
   `core.object` joins and that the direct-connection roles are fully trusted operators, then
   that is a legitimate position — but it needs to be written down where a reviewer will find
   it, and it needs a test that fails when an application query reads a typed table without
   the join, or the property decays silently.

## Recommendation

Option 1, staged: start with the domains whose typed rows carry the most substance
(`quality`, `engineering`, `org`, `finance`), measure the read-path cost, then complete the
sweep. Option 3 is defensible only with the test, and the test is most of the work of option 1.

Whichever is chosen, the choice belongs to the technical authority: this is the fabric's access
architecture, not a local defect, and it predates the document-compiler and secure-object work.

## Decision and stage one

Option 1, staged. Stage one landed in `20260816000300_typed_table_row_security.sql`: 29 tables
across `quality`, `engineering`, `org` and `finance`, 95 policies, taking the count of readable
tables with no row-level security from **77 to 47**.

The predicate is `exists (select 1 from core.object …)` rather than a copy of the two axes, so
the organization and classification rules are inherited from the envelope rather than restated
in 29 places that could drift. Child tables (invoice lines, payment allocations, training
records, join tables) are visible when EVERY parent is — the rule `core.relation` already
applies to its two endpoints, because otherwise a join table leaks the existence of records the
reader may not see.

Enabled, **not forced**, unlike `core.object`. The owner is a maintenance path here:
`search.index_object` and `search.text_for` are SECURITY DEFINER and read every one of these
tables to assemble a record's searchable text, and an indexer restricted to rows it can itself
see would build the subset index that `text_for`'s own comment rejects. Each table also carries
the `to kf_backup using (true)` select policy the secure-object ledger uses, because every one
of them already grants kf_backup SELECT and a policy-less grant would return nothing — a backup
that looks complete and is not.

### Read-path cost

The planner turns the envelope-keyed policy into a **hashed subplan**: one scan of `core.object`,
hashed, then a hash probe per row — not a correlated subquery per row. Child policies keep one
hashed side and one correlated `EXISTS` against a primary key. Full-suite wall clock moved from
49.9s to 51.4s, which is inside the run-to-run spread.

That is a plan-shape observation, not a throughput measurement: these tables hold single-digit
row counts in every environment available here. The plan shape is the part that predicts
whether it scales, and it is the right thing to have measured — but **the cost question still
deserves a populated database**, and stage two proceeded without one on the grounds that
waiting for data which does not exist would have deferred the coverage indefinitely. That was
a deliberate trade, recorded here rather than buried.

### Two things stage one deliberately did not do

**`org.external_identity` is excluded.** It maps issuer+subject to a person and is read by
`resolveIn` BEFORE the caller's organization claim has been verified — `resolveCaller` binds the
access context FROM the claim and then proves it. Scoping the table by that context answers an
authentication question with a scope answer: a valid token naming the wrong organization stopped
reporting `role_not_held` and started reporting `unknown_subject`, and a person whose own record
sits above the classification ceiling they requested could not sign in at all. Both were observed
when it was included, and both are worse than the exposure they close. It needs a scope that does
not come from the caller's own claim, or a narrower grant. **Resolved later the same day by the
narrower grant — see "`org.external_identity`, closed differently" below. No longer open.**

**`org.role`, `quality.federated_source` and `registry.*` are excluded on purpose.** They carry no
organization anchor — they are vocabulary. `registry.*` additionally cannot take a policy at all:
`core.object`'s own policies read `registry.classification` to rank a row, and a policy that
depends on a table whose policy depends on it is not a boundary.

### Stage two — landed 2026-08-16

`20260816000500_typed_table_row_security_stage_two.sql`: 28 tables across `core`, `content`,
`product` and `work`, 68 policies, taking the count from 47 to 20.

`core.action` was the point of it. It carries `parameters` — the exact typed payload of every
action ever performed — which is where a record's substance lives before, and often instead
of, reaching a typed row. A nonconformity's description is in `quality.nonconformity` because
an action put it there, and that action still holds it. Protecting the typed tables while
leaving the actions that wrote them open would have been a boundary around the copy and not
the original.

It is scoped by its own `organization_id` rather than through an envelope, because it has one
and because an action targets an ARRAY of objects: deriving a classification ceiling from
`target_ids` would mean electing one target's ceiling to stand for all of them, which the
schema does not support and a migration should not invent.

**One judgement to overturn if you disagree.** `core.action` and `core.approval` follow the
precedent `20260811000400` set for `core.audit_event` and give kf_auditor an unconditional
read; nothing else does. An auditor who can read every audit event but only one
organization's actions has a trail that stops mid-sentence. `core.snapshot` holds copied
record content and stays scoped.

The cost question this record raised before stage two was not answerable then and is not now:
these tables still hold single-digit row counts in every environment available here. What is
known is the plan shape — a hashed subplan, not a per-row correlated subquery — and that the
full suite moved from 49.9s to 50.7s across both stages, inside the run-to-run spread. **A
populated database would still be the right place to measure throughput.**

### The 20 that remain, and why

`registry.*` (10) is vocabulary, and `core.object`'s own policies read
`registry.classification` to rank a row — a policy there would be a cycle. `ops.*` (6) are
deployment facts about the whole cluster; asking which organization owns a backup of
everything has no answer, and the `approved_by`/`declared_by` columns are attribution, not
ownership. `core.audit_checkpoint` is the global integrity spine. `org.role` and
`quality.federated_source` carry no organization anchor. `org.external_identity` is closed by
withdrawing the grant instead — see below.

### `org.external_identity`, closed differently — 2026-08-16

Still not by a policy, for the reason stage one gave: it is read before the caller's
organization claim has been verified, so scoping it by that claim answers an authentication
question with a scope answer.

`20260816000600_external_identity_reader_grant.sql` withdraws `select` from kf_readonly and
kf_auditor, which touches the authentication path not at all because that path runs as
kf_app. kf_app and kf_worker resolve identities; kf_backup keeps it, because a backup missing
the identity links restores a fabric nobody can sign in to. This record's earlier note that
the question was open is superseded.

### The cost question, answered — 2026-08-17

This record said twice that the cost "deserves a populated database" and shipped both stages
without one. `tests/database/rls-read-cost.test.ts` is that database: 36,007 objects and
36,000 actions across three organizations, read as **kf_readonly** with the access context
bound — the direct-connection path this record is about, not the application path — median of
seven runs. It is not a gate and does not run in CI; `KF_MEASURE_RLS=1` runs it.

The answer was not the one expected, in two ways.

**The typed-table policies are not where the cost is.** The three shapes measured very
differently, and the ordering is the reverse of what the predicate complexity suggests:

| shape                                          | policy | the join it replaces |
| ---------------------------------------------- | ------ | -------------------- |
| envelope-keyed (`quality.controlled_document`) | 514 ms | 445 ms               |
| child chain (`quality.training_requirement`)   | 616 ms | 546 ms               |
| direct column (`core.action`)                  | 12 ms  | 13 ms                |

`core.action` — the one whose scoping column carries **no index**, which was the suspicion
that prompted the measurement — is 40× faster than the envelope-keyed shape that joins to an
indexed primary key. The missing index is real and is still not worth adding: a sequential
scan of 36,000 rows costs 12 ms, and nothing in the plan degrades non-linearly. Revisit it
when the ledger is large enough for that scan to matter, and add it then with a measurement
rather than now with an intuition.

**The cost is in `core.object`'s own policies, and most of it was avoidable.** Adding one
term at a time to a hand-written copy of the predicate:

```
core.object · scan, no predicate                        0.8 ms   36007 rows
core.object · organization term only                    0.8 ms   12005 rows
core.object · organization + classification rank       98.2 ms   12005 rows
core.object · full policy predicate, hand-written     461.1 ms   12005 rows
core.object · same predicate, OR branches hoisted       93.8 ms   12005 rows
```

The organization term is free — `object_by_org` covers it. The classification rank costs
~97 ms and is honestly per-row: it depends on the row's own classification. The remaining
~363 ms was two predicates that depend on **nothing about the row** —
`content.document_basis_classifier_active()` and `content.compiler_runtime_active()`, which
ask whether a runtime is active. Both are separate PERMISSIVE policies, so PostgreSQL ORs
them with the scoped policy and every row failing the organization test goes on to call both.

Both are declared STABLE, which is easy to read as "evaluated once" and is not: STABLE
promises only that the answer will not change within a statement. In a per-row filter the
function is still called per row.

`20260817000100_hoist_row_independent_policy_predicates.sql` wraps all 30 such policies in
`(select …)`, which lets the planner lift them into an InitPlan evaluated once per statement.
Same truth value, same rows — the harness asserts the row counts match before it reports
either duration, and the full suite passes unchanged, which is what makes this a plan change
rather than a policy change. Re-measured with it installed:

| shape                         | before | after      |
| ----------------------------- | ------ | ---------- |
| `controlled_document` policy  | 514 ms | **190 ms** |
| `controlled_document` join    | 445 ms | **114 ms** |
| `training_requirement` policy | 616 ms | **272 ms** |
| `training_requirement` join   | 546 ms | **210 ms** |
| `core.action` policy          | 12 ms  | 12 ms      |

`core.action` is unchanged, correctly: its policy has no such branch. The gain lands on every
read of every object in the fabric, including the application's join path, because the
predicate being fixed belongs to `core.object` rather than to anything stage one or two added.

`tests/database/policy-predicate-shape.test.ts` pins the property against the INSTALLED
policies rather than the migration text, and refuses to pass vacuously: it requires the 30 to
be present in the hoisted form, so a renamed function or an unapplied migration fails rather
than reporting a clean sweep of an empty set.

**What is left, with its size.** The classification-rank term is now the largest remaining
cost — roughly 99 ms of the ~190 ms envelope-keyed read — and it is a correlated subquery
into `registry.classification` executed once per row (12,005 index searches for 12,005 rows).
`registry.classification` is a handful of rows, so a form the planner could hash once would
remove most of it. That is a change to the security predicate itself rather than to how often
it runs, so it wants its own decision and its own measurement, and it is not made here.
