# @kf/audit

A manifest only — this package holds no code. The audit chain is appended by
`packages/actions` (`appendAuditEvent`), its links are recomputed and refused by the database
(`core.enforce_audit_chain_head`), and checkpoints are signed by `apps/checkpoint`, whose key is
not reachable from the API process.

Authority: none of its own. Audit rows may not be updated or deleted through any role (§13); that
is enforced by triggers in `database/migrations`, not here.
