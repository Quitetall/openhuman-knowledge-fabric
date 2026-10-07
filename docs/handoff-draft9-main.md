# Draft.9 source and operator handoff

Written 2026-10-07 for the next session working from `main`. This is an execution
brief, not acceptance of KF 1.0. The [SAS](sas/KF_Software_Architecture_Specification.md)
remains the authority for scope, ordering and readiness. The
[implementation log](draft9-implementation.md) records the source work and earlier
failures; its last stopped build is superseded by the dated evidence below.

For older branch work and the hosting branches intentionally left separate, use
the [inactive-branch consolidation record](inactive-branch-consolidation.md).

## Boundaries first

- Do not sign the R01 approval, allocate an identifier, or decide
  `0001-r01-schema-pack-defects.md` on the owner's behalf. Exercising a signing
  mechanism is not authorization to manufacture an approval record.
- Publishing source does not promote a VM release, commission a host, accept
  qualification, transfer SourceHolder authority or perform replacement cutover.
- Never commit the workstation encrypted store, local evidence bundles, private
  keys, credentials or backup archives. Some evidence directories include whole-store
  ciphertext; encryption does not make those directories source artifacts.
- Preserve other worktrees, shared services and existing credential generations.
  Use a separate branch/worktree for concurrent implementation; do not reset
  someone else's checkout to make it match `main`.

## Start from the integrated source

Repository: `https://github.com/Quitetall/openhuman-knowledge-fabric`.
Fetch `origin`, then create a uniquely named task branch/worktree from `origin/main`.
Do not assume an existing local `main` or an old hardening branch is current.

In that task checkout:

```sh
pnpm install --frozen-lockfile
pnpm gate
```

Use Node 24.18.1 or newer within major 24, pnpm 11 and the host prerequisites in
[CONTRIBUTING](../CONTRIBUTING.md). Tests use real PostgreSQL 18 containers;
do not stop unrelated containers to run them. Keep skipped tests visible in the
result. A passing repository gate is source verification, not host qualification.

## Source and running host are different

The implementation baseline is commit
`4224edb58c371c043675428c7941518b17333f61`. It includes 154 migrations, native
credential delivery/consumer bindings, backup and restore hardening, and the
admitted-database route for restricted backup-role cluster dumps. Its clean
sealed-release build on 2026-10-04 passed the full gate: 323 test files and 3,317
tests passed; four files and 25 tests were skipped.

That candidate was sealed at
`/opt/kf-releases/knowledge-fabric-4224edb58c37`, with manifest SHA-256
`4106368cbbd8e563a93a1d18e12e3929ac85e074683e491991b8f0f7730a9d1a`.
Authenticated migration rehearsal applied all 154 migrations and rolled back
one above the forward-only floor `20261002000100`. Candidate sealing and a
machine-authenticated receipt are not human release approval.

Read-only VM verification on 2026-10-07 still found:

- `/opt/kf` resolves to `knowledge-fabric-637677e2c5e1`.
- The live database has 91 migrations, latest `20260911000200`.
- The API and web services are active; the checkpoint timer is inactive.
- `core.audit_checkpoint` contains zero rows.

Do not report the 154-migration candidate as deployed. Any source change,
including this handoff, requires a fresh seal and applicable authenticated
rehearsal before promoting that changed release. The earlier receipt does not
authenticate new bytes.

## Owner lane: account, custody and workstation installation

The owner selected B2 off-site storage, Bitwarden recovery custody and the
existing encrypted workstation store. Start at account signup; do not infer
that selecting B2 means an account or usable credentials already exist.

On this workstation, the prepared interactive helper is:

```sh
bash /mnt/4tb/kf-vm/setup/backblaze-setup.sh
```

It starts with signup/MFA, cost caps, a private bucket and bucket-scoped
credentials. Follow [backup custody](deployment/backup-custody.md) and the
[B2 custody contract](deployment/b2-credential-custody.md); store values directly
in the encrypted store, not chat, source, shell arguments or plaintext files.
The drill reader is separate from the upload identity; never fall back to a
writer credential for a read-only drill.

The two prepared owner-run workstation installers are:

```sh
bash /mnt/4tb/kf-vm/setup/durable-provider-20261004.toW897/setup-host.sh
bash /mnt/4tb/kf-vm/setup/durable-bootstrap-20261004.asTngq/setup-noswap.sh
```

Inspect each helper and its expected service/mount state before running it.
These are machine-local artifacts, not files a remote clone receives. Their
presence does not prove installation. Do not bypass an owner password prompt.

A guarded service generated checkpoint key public identity
`ckpt-2cf75d0e5aad1f77` on 2026-10-04. Its private material remains encrypted;
no approval or checkpoint record was created. Public-key read-back is not
production trust publication, native delivery, Bitwarden custody or independent
recovery. The owner must actually save and demonstrate recovery of the required
keys without depending on the original workstation TPM or lost VM.

## Engineering lane: prepare, then commission, then qualify

1. Work from the SAS gap list and [implementation log](draft9-implementation.md).
   Source fixes and preparation may proceed while the owner handles accounts;
   absent credentials or custody evidence must remain explicit blockers.
2. Once owner prerequisites exist, validate actual provider capabilities,
   [native credential delivery](deployment/application-credential-delivery.md),
   [consumer bindings](deployment/application-consumer-binding.md) and
   [loaded service composition](deployment/commissioning-unit-composition.md).
   Preserve the selected [KF-to-LAMU startup key release](deployment/retrieval-key-release.md).
3. Follow [host commissioning](deployment/private-host.md) and the
   [backup/restore contract](backup-and-restore/README.md). Require real checkpoint
   trust and anchor delivery, off-site upload/read-back, isolated restore,
   reboot recovery and phone alert receipt. Do not create backdated checkpoints
   to make unsigned history look verified.
4. Keep qualification last, after hosting and correctness, as ordered by SAS
   §24A and [ADR 0038](decisions/atoms/KF-ADR-0038-qualification-is-evidence-against-a-versioned-pack.md).
   The qualification system is specified, not established by the local gate.
   Record measured failures, skips and human-pending decisions separately.
5. Perform replacement cutover only through the specified authority and
   acceptance process. Technical progress does not discharge human decisions.

## Evidence available only on this machine

The latest native restricted-role producer/restore proof is under
`/mnt/4tb/kf-vm/evidence/candidate-backup-4224edb5-20261004.v3T8euxV`, with a
second-device copy under
`/mnt/2tb/kf-preservation/evidence/candidate-backup-4224edb5-20261004.gqVijesl`.
The payload manifest SHA-256 is
`51a5cf58405cde0c4a46b48a644169fff810ced58d3246a6ed3ff78b1c749e8a`.
The producer passed only in its explicitly selected development profile.
Restore was PARTIAL: database equality and 15/15 external objects passed,
checkpoint verification did not. This was not a B2 download or production
backup record. Two local copies are not off-site protection or independent
verification.

Checkpoint-key evidence is under
`/mnt/4tb/kf-vm/evidence/checkpoint-key-20261004.4pYxvPVB`, with a copy under
`/mnt/2tb/kf-preservation/evidence/checkpoint-key-20261004.k0uCr86a`.
Its payload manifest SHA-256 is
`83406a5243ed6de15d58c329f80a1cafbc2393b0efe09075c16f05a8297969a0`.
Keep both evidence sets immutable and out of Git. A remote worker must request
an appropriate redacted evidence handoff rather than assume these paths exist.
