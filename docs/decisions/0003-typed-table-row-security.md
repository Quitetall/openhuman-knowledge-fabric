# Row-level security stops at `core.object`; 77 typed tables carry none

**Status:** accepted — option 1, staged. Stage one landed 2026-08-16 in
`20260816000300_typed_table_row_security.sql`
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
row counts in every environment available here. **Before stage two, the cost question deserves a
populated database.** The plan shape is the part that predicts whether it scales, and it is the
right one.

### Two things stage one deliberately did not do

**`org.external_identity` is excluded.** It maps issuer+subject to a person and is read by
`resolveIn` BEFORE the caller's organization claim has been verified — `resolveCaller` binds the
access context FROM the claim and then proves it. Scoping the table by that context answers an
authentication question with a scope answer: a valid token naming the wrong organization stopped
reporting `role_not_held` and started reporting `unknown_subject`, and a person whose own record
sits above the classification ceiling they requested could not sign in at all. Both were observed
when it was included, and both are worse than the exposure they close. It needs a scope that does
not come from the caller's own claim, or a narrower grant. Open.

**`org.role`, `quality.federated_source` and `registry.*` are excluded on purpose.** They carry no
organization anchor — they are vocabulary. `registry.*` additionally cannot take a policy at all:
`core.object`'s own policies read `registry.classification` to rank a row, and a policy that
depends on a table whose policy depends on it is not a boundary.

### Stage two

`core.action`, `core.approval`, `core.snapshot`, `core.outbox`, `ops.*`, `product.*`, `work.*`,
`content.*` — 47 tables. `core.action` is the interesting one: it carries every action's
parameters, which is where substance ends up for anything that has not reached a typed row yet.
