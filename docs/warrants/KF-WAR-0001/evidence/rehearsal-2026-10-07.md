# KF-WAR-0001: the install rehearsed on a VM shaped like the VPS, 2026-10-07

**Not commissioning evidence.** KF-WAR-0001 is a draft, the machine below is a VM on the build
workstation (exactly what the gate's first blind spot says it cannot tell apart from a real host),
and every owner-supplied part was a stand-in. This records what installing the shipped release
the documented way found, and what was changed because of it, so the VPS install does not find
it again.

## The rehearsal host

- **kf-rehearsal**: Debian 13 generic cloud image (checksum matched Debian's `SHA512SUMS`), KVM,
  4 vCPU, 8 GiB, 80 GB, plain qemu with user-mode networking (the reason is in
  [dogfood-vm.md](../../../deployment/dogfood-vm.md)). Snapshot `host-requirements` holds the
  image with only the host requirements installed, so the install can be repeated from clean.
- **kf-vault**: a second VM, 1 vCPU, 768 MiB: the rsync off-site destination, and a SeaweedFS S3
  endpoint over TLS standing in for the B2 durable and anchor buckets.
- **Stand-ins, clearly not the real thing**: a `tailscale` CLI and `tailscaled` unit that put
  100.101.102.103 on a dummy `tailscale0` and hand out a certificate for
  `kf-rehearsal.tail0rehearsal.ts.net` from a throwaway CA (honouring `TS_PERMIT_CERT_UID`); an
  https alert receiver on loopback; an OIDC issuer URL that points at nothing (no Keycloak);
  throwaway preservation and recovery keys; a fictional organization. Every secret was generated
  inside the VMs and moved between them through pipes.
- Release: built by `scripts/deploy/build-release.sh` with the gate step replaced by `pnpm build`
  for the iterations (the full-gate build of `origin/main` was attempted first and failed on test
  deadlines on a workstation at load ~25, not on defects). Seven releases were built and promoted
  byte for byte with `install-release.sh`; the last, `b0d4d784dad7`, was installed on a VM
  reverted to the clean snapshot and taken through every step of
  [the runbook](../../../deployment/first-host-runbook.md).

## What it found, and what was done

Each was hit on the VM; each fix has a test that fails without it.

| #   | Found                                                                                                                                                                                         | Fixed in                                                                                                     | Test                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1   | The rollback rehearsal could not complete: `20261007400000`'s down section dropped a table a policy on another table reads                                                                   | that migration's down section                                                                                | `tests/database/rollback-to-floor.test.ts` (new)                         |
| 2   | Then `20261007100000`'s down section deleted from an append-only table, and dropped a table before the function returning its row type                                                        | that migration's down section                                                                                | the same                                                                 |
| 3   | Every database login was "a connection string only a person can supply", eleven of them, plus the migrator, the disposable rehearsal cluster and the planner settings                       | `scripts/deploy/provision-host.sh`, `deploy/postgres/login-url.mjs`, `deploy/systemd/database.env.example`   | `tests/deployment/provision-host.test.ts`                                |
| 4   | The worker could not start from the shipped `worker.env.example` on the ordinary (`liminal=none`) release, and `--check` asked a person for three compiler digests                           | `deploy/systemd/worker.env.example`, `provision-host.sh`                                                     | `provision-host.test.ts`                                                 |
| 5   | The checkpoint public key was published 0600 root (umask), so the signer could not read it                                                                                                    | `provision-host.sh`                                                                                          | `provision-host.test.ts`                                                 |
| 6   | The signer read the audit log `for share`, which needs UPDATE, which `kf_checkpoint` never has                                                                                               | `apps/checkpoint/src/run/runner.ts`                                                                          | `tests/audit-verification/ledger.test.ts`                                |
| 7   | And `kf_checkpoint` had no row-security policy on `core.action`, so through its own login the signer saw nothing to sign                                                                    | migration `20261007900000_the_checkpoint_signer_sees_the_actions_it_signs`                                   | the same                                                                 |
| 8   | The backup and its ciphertext were owner-only, so the off-site copier (group `kf-archive`) could not read them                                                                               | `scripts/backup.sh`                                                                                          | `tests/backup-restore/backup-hardening.test.ts`                          |
| 9   | An rsync off-site destination had no ssh key or pinned host key for `kf-offsite`/`kf-drill`, who have no home                                                                               | `provision-host.sh` (keys, `/etc/ssh/ssh_config.d/kf-offsite.conf`, the owner's two acts named)              | `provision-host.test.ts`                                                 |
| 10  | The drill refused its own decryption key: systemd's credential mount is root 0440 + ACL, which the owner-only file rule refuses                                                              | `scripts/restore-drill.sh`, `deploy/systemd/kf-restore-drill.service`                                        | `tests/deployment/systemd-units.test.ts`                                 |
| 11  | After a reboot nginx had failed: it raced tailscaled for the tailnet address                                                                                                                 | `deploy/nginx/nginx-waits-for-tailnet.conf`, rendered by `provision-host.sh`                                 | `provision-host.test.ts`                                                 |
| 12  | Removing Debian's default site and reloading nginx left `0.0.0.0:80` open; only a restart closes it                                                                                          | `provision-host.sh` message, `private-host.md`                                                               | `provision-host.test.ts`                                                 |
| 13  | At boot the attestor started before PostgreSQL, failed, and alerted                                                                                                                          | `After=` in `kf-attestor`, `kf-api`, `kf-worker` units                                                       | `systemd-units.test.ts`                                                  |
| 14  | Every `systemctl stop kf-web` (every upgrade) alerted: Next.js exits 143 on SIGTERM                                                                                                          | `SuccessExitStatus=143` in `kf-web.service`                                                                  | `systemd-units.test.ts`                                                  |
| 15  | Readiness failed from its first run: the documented enable list omitted the two notify timers that timer liveness requires                                                                   | `deploy/systemd/README.md`                                                                                   | — (documentation)                                                        |
| 16  | `evidence_receipts` could never be satisfied: nothing wrote `release-verification.json` or `rollback-rehearsal.json`                                                                        | `install-release.sh`, `migrate-release.sh`, `provision-host.sh` (the directory)                             | `install-release.test.ts`, `private-host.test.ts`, `provision-host.test.ts` |
| 17  | Nor on any `liminal=none` release: it required a ratified qualification of a compiler the release does not ship                                                                              | `packages/operations/src/internal/commissioning/host.ts`; gate re-qualified                                  | `packages/operations/src/commissioning.test.ts`                          |
| 18  | `systemd_loaded_units` became unverifiable once any notify run had failed: `kf-alert@kf-notify@digest.service.service` was refused as a name                                               | `unit-composition.ts`; supplementary battery re-recorded                                                     | `packages/operations/src/systemd-observation.test.ts`                    |
| 19  | `kf-commissioning --json > file` wrote an empty file: the report went to stderr                                                                                                               | `packages/operations/src/commissioning-cli.ts`                                                               | `tests/deployment/commissioning-cli-output.test.ts` (new)                |
| 20  | Values a machine can derive were asked of a person: the migration unit's digest and receipt path (and its `RELEASE_ID` placeholder went unreported), the public origins, the web's redirect URI and issuer, the urgent push's webhook | `provision-host.sh`                                                                                          | `provision-host.test.ts`                                                 |
| 21  | `--check` demanded the disposable rehearsal cluster back after it was dropped, as the contract says to, so it could never exit 0                                                             | `provision-host.sh`                                                                                          | `provision-host.test.ts`                                                 |
| 22  | systemd-resolved answered LLMNR on every address (Debian 13 cloud image); `public_exposure` failed on it                                                                                     | `provision-host.sh` (resolved drop-in)                                                                       | `provision-host.test.ts`                                                 |
| 23  | A host without semantic search read as complete to `--check`                                                                                                                                 | `provision-host.sh` now lists it                                                                             | — (listed, not installed)                                                |
| 24  | A description containing `\|` was cut short in the `--check` report; the first run printed "Unit kf-objects.service not found"                                                              | `provision-host.sh`                                                                                          | `provision-host.test.ts`                                                 |

Found and **not** changed, because each is a decision rather than a defect:

- The checkpoint anchor's object keys (`audit/checkpoints/<from>-<to>.json`) are not namespaced by
  database. A host reinstalled against the same anchor bucket collides with its predecessor's
  first checkpoint and is refused on every run ("refusing to replace"). The rehearsal gave the
  fresh host its own bucket. Namespacing, or a new bucket per database, is a choice for the owner.
- The anchor key needed read as well as write on its bucket (SeaweedFS refused the conditional
  create with a write-only key). Whether a B2 `writeFiles`-only key behaves the same is unverified.
- Records written by the owner commands (`bootstrap-organization`, `grant-authority`) bypass the
  outbox, so readiness reports them unindexed until `select search.rebuild();`.
- On systemd 257 a `Restart=on-failure` service that fails once still triggers `OnFailure=`,
  which `deploy/systemd/README.md` said it does not; the README now records the observation.
- Semantic search (ADR 0039 decision 5) is not installed by anything here.

## What got to green on the VM

After the clean install and again after an unwatched reboot:

- `provision-host.sh --check` listed three items: the SMTP relay, sshd on the public address, and
  semantic search.
- `kf-commissioning`: 9 of 11 checks satisfied — `unit_provenance`, `systemd_loaded_units`,
  `attestor_separation`, `tls_termination`, `reverse_proxy_posture`,
  `identity_provider_policy`, `runtime_version`, `liminal_runtime_inventory`,
  `evidence_receipts`. Not satisfied: `secret_posture` (the empty SMTP file, and the retrieval
  key semantic search would need) and `public_exposure` (sshd, and the DHCP client on `udp:68`).
- A signed checkpoint written to the anchor stand-in and verified by `kf-audit-verify`; the key
  refused to all nine other service accounts.
- A backup, its ciphertext copied over ssh to kf-vault and re-measured there, and the restore
  drill pulling that copy back, decrypting it with the sealed credential, restoring it into a
  throwaway cluster and recording `verified`.
- Readiness service checks green; the institutional check `secure_object_storage_evidence`
  failing until the owner approves three physical failure domains.
- The shipped nftables rules loaded (with an automatic revert): ssh on the public interface
  stopped answering, and answered again when they were removed.
- Every unit and timer active after the reboot; nginx serving the tailnet name; the web 200.

Not reached: OBL-001's served-from-the-durable-copy step (nothing could be ingested without an
identity provider to sign in through), OBL-008 (no retrieval engine), and everything the
[uncovered controls](uncovered-controls.md) list.
