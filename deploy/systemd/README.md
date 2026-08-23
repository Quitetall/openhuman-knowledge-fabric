# systemd deployment surface

These files cover API, web, worker, one-shot migrator and scheduled preservation operations.
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
database/object-store secret files. Web needs reviewed public OIDC client plus owner-only
session key. Fixed `KF_DEV_*` identity is forbidden.

Every unit uses a distinct unprivileged account except `kf-backup.service` and
`kf-restore-drill.service`, which share `kf-backup` because they need exactly the same secrets
and the same archive. Command-local API/web listener settings prevent an environment file
widening loopback binds.

The two private keys are each owned mode `0600` by the single identity that uses them:
`/etc/kf/checkpoint/checkpoint-key` by `kf-checkpoint`, `/etc/kf/backup/preservation-manifest-key`
by `kf-backup`. No other identity — application or scheduled — can read either. Host must prove
denial after install.

This is stricter than it was. Until 2026-08-17 all five scheduled units ran as a shared `kf`,
so both signing keys were readable by the backup, offsite, readiness and restore-drill jobs.
`kf-commissioning` now refuses any host where units sharing an identity do not need the same
secrets, which is the property that failure violated and that comparing only the API against
the checkpoint signer could never have caught.

`kf-migrate.service` is manual oneshot with no install target. It checks exact release tree,
pinned dbmate version and matching disposable-cluster rollback receipt before reading production
credential. Application start/restart never runs migrations.

## Scheduled operations

Five things have to happen on a schedule, and until they are scheduled they are habits:

| Unit                        | Interval          | What stops being true without it                                                           |
| --------------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `kf-checkpoint.timer`       | hourly            | The audit log is unsigned past the last run. A rewrite inside that window is undetectable. |
| `kf-backup.timer`           | daily 02:00       | Everything exists in one place.                                                            |
| `kf-backup-offsite.service` | after each backup | The copy is beside the original; a lost host loses both.                                   |
| `kf-restore-drill.timer`    | monthly           | Nothing has proven the backups can be read.                                                |
| `kf-readiness.timer`        | every 15 min      | Nothing notices when any of the above stops running.                                       |
| `kf-alert-heartbeat.timer`  | daily             | Nothing notices when the thing that notices stops working.                                 |

The last two are what make the others real. A backup timer that silently stops is
indistinguishable from a backup timer that is working, right up until the restore — unless
something is checking, and something is failing when the check fails.

And that check reports through `kf-alert@`, which is why the heartbeat exists. A failed alert
is visible on the host in `systemctl --failed`; an alert path that has quietly stopped working
is visible nowhere. The daily ping means the RECEIVER can alert on silence, which is the only
way to catch an alerter that cannot report its own death.

Enable both: `systemctl enable --now kf-alert-heartbeat.timer`. `kf-alert@.service` is a
template pulled in by `OnFailure=` and is never enabled directly.

## Install

Do not enable units until `/opt/kf` points at verified release, identities and owner-only files
exist, migration rehearsal/application succeeded, recovery objective is declared, off-site
destination drop-ins are set and working `kf-alert@.service` reaches person. Repository does not
provide alert unit.

```sh
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kf-api
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kf-web
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kf-worker
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kf-migrator

sudo install -d -m 0755 -o root -g root /etc/kf
sudo install -d -m 0750 -o root -g kf-api /etc/kf/api
sudo install -d -m 0750 -o root -g kf-web /etc/kf/web
sudo install -d -m 0750 -o root -g kf-worker /etc/kf/worker
sudo install -d -m 0750 -o root -g kf-migrator /etc/kf/migrator
sudo install -d -m 0700 -o kf-worker -g kf-worker /var/lib/kf-worker
sudo install -d -m 0700 -o kf-migrator -g kf-migrator /var/lib/kf-migrator

sudo install -m 0640 -o root -g kf-api api.env.example /etc/kf/api.env
sudo install -m 0640 -o root -g kf-web web.env.example /etc/kf/web.env
sudo install -m 0640 -o root -g kf-worker worker.env.example /etc/kf/worker.env
sudo install -m 0640 -o root -g kf-migrator migrator.env.example /etc/kf/migrator.env
sudo install -m 0640 -o root -g kf-backup backup.env.example /etc/kf/backup.env

sudo install -m 0600 -o kf-api -g kf-api /dev/null /etc/kf/api/database-url
sudo install -m 0600 -o kf-api -g kf-api /dev/null /etc/kf/api/s3-secret-access-key
sudo install -m 0600 -o kf-web -g kf-web /dev/null /etc/kf/web/session-key
sudo install -m 0600 -o kf-worker -g kf-worker /dev/null /etc/kf/worker/database-url
sudo install -m 0600 -o kf-worker -g kf-worker /dev/null /etc/kf/worker/s3-secret-access-key
sudo install -m 0600 -o kf-migrator -g kf-migrator /dev/null /etc/kf/migrator/database-url

# Scheduled-operation identities: one per set of secrets, not one shared `kf`. Until
# 2026-08-17 all five scheduled units ran as `kf`, which made the checkpoint signing key and
# the preservation signing key readable by every one of them — including kf-backup-offsite,
# whose job is moving bytes to another machine. kf-backup and kf-restore-drill share
# `kf-backup` deliberately: they need exactly the same secrets and the same archive.
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kf-checkpoint
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kf-backup
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kf-offsite
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kf-readiness

sudo install -d -m 0750 -o root -g kf-checkpoint /etc/kf/checkpoint
sudo install -d -m 0750 -o root -g kf-backup /etc/kf/backup
sudo install -d -m 0750 -o root -g kf-offsite /etc/kf/offsite
sudo install -d -m 0750 -o root -g kf-readiness /etc/kf/readiness

sudo install -m 0600 -o kf-checkpoint -g kf-checkpoint /dev/null /etc/kf/checkpoint/database-url
sudo install -m 0600 -o kf-checkpoint -g kf-checkpoint /dev/null /etc/kf/checkpoint/checkpoint-key
sudo install -m 0600 -o kf-backup -g kf-backup /dev/null /etc/kf/backup/database-url
sudo install -m 0600 -o kf-backup -g kf-backup /dev/null /etc/kf/backup/preservation-manifest-key
sudo install -m 0600 -o kf-offsite -g kf-offsite /dev/null /etc/kf/offsite/database-url
sudo install -m 0600 -o kf-readiness -g kf-readiness /dev/null /etc/kf/readiness/database-url

# The alerter. Its own identity holding exactly one secret — the webhook URL — and no key,
# no database credential. Every other unit routes OnFailure= here, so it must be the least
# privileged thing on the host, not the most.
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kf-alert
sudo install -d -m 0750 -o root -g kf-alert /etc/kf/alert
# The URL is a credential: whoever holds it can forge alerts from this deployment. Must be
# https:// — the dispatcher refuses cleartext rather than announcing which host is in trouble
# to anyone on the path.
sudo install -m 0600 -o kf-alert -g kf-alert /dev/null /etc/kf/alert/webhook-url

# Public trust material, read by the backup and restore-drill jobs. Public, so a shared group
# is fine here in a way it is not for a signing key.
sudo install -d -m 0750 -o root -g kf-backup /etc/kf/preservation-trust.d
sudo install -d -m 0750 -o root -g kf-backup /etc/kf/checkpoint-public-keys

# The archive: written by kf-backup, read by kf-offsite to ship it. Setgid so new archives stay
# group-readable. Its contents are signed artifacts, not keys — kf-offsite holds no key at all.
sudo groupadd --system kf-archive
sudo usermod -aG kf-archive kf-backup
sudo usermod -aG kf-archive kf-offsite
sudo install -d -m 2750 -o kf-backup -g kf-archive /srv/kf-backups
sudo install -d -m 0755 -o root -g root /usr/local/libexec
# Install reviewed federation-specific verifier as root-owned mode 0755:
# /usr/local/libexec/kf-verify-object-store

sudo install -m 0644 -o root -g root *.service *.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

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

Database restoration is only one proof dimension. Restore service also requires root-owned
`/usr/local/libexec/kf-verify-object-store`; adapter receives authenticated export directory
and a proof-output path, re-reads every external object named by registry, verifies each digest,
then writes bounded evidence. `KF_OBJECT_STORE_PROOF_REF` names external custody evidence without
credentials. Database, checkpoint, and object-store results land separately in
`ops.restore_drill`; only all three may use outcome `verified`. Missing adapter/key evidence is
recorded `partial`, returns nonzero, and keeps readiness red. Adapter implementation remains a
federation deployment choice—repository must not invent PHI storage credentials or proof.

Run migration procedure in private-host guide. Only after it and real-provider preflight pass:

```sh
sudo systemctl enable --now kf-api.service kf-worker.service kf-web.service
sudo systemctl enable --now kf-checkpoint.timer kf-backup.timer \
  kf-restore-drill.timer kf-readiness.timer
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

Each unit has `OnFailure=kf-alert@%n.service`. Write that unit for whatever this deployment
uses to reach a person — there is no default here, because a default that goes nowhere is
worse than an absent one that fails to start.

A timer whose service fails stays failed until it is looked at; `systemctl list-units --failed`
is the query. `kf-readiness` exits non-zero on **degraded** as well as failed, so a stale index
or a lapsed drill surfaces before it becomes the reason a restore does not work.

## Ordering

`kf-backup-offsite.service` is `Requires=`+`After=` the backup and pulled in by
`Wants=` from it, so the copy runs when a backup completes rather than on a clock of its own.
A copy on a separate schedule copies whatever happens to be there, including nothing.

The restore drill picks the most recent backup that has an off-site copy, restores it into a
scratch database, and drops it afterwards. It records the drill against the **production**
ledger — a drill recorded in the scratch database is discarded along with it.
