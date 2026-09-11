# ADR 0026 — Definer functions resolve under a bound context, and the test harness owns the schema as an ordinary role

- **Status:** accepted, 2026-09-11
- **Extends:** ADR 0003 (the database is the authority), ADR 0011 (organization-scoped
  authority), ADR 0025.

## Context

The first real login on the dogfood host was refused: `401 role_not_held`. Every
database test that exercised identity had passed, and the identity walk recorded in
`docs/deployment/identity-and-login.md` had reached a domain answer on a workstation database.

The cause is a property of PostgreSQL that the tests had been arranged never to meet. Two
resolver functions, `org.resolve_identity_role` and `org.resolve_effective_classification`, are
`SECURITY DEFINER` and read `core.object` and `org.person_clearance` — tables that **force**
row-level security. Forced policies bind the table owner and therefore bind a definer function
owned by that role. They do not bind a superuser. The test harness applied migrations as the
container's bootstrap superuser, so every definer function was owned by a superuser and read
past every policy; on the host the owner is the migrator login, an ordinary role, so the same
function saw nothing until an organization was bound — and both resolvers were called
_before_ any context was bound, because binding the context was what they existed to decide.

So: on the host, no person could be identified, and had identity passed, no action could
have been dispatched. In the tests, neither failure was reachable.

## Decision

**Resolution binds a provisional context.** `resolveIn` (identity) and
`setResolvedAccessContext` (classification) bind the requested organization at the widest
ceiling before calling their resolver, and the derived ceiling replaces it before the caller's
transaction touches a record. The resolvers return who the caller is and what ceiling they
hold; neither returns record content, so the provisional ceiling exposes nothing. The
requested ceiling cannot serve as the provisional one: a caller asking to work at `public`
must still have their `internal` assignment envelope seen.

**Amended the same day: the schema owner must bypass row-level security.** Running the whole
suite under an ordinary owner failed 49 tests in 12 files, and every one was a definer seam
built to read past forced policies — outbox delivery, search indexing, readiness, ML signing
keys, compiler pins, the action-target trigger. On the dogfood host the same seams were all
broken: zero rows in the search index, every outbox row undelivered. The seams are the design;
what was wrong was the host. The migrator login is granted `BYPASSRLS` (it is still not a
superuser), `readiness` carries `schema_owner_bypasses_rls` and refuses a host without it, and
the harness owns the schema exactly that way by default. The provisional binds above stay as
defence in depth. The paragraph below describes the intermediate state and is kept as a record.

**The harness can own the schema as an ordinary role.** With `realisticOwner: true`,
`tests/database/harness.ts` moves every schema, table, view, function and type in the fabric's
own schemas to `kf_harness_owner` — `nologin nosuperuser nobypassrls` — after migrating, so a
definer function in a test is bound by exactly the policies that bind it on a host.
`adminPool` remains the superuser for fixture writes. The identity, access-grant and lifecycle
suites run this way. With the fix removed, 14 identity tests and 8 access-grant and lifecycle
tests fail; with it, all pass. Before this change, the same removal changed nothing.

It is opt-in, and that is a recorded gap, not a preference. Turning it on for every suite
failed 50 tests across 13 files: `core.action` target checks, ML-registry signing, compiler
pins, export round-trips. Each is either a host-shaped defect of this same class or a fixture
that leans on the superuser, and each needs its own reading. Suites move over one at a time,
and a suite that has not moved is a suite whose row-level behaviour is not yet evidence.

## Consequences

- A `SECURITY DEFINER` function in this schema is not a way past row-level security on a
  forced table. It never was on a host; now it is not in a test either. Any function that
  needs to see across organizations must do so by design — `org.organization_retirement` is
  the shape: a non-forced table, a minimal answer.
- Three suites run under the ordinary owner and are the evidence for this ADR. The other
  database suites still run under the superuser and are listed as the gap above; the full
  suite stays green only because of that, and says so here rather than pretending otherwise.
- A host's bootstrap-tier commands run as the table owner. `org.person` and `org.organization`
  enable row-level security without forcing it, so the table owner reads across
  organizations and any other login does not; the fixture script and `kf retire-organization`
  are documented and run accordingly. The application login never holds that credential.
