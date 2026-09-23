# ADR 0033 — The database binds the principal; the application only names one

- **Status:** proposed 2026-09-23
- **Amends:** [ADR 0015](0015-object-views.md) in one respect: reading an Object View no longer
  compiles a stale master record. `GET /objects/:id` answers `409 master_record_stale`, and
  `POST /objects/:id/refresh` performs the compile as an explicit act.

## Context

Every guard, policy and trigger reads who is acting, where, and at what ceiling from `kf.*`
settings. A red-team pass executed as `kf_app` on 2026-09-23 showed those settings were the
application's to write: any tenant could be bound at `restricted` with nobody behind it, the
actor could be a uuid that was nobody, and the ledger, the audit chain, role assignments,
identity links and verifications all accepted rows no act had made. Row-level security held
against a buggy API and not against a hostile one, although threat model T2 says to assume the
API is fully controlled.

## Decision

1. **The context is sealed.** Each `kf.*` setting carries an HMAC under a key no writing role can
   read, bound to the backend and the transaction's start. An unsealed value reads as unset.
   No function but the seal's own reads or writes a `kf.*` setting (asserted by the migration and
   by `tests/database/principal-binding.test.ts`).
2. **The application binds a principal, not an organization.** `core.bind_principal` takes a
   person, their assignment, the organization and a requested ceiling; it checks the assignment
   is live and clamps the ceiling to the person's clearance. After that the application may only narrow; the actor must be the
   principal under that assignment. `public` alone may be bound with no principal.
3. **Writes match the context.** Action rows, audit digests (recomputed by the database), role
   and clearance end-dating, identity links, verifications and definer lookups are all checked
   against the sealed principal.
4. **Authority is minted only by the owner credential.** The application role has no INSERT on
   people, role assignments or identity links; nobody grants themselves clearance.
5. **Reading has no side effects** (the ADR 0015 amendment): a GET that performed an audited
   compile could be triggered by a cross-site link carrying the viewer's cookie.

## Consequences

- A compromised API is bounded to impersonating real people **with their real authority**. It
  cannot invent an actor, a tenant or a ceiling. The database still cannot tell whether the
  person is present; that needs it to verify the token itself (threat model open item 6).
- Service logins (worker, readiness, backup) keep their credential as their authority, and the
  worker's actor must still hold the assignment it names.
- The seal key's row is excluded from backups: seals last one transaction, so a restore needs a
  key, not this one.
- One click to refresh a stale Object View, where there were none.
- Which acts a role may perform is still decided in the application; recorded in T2.
