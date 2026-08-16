# Row-level security stops at `core.object`; 77 typed tables carry none

**Status:** raised — requires technical-authority decision
**Date:** 2026-08-16
**Decision owner:** technical authority
**Scope:** read visibility of typed domain tables for roles that connect to PostgreSQL
directly (`kf_readonly`, `kf_auditor`) and for any application query that reads a typed table
without joining `core.object`
**Does not:** change any behaviour. This record raises a measured gap and states the options;
it decides nothing.

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
