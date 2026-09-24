# @kf/audit

A manifest only — this package holds no code. The audit chain is appended by
`packages/actions` (`appendAuditEvent`), its links are recomputed and refused by the database
(`core.enforce_audit_chain_head`), and checkpoints are signed by `apps/checkpoint`, whose key is
not reachable from the API process.

Each event records the format its link digest was computed under (`core.audit_event.link_format`:
`kf-audit-link-v1` for links recorded before `20260924001100`, `kf-audit-link-v2` since), and
every verifier recomputes the link under that format. The tags are described in
`packages/canonicalization/AUTHORITY.md`.

Authority: none of its own. Audit rows may not be updated or deleted through any role (§13); that
is enforced by triggers in `database/migrations`, not here.
