# LAMU source-contract checks

2026-09-15 performer report. No human acceptance or independent disposition.

The candidate is based on published draft.3 and excludes the owner's thirteen
unpublished commits. Draft.4 reconciliation remains a pre-acceptance action.

Observed checks:

- `pnpm exec prettier --check docs/decisions/0032-lamu-runtime-source-contract.md docs/architecture/composed-monolith-roadmap.md`: passed.
- `pnpm exec vitest run tests/deployment/docs-references.test.ts`: three tests passed.
- Patched `war check --generated`: no errors; independence, unexecuted attacks
  and proposed-unaccepted warnings remain.
- Commit review: PASS WITH NITS. The claimed JSON/Markdown disagreement did not
  reproduce. Both projections omitted lettered sections because of an upstream
  parser defect. Both were regenerated through the patched tool, not hand-edited.

Generator: `/mnt/4tb/openwarrant-normative-fix/target/debug/war`, based on upstream
commit `8f048eee8c5679660e20537f82ddf1b923b21a3f` plus the separately proposed
normative parser fix. Patched `crates/openwarrant-core/src/normative.rs` SHA-256:
`381feb58f5112bd27db761f40c4d9ffc6dcedb806f3c247a7ccf8abcb7d6f77a`.
Use that fix to reproduce these projections; the older installed tool omits them.
No installed executable was replaced.

The JSON now contains 158 sentences, including seven in section 8A and thirteen
in section 104A. Both views contain the added source-retention requirements.
The SAS source digest remains unchanged. No KF runtime test or full `pnpm gate`
was run for this documentation-only amendment.
