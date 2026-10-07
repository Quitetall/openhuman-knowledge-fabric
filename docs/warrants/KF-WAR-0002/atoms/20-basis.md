---
schema: oh.war/atom/v1
warrant_uuid: 01a114df-fbc0-7b81-a04a-9c99fc062cab
role: basis
jurisdiction: authored
order: 20
classification: internal
---

# Basis

## The contract

- **SAS `0.1.0-draft.9`** (proposed) at `docs/sas/KF_Software_Architecture_Specification.md`;
  `0.1.0-draft.8` remains the accepted, normative revision until the owner signs draft.9.
- **ADR 0039**, `docs/decisions/0039-the-first-host-is-a-vps-on-a-tailnet-with-seaweedfs-and-b2.md`
  (proposed 2026-10-03): VPS, Tailscale, SeaweedFS, Backblaze B2, CPU embedder, LAMU pinned on
  `main`.
- **ADR 0017** (storage locations) and **ADR 0028** (the retrieval index is masked, not copied).
- SAS §100 entries this Warrant moves: **§100.40** (a clean machine cannot start the object store),
  **§100.21** (the engine is built and now on LAMU `main`, so only independent verification stays
  open), **§100.39** (key custody: an owner decision).

## The branches, as measured when this Warrant was drafted

| Branch | Commits ahead of `origin/main` | What it carries |
|---|---|---|
| `host/seaweedfs` | 5, incl. ADR 0039 | SeaweedFS 4.48 pinned by digest, versioning enforced, the `kf-objects` unit, MinIO retired, `migrate-objects.mjs` |
| `host/offsite-tailnet` | 5, incl. ADR 0039 | S3 off-site copy keyed by version, B2 durable store, tailnet TLS, public-exposure check, first-host runbook |
| `harden/defensive-posture` | 1 | ADR 0039 alone, `855a2842` |
| `integrate/seaweedfs` | 0 | the integration branch, at `origin/main` |

## The overlap, and who wins

`main` already holds Codex's B2 design: migration
`database/migrations/20261002000100_cloud_backup_copy_keeps_its_version.sql`, and the custody
contracts `docs/deployment/b2-credential-custody.md`, `docs/deployment/b2-ciphertext-transport.md`
and `docs/deployment/drill-b2-credential-delivery.md`. `host/offsite-tailnet` adds a second
schema for the same fact (its migration `20261003000100`, columns on `ops.backup_copy` and a
`remote-object` off-site basis). **Codex's schema wins.** Port what `host/offsite-tailnet` adds
that `main` lacks (tailnet TLS, the public-exposure check, the runbook, the conditional-create
switch for B2 as the durable store) onto it, and drop the duplicate migration rather than
carrying two shapes of one fact.

## Existing code this reuses

- `packages/retrieval/src/real-engine.test.ts`, opt-in through `KF_RETRIEVAL_ENGINE_BIN`.
- `scripts/deploy/provision-host.sh` and `docs/deployment/private-host.md`.
- `docs/deployment/retrieval-key-release.md`, which records that the owner chose KF to release
  the engine's key at startup; §100.39 in the SAS still calls it undecided.
- `docs/handoff-draft9-main.md` and `docs/inactive-branch-consolidation.md`, which say what was
  left off `main` on purpose and why.
- The SAS change procedure in `CONTRIBUTING.md` (`war sas propose`; acceptance is the owner's).

## The unknown

Whether the two B2 designs are as compatible as their commit messages suggest. Both record the
off-site object's version, in different shapes. If porting the tailnet work onto Codex's schema
needs a migration that changes recorded rows, stop and put it in front of the owner rather than
choosing.
