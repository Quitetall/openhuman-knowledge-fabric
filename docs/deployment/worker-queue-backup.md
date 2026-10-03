# Worker-owned queue backup access

The Graphile queue is operational state owned by the ordinary worker database
login, not by the KF migration owner. It must still be included in a complete
backup. Moving its ownership to the migrator, forcing its row security, granting
the worker `BYPASSRLS`, or leaving queue rows out of the dump is not a remedy.

## Owner handoff before upgrading an existing host

First verify the new release against its reviewed manifest using
[`migrate-release.sh check`](../../scripts/deploy/migrate-release.sh). Preserve and
restore the old host baseline, including ownership and grants, into an isolated
target. Stop runners on that target. As its actual ordinary queue owner, invoke
the **candidate** release's queue helper before applying KF migrations:

```sh
cd /
sudo -u kf-worker env NODE_ENV=production \
  DATABASE_URL_FILE=/path/to/worker-owned/isolated-database-url \
  /usr/bin/node /path/to/verified-release/apps/worker/dist/queue-backup-cli.js
```

The URL file must be readable by that service identity and private to its owner.
Use the isolated target's ordinary worker login, not the migrator or a superuser.
Do not copy a production password into the rehearsal target. The command accepts
no arguments; it exits nonzero with `worker_queue_backup_refused` on failure and
does not log a provider error or credential. It does not start a runner, execute
KF migrations, or promote an application release. `WORKER_DATABASE_URL_FILE`,
if configured, takes precedence over `DATABASE_URL_FILE`, exactly as at startup;
a rejected worker credential never falls back to the other login.

[`prepareWorkerQueue`](../../apps/worker/src/queue-backup.ts) runs the library's
own queue migrations, then atomically grants `kf_backup` schema usage, table and
sequence reads, and full SELECT policies on the queue's RLS-enabled tables.
Repeated calls reconcile the same contract. It refuses unexpected relation or
routine ownership, definer functions, forced queue RLS, backup membership in the
owner role, backup schema creation or write/maintenance privileges (including
column grants), and applicable restrictive read policies. It does not remove
unexpected grants or policies. Refusal requires inspection, not a retry with
more authority. Library migration and subsequent backup provisioning are separate
transactions; a refusal is not a promise that library migration did not run.

The KF migration
[`20260925130000`](../../database/migrations/20260925130000_the_backup_login_reaches_every_schema.sql)
requires that queue read contract before upgrading a host where the queue already
exists. It excludes exactly `graphile_worker` from its own sequence-grant loop;
other schemas do not gain a silent exemption. On a new database with no queue,
KF migrations run first to create `kf_backup`; worker startup subsequently calls
the same owner interface before launching runners and the outbox loop.

After commissioning, compare ownership and RLS flags against the preserved
baseline; they must remain unchanged. Queue ACLs and SELECT policies intentionally
gain the declared backup access, so claiming an unchanged ACL inventory would be
wrong. Prove that the backup login can read every queue table and sequence but
cannot enqueue or increment a sequence, and that the ordinary worker can still
enqueue. Then take and restore the actual backup and verify the job payload.
Only after the isolated upgrade succeeds should the reviewed host-upgrade
procedure perform the same owner handoff on the live host under its maintenance
and preservation controls. A successful helper does not authorize that cutover.

## Evidence boundary

[`queue-backup.database.test.ts`](../../apps/worker/src/queue-backup.database.test.ts)
uses the real Graphile library with separate ordinary worker, KF owner and backup
logins. It tests migration refusal before provisioning, idempotent owner
provisioning, owner preservation, read access, denied writes, and fail-closed
unexpected policies/routines/grants. The complete
[`backup-and-restore drill`](../../tests/backup-restore/drill.test.ts) now includes
a real worker-owned job and verifies its payload after the shipped backup and
restore scripts run through a backup-only login.

These fixtures prove the implementation seam, not the existing VM's upgraded
state, off-site recovery, commissioning, qualification or human acceptance.
Changed migration bytes require a new sealed release, a fresh authenticated
rehearsal receipt and a restored-baseline upgrade using the real service roles.
