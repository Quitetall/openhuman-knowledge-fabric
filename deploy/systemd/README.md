# systemd deployment surface

These files cover API, identity attestor (`kf-attestor.service`), web, worker, one-shot migrator,
failure alerting and scheduled preservation operations.
Nginx template lives in [`../nginx/knowledge-fabric.conf`](../nginx/knowledge-fabric.conf).
PostgreSQL, object store, Keycloak, certificates, alert delivery and host policy remain external.
Tracked files are deployment inputs, not commissioning evidence. Complete contract and current
blockers are in [`../../docs/deployment/private-host.md`](../../docs/deployment/private-host.md).

Every unit assumes `/opt/kf` names the exact release whose checksum manifest passed host
preflight. Do not rebuild under that path. Install a new immutable release elsewhere, verify it,
then switch `/opt/kf` atomically; retain the previous release for rollback.

## Runtime identity boundary

A shared host runs the application with:

```text
NODE_ENV=production
KF_DEPLOYMENT_PROFILE=dogfood
KF_TLS_TERMINATED_UPSTREAM=1
```

API also needs complete `OIDC_ISSUER` / `OIDC_AUDIENCE` / `OIDC_JWKS_URI` set and owner-only
database/object-store secret files, and `kf-attestor.service` running: the database binds a
person for the API's login only on an attestation from it (`KF_ATTESTOR_SOCKET`, set on the
API's command line). Web needs reviewed public OIDC client plus owner-only
session key. Fixed `KF_DEV_*` identity is forbidden.

Every unit uses a distinct unprivileged account, with one exception: `kf-alert@.service` and
`kf-alert-heartbeat.service` both run as `kf-alert`, because both hold the same single secret
(the webhook URL) and nothing else. `tests/deployment/systemd-units.test.ts` holds this: every
`.service` names exactly one non-root `User=`, and the set of shared accounts must EQUAL its
declared list (currently that one pair), so a new share fails and a stale excuse fails too
(KF-SAS-RQ-163). Command-local API/web listener settings prevent an
environment file widening loopback binds.

`kf-notify@.service` (ADR 0040 decision 9) runs as `kf-notify`, one template for both of its
timers: `kf-notify-digest.timer` starts `kf-notify@digest` daily and `kf-notify-urgent.timer`
starts `kf-notify@urgent` every five minutes. Its database login inherits `kf_notifier`, which
reads no table and may only execute the two functions that decide what a notification may say.
It holds `/etc/kf/notify/{database-url,smtp.json,alert-webhook-url}` and `/etc/kf/notify.env`;
the urgent push runs `scripts/alert-dispatch.sh` with the event `urgent`, the operational alerts' own path.
See [`../../docs/agents/in-app-agent.md`](../../docs/agents/in-app-agent.md).

`kf-backup.service` and `kf-restore-drill.service` shared `kf-backup` until 2026-09-23, on the
argument that they needed the same secrets. They did not: the backup SIGNS with the preservation
key, the drill DECRYPTS with the recovery key, and with one uid the only thing keeping the
decryption credential from the job that writes the archive was which unit file named it. The
drill now runs as `kf-drill`, holds the sealed decryption credential, a ledger login and a
read-only object-store key, and no signing key at all — `restore-verify.sh` signs its throwaway
re-export with a key made for that run. No second host is needed for the separation.

The two private keys are each owned mode `0600` by the single identity that uses them:
`/etc/kf/checkpoint/checkpoint-key` by `kf-checkpoint`, `/etc/kf/backup/preservation-manifest-key`
by `kf-backup`. No other identity — application or scheduled — can read either. Host must prove
denial after install.

The checkpoint signer runs with `NODE_ENV=production`, which removes the old `checkpoint-1`
default: `CHECKPOINT_SIGNING_KEY_ID` in `/etc/kf/checkpoint.env` names the key, and `--run`
refuses to sign unless `/etc/kf/checkpoint-public-keys/<id>.pub` exists and is the public half
of the configured private key. Rotating a key therefore means a NEW id, its `.pub` installed
first, then the id changed — never a new private key under an old id, which used to turn every
earlier checkpoint into an unexplained `bad_signature`. Each checkpoint is also written to the
external anchor (`CHECKPOINT_S3_*`); without one it is still signed into the database, and the
run then exits nonzero so `OnFailure=` reports it every hour until an anchor is configured.

This is stricter than it was. Until 2026-08-17 all five scheduled units ran as a shared `kf`,
so both signing keys were readable by the backup, offsite, readiness and restore-drill jobs.
`kf-commissioning` now refuses any host where units sharing an identity do not need the same
secrets, which is the property that failure violated and that comparing only the API against
the checkpoint signer could never have caught.

`kf-migrate.service` is manual oneshot with no install target. It checks exact release tree,
pinned dbmate version and matching disposable-cluster rollback receipt before reading production
credential. Application start/restart never runs migrations.

## Scheduled operations

These things have to happen on a schedule, and until they are scheduled they are habits:

| Unit                        | Interval          | What stops being true without it                                                            |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `kf-checkpoint.timer`       | hourly            | The audit log is unsigned past the last run. A rewrite inside that window is undetectable.  |
| `kf-backup.timer`           | daily 02:00       | Everything exists in one place.                                                             |
| `kf-backup-offsite.service` | after each backup | The copy is beside the original; a lost host loses both.                                    |
| `kf-audit-verify.timer`     | daily 05:15       | A rewritten audit log or an unverifiable checkpoint goes unnoticed until the monthly drill. |
| `kf-restore-drill.timer`    | monthly           | Nothing has proven the backups can be read.                                                 |
| `kf-readiness.timer`        | every 15 min      | Nothing notices when any of the above stops running.                                        |
| `kf-alert-heartbeat.timer`  | daily             | Nothing notices when the thing that notices stops working.                                  |
| `kf-storage.timer`          | daily 03:30       | Every artifact version has one copy, and nothing has re-hashed the copies that exist.       |
| `kf-tls-renew.timer`        | daily 03:30       | Tailnet hosts (ADR 0039): the `tailscale cert` certificate lapses after 90 days.            |

The readiness and heartbeat timers are what make the others real. A backup timer that silently stops is
indistinguishable from a backup timer that is working, right up until the restore — unless
something is checking, and something is failing when the check fails.

And that check reports through `kf-alert@`, which is why the heartbeat exists. A failed alert
is visible on the host in `systemctl --failed`; an alert path that has quietly stopped working
is visible nowhere. The daily ping means the RECEIVER can alert on silence, which is the only
way to catch an alerter that cannot report its own death.

Enable both: `systemctl enable --now kf-alert-heartbeat.timer`. `kf-alert@.service` is a
template pulled in by `OnFailure=` and is never enabled directly.

Each timer declares in its own file how long it may go without firing (`X-KF-MaxSilenceSec=`,
an `X-` key systemd ignores). `kf-readiness.service` runs `scripts/timer-liveness.sh` before the
readiness checks and fails, naming the timer, when any is inactive or silent longer than that;
`kf-alert-heartbeat.service` runs it for `kf-readiness.timer` alone and withholds the heartbeat
while readiness itself is not firing. Until 2026-09-23 nothing noticed a timer that had stopped.

## Install

Do not enable units until `/opt/kf` points at verified release, identities and owner-only files
exist, migration rehearsal/application succeeded, recovery objective is declared, off-site
destination is set and working `kf-alert@.service` reaches person.

One command creates everything a machine can, and a second form lists what it cannot:

```sh
sudo /opt/kf/scripts/deploy/provision-host.sh --check   # changes nothing; exit 0 = nothing missing
sudo /opt/kf/scripts/deploy/provision-host.sh           # safe to re-run; never overwrites
```

[`../../scripts/deploy/provision-host.sh`](../../scripts/deploy/provision-host.sh) is this section,
executable. Until 2026-09-23 it was forty hand-typed lines here, and the hardening of that day
added a dozen more — a receipt key, a readiness token, a pinned checkpoint key id, a sealed drill
credential, two identities, an object-store policy. It:

- creates the seventeen service identities (`kf-api`, `kf-web`, `kf-worker`, `kf-migrator`,
  `kf-checkpoint`, `kf-backup`, `kf-offsite`, `kf-readiness`, `kf-storage`, `kf-audit-verify`,
  `kf-alert`, `kf-drill`, `kf-attestor`, `kf-retrieval-key`, `kf-embedding`, `kf-retrieval`,
  `kf-tls`), each with no home and no shell, the `kf-archive` group
  (`kf-backup` writes the archive, `kf-offsite` reads it to ship it) and the `kf-attest` group
  (`kf-attestor` serves its socket in it, `kf-api` alone may connect);
- creates `/etc/kf` traversable and every service subdirectory `0750 root:<identity>` except
  `/etc/kf/attestor`, which is `0700 kf-attestor`, the credential store `0700 root`, the two public trust directories `0755 root`, `/var/lib/kf-worker`,
  `/var/lib/kf-migrator` and the setgid archive `/srv/kf-backups`;
- installs every environment file from its `*.example` template (`attestor.env` among them),
  `0640 root:<identity>`
  (`storage.env` `0600 kf-storage`), and completes it with what it can derive rather than ask
  for: the PostgreSQL 18 client directory; the drill's off-site source and label from
  `offsite.env`; and the artifacts store's endpoint, region, bucket and path style in
  `drill.env`, `worker.env` and `storage.env` from `api.env` once that is filled (never an
  access-key id — each identity has its own key). A value an operator has set is never replaced;
- GENERATES every secret a machine can make — the rollback-receipt HMAC key, the web session
  key, the readiness token, the master-record link key and the checkpoint signing key — from
  `/dev/urandom` straight into a `0600` file owned by the one identity that reads it, never
  printed and never on a command line. The checkpoint key's id is its fingerprint
  (`ckpt-<16 hex>`), its public half is published in `/etc/kf/checkpoint-public-keys/` before
  the id is written to `checkpoint.env`, so a new key always has a new id;
- creates an empty `0600` file, owned correctly, for every secret only a person can supply
  (database logins — among them `/etc/kf/attestor/database-url`, a login in `kf_attestor` only,
  which the API's login must never be — object-store secrets, the alert webhook, the preservation
  key), so the only remaining step is writing its value;
- installs every shipped unit into `/etc/systemd/system` byte for byte and reloads systemd;
- for this host's own object store, `kf-objects` (SeaweedFS on loopback, ADR 0039): installs
  the pinned binary at `/usr/local/lib/kf-objects/weed` after checking the tarball's and the
  binary's sha256 (`deploy/object-store/seaweedfs.release`), generates the secret of each
  service routed at it (API, worker, storage sweep, drill) and of the store's administrator
  (`/etc/kf/objects-init/admin-secret`, held by `kf-objects-init` alone), and
  renders `/etc/kf/objects/identities.json` (0600 `kf-objects`) from those files — the storage
  key granted exactly the orphan-collection policy's prefixes, the drill's key read-only.
  `kf-objects.service` runs the store; `kf-objects-init.service` creates the buckets and fails
  unless each reads back versioning `Enabled`. For a store that is not this host's own it prints
  the orphan-collection policy to apply there; then asks the store, as `kf-storage`,
  whether the key really may list and delete versions (every key the sweep then deletes is
  recorded in `content.orphan_collection` in the same run; a deletion it cannot record fails it);
- ends with the inputs only a person can supply, each with the exact file it goes in.

It never regenerates or overwrites anything that exists: re-running it after an upgrade creates
what the new release needs (in 2026-09 that was `kf-drill` and `/etc/kf/drill/`) and re-running it
after supplying an input is how you confirm the input took. `--check` exits non-zero while
anything is missing; `kf-commissioning`'s `unit_provenance` and `secret_posture` point at it.

**The backup recovery key.** Backups are encrypted to an OpenPGP public key whose secret half
belongs to whoever performs recovery. Supply your own public key as `/etc/kf/backup-recipient.asc`
and seal its secret half for the drill with `--seal-drill-key <recovery-secret-key.asc>` (read by
path, never copied), or let the host make the pair with `--generate-recovery-key <file>`, which
writes the public key, seals the secret key for the drill, and writes the secret key once to
`<file>` for the custodian to take off the host.

**Preservation signing key.** Not generated: it is in external custody by design (see below).
Provisioning creates its empty `0600 kf-backup` file and lists it.

Fill files through approved secret/configuration mechanism; examples contain placeholders and
must not be started unchanged. `0600` is enforced by application secret loader. Keep top
`/etc/kf` traversable but every service subdirectory group-scoped. Never place credential inline
in environment file. The worker environment also names an immutable native Liminal binary, its
exact Cargo.lock, `/usr/bin/bwrap`, `/var/lib/kf-worker`, and reviewed colon-separated ELF
interpreter/shared-library file closure. Directories are not accepted: bubblewrap receives each
runtime file through a pinned open descriptor and never mounts an ambient `/usr` tree. Derive that
closure on the target host (for example with `ldd`), review every resolved file, and keep it in the
host qualification evidence. Startup executes a real sandbox probe;
each compile repeats the cached adapter-instance preflight before executing compiler bytes. The
worker unit permits only the namespace and mount syscalls required to construct that child, while
the child receives a fresh network namespace and no worker environment, source tree, or secret
mounts. Registration must carry RFC 8785 digest of ordered `{path, contentDigest}` records for
that first-occurrence-deduplicated list; worker rehashes opened file descriptors for every run.
A successful host probe does not enable a compiler identity: database owner must also
register the exact digests, qualification state, and any ratification receipt.

### Preservation signing-key custody

`/etc/kf/backup/preservation-manifest-key` is an Ed25519 private key in external owner-only custody;
it is never generated by this repository, copied into a release, or included in a backup.
`/etc/kf/preservation-trust.d` is the independently preserved historical public trust store.
It contains only regular UTF-8 PEM files named `<immutable-key-id>.pub`. Treat that directory
as append-only: install a new public key before changing `PRESERVATION_SIGNING_KEY_ID` and the
private key, and retain every old public key for at least as long as any package it signed.
Removing an old key deliberately makes retained history unverifiable.

The trust store is not bootstrapped from a preservation package. An attacker who can replace a
package could replace an embedded trust root too, so verification always receives this external
directory. Preserve it through a separately controlled, append-only configuration/secret backup
and disaster-recovery process. Keep private and public custody records outside `/opt/kf`; release
rollback must not roll keys backward.

Same key signs two nested scopes. `export/manifest.json` authenticates canonical institutional
record. `backup.manifest.json` authenticates closed outer directory, including PostgreSQL dump,
schema, roles, README, `SHA256SUMS`, and full export tree. Its detached
`backup.manifest.signature.json` avoids recursive self-hashing. Restore authenticates outer
manifest against `/etc/kf/preservation-trust.d` before executing `roles.sql` or invoking
`pg_restore`; recomputing compatibility sums never grants authority. Root manifest binds exact
`database_snapshot_sha256` from already authenticated inner preservation manifest. Restore
streams every verified file into a new mode-`0700` staging directory and consumes only those
staged bytes, closing source-path replacement between verification and execution.

`CHECKPOINT_PUBLIC_KEY_DIR` follows the same `<signing-key-id>.pub` filename rule. Those files
are public, so a configured backup copies their exact bytes into `export/trust/checkpoint/`.
The signed preservation manifest authenticates that copy. Restore verification authenticates
the package first and only then uses the archived directory to verify historical checkpoints.
Checkpoint private keys are never copied.

Database restoration is only one proof dimension. The object-store dimension re-reads every
stored object the restored export references: the verifier receives a request naming each one
(URI and version, no digests) and a proof-output path, re-reads every object, and reports the
digest and size it measured, which `scripts/lib/object-store-proof.mjs` then checks against the
authenticated export. The release ships that verifier
(`apps/kf-storage/dist/verify-object-store.js`); the drill runs it with the routing in
`/etc/kf/drill.env` and the read-only secret in `/etc/kf/drill/s3-secret-access-key`. Until
2026-09-23 every host had to write and pin its own, and one that had not recorded every drill
`partial`. A store that verifier cannot speak to can still be served by an operator-supplied,
root-owned program named in `KF_OBJECT_STORE_VERIFY_PROGRAM`, which is refused unless its
digest is pinned in `KF_OBJECT_STORE_VERIFY_PROGRAM_SHA256` — it is the one program not covered
by the release manifest. `KF_OBJECT_STORE_PROOF_REF` names external custody evidence without
credentials (default `kf-builtin-verifier:<bucket>`). Database, checkpoint, and object-store
results land separately in `ops.restore_drill`; only all three may use outcome `verified`.
Missing store configuration is recorded `partial`, returns nonzero, and keeps readiness red.

Run migration procedure in private-host guide. Only after it and real-provider preflight pass:

```sh
sudo systemctl enable --now kf-attestor.service kf-api.service kf-worker.service kf-web.service
sudo systemctl enable --now kf-checkpoint.timer kf-backup.timer kf-storage.timer \
  kf-audit-verify.timer kf-restore-drill.timer kf-readiness.timer kf-alert-heartbeat.timer
# A tailnet host (ADR 0039) also renews its certificate:
sudo systemctl enable --now kf-tls-renew.timer
```

Do not enable `kf-migrate.service`; start it once per reviewed release. Do not start nginx until
example hostnames/certificate paths are replaced and `nginx -t` passes.

After installation, reboot and verify the timers, their last service results and a real restore
drill. A successful `systemctl enable` proves only that symlinks were created.

## Declare the recovery objective first

Every preservation check FAILS until this row exists, on purpose. A schedule cannot be called
sufficient before somebody decides what it has to be sufficient _for_.

```sql
insert into ops.recovery_objective
  (rpo_seconds, rto_seconds, restore_drill_days, requires_pitr, declared_by, rationale)
values
  (:human_declared_rpo_seconds, :human_declared_rto_seconds,
   :human_declared_restore_drill_days, :human_declared_requires_pitr,
   :human_declared_person_id, :human_recorded_rationale);
```

Every placeholder requires named human authority; deployment tooling must not choose values.
`requires_pitr` is real decision with real consequence. `true` makes `pitr_readiness` check
server archiving against that decision and fail when archiving is off or last attempt failed.
See [`../postgres/pitr.conf`](../postgres/pitr.conf).

## Planner settings

Include [`../postgres/planner.conf`](../postgres/planner.conf) from `postgresql.conf` and reload.

Unlike `pitr.conf` this is not posture-dependent. It turns JIT off, measured at 8–14× on
row-level-security-filtered reads: RLS subplans inflate the planner's cost estimate to roughly a
hundred times the real work, and JIT triggers on that estimate. The dev stack and the test
harness both set it, so a host that skips this file is the only place left running the
configuration that was measured slow.

## Failure handling

Each unit has `OnFailure=kf-alert@%n.service`. That unit ships: it runs
`scripts/alert-dispatch.sh` as `kf-alert` and posts to the `https://` webhook in
`/etc/kf/alert/webhook-url`, and it refuses to start while that file is empty — a default that
goes nowhere is worse than an absent one that fails to start. Supplying the webhook is the
deployment's part.

The long-running services (`kf-attestor`, `kf-api`, `kf-web`, `kf-worker`) restart on failure, and restart
alone never reaches `failed`: the unit loops in `activating (auto-restart)` and `OnFailure=`
never fires. Each therefore sets `StartLimitIntervalSec=30min` / `StartLimitBurst=5` in `[Unit]`,
so a sixth start inside half an hour stops the loop, fails the unit and alerts. After fixing the
cause, `systemctl reset-failed <unit>` re-arms it. `tests/deployment/systemd-units.test.ts`
refuses any unit with `Restart=` that lacks either.

A timer whose service fails stays failed until it is looked at; `systemctl list-units --failed`
is the query. `kf-readiness` exits non-zero on **degraded** as well as failed, so a stale index
or a lapsed drill surfaces before it becomes the reason a restore does not work.

## Ordering

`kf-backup-offsite.service` is `Requires=`+`After=` the backup and pulled in by
`Wants=` from it, so the copy runs when a backup completes rather than on a clock of its own.
A copy on a separate schedule copies whatever happens to be there, including nothing.

It ships the backup's encrypted archive (`<backup>.tar.gpg`), never the plaintext directory, and
re-measures it at the destination before recording anything. It reads `/etc/kf/offsite.env`
and refuses to start, in words, while `KF_OFFSITE_DESTINATION` or `KF_OFFSITE_LABEL` is empty
or a local destination is not writable inside the unit (add `ReadWritePaths=` in a drop-in).
Until 2026-09-23 it shipped with an empty destination and no trust store, and failed every
night.

Whether the copy counts as off-site is decided by what the destination is, and recorded in
`ops.backup_copy.offsite_basis`: `user@host:/path` is `remote-host`; a local path is
`local-unattested` and **not** off-site — a second disk in the same chassis is the same host —
unless `KF_OFFSITE_FAILURE_DOMAIN` names a failure domain a person approved in
`ops.physical_failure_domain_evidence` (`attested-domain`). An attested copy also writes its own
`ops.encrypted_backup_evidence` row from the ciphertext digest it measured, carrying the domain
approval's approver; nobody types that row by hand any more.

The restore drill picks the most recent backup with an off-site copy at
`KF_DRILL_OFFSITE_LABEL`, pulls that copy back from `KF_DRILL_OFFSITE_SOURCE`, checks it is the
ciphertext recorded as sent, decrypts it, and restores it into a throwaway PostgreSQL cluster
(socket-only, own port, under `StateDirectory=kf-restore-drill`) that it deletes afterwards. It
never creates a database in the production cluster. It records the drill against the
**production** ledger — a drill recorded in the throwaway cluster is discarded along with it.

The decryption key reaches the drill as an encrypted systemd credential, sealed to the host by
`provision-host.sh --seal-drill-key <recovery-secret-key.asc>` (or made with the pair by
`--generate-recovery-key <file>`); shred the plaintext copy afterwards.

It is decrypted into the drill's private credential directory for one run and is never a
plaintext file on disk. Only `kf-restore-drill.service` names it, and it runs as `kf-drill`, a uid
no other unit uses — so the backup job, which writes and signs the archive, cannot obtain it. Where a separate recovery host
exists, run the drill there instead — the script and unit are the same. The drill also needs
the PostgreSQL 18 server package (`KF_POSTGRES_SERVER_DIR`, for `initdb` and `pg_ctl`) and
`gnupg`.
