# Runbook

Written for someone who did not build this and is reading it at an inconvenient hour. Each
entry says what the symptom means, what it does **not** mean, and what to do.

The single most useful command:

```
DATABASE_URL=... node packages/operations/dist/cli.js
```

Exit 0 only if every check is `ok`. **Degraded exits non-zero too** — a scheduled check that
exits 0 while something is wrong is worse than no check, because it is believed.

---

## `audit_chain` FAILED

**The serious one.** Audit events no longer link to their predecessors.

**What it means.** Either the audit table was written to outside the dispatcher, or somebody
edited history. It does **not** mean the system is down — it means the record is no longer
trustworthy, which is worse.

**Do not** restart anything, and do not "fix" the chain. A relinked chain is an altered chain.

1. Stop writes. `revoke insert on core.audit_event from kf_app;`
2. Find where: `node apps/checkpoint/dist/main.js --verify` names the failing `seq`.
3. Establish what the truth was, from the last **signed** checkpoint that still verifies. The
   signature is the only thing here that a database administrator cannot forge.
4. Restore from the most recent backup whose export re-verifies, then re-apply the actions
   that happened after it — from the export, not from memory.
5. Record what happened as a nonconformity. This is exactly the kind of event a QMS exists to
   capture, and it will be asked about.

## `checkpoint_coverage` FAILED — no checkpoint has ever been signed

The log is unsigned end to end. A rewrite would be undetectable to anyone without an older
copy.

```
CHECKPOINT_SIGNING_KEY_PATH=... DATABASE_URL=... node apps/checkpoint/dist/main.js --run
```

If this is a new deployment, this is expected until the first run — and the check is right to
call it a failure rather than a warning, because "we have not started signing yet" and "we
stopped signing" look identical from outside.

## `checkpoint_coverage` degraded — a tail is uncovered

Normal between runs. Becomes a problem when the tail stops shrinking: that means the signer is
not running, and the window in which a rewrite is undetectable is growing.

Check the signer's schedule before running one by hand — an operator who signs manually every
morning has replaced a control with a habit.

## `write_guards` FAILED

One or more of the three triggers on `core.object` is missing. **Controlled records can be
changed without an action.**

Somebody dropped it deliberately, or a migration was applied that did not restore it. Both are
serious; the first is more so.

1. Reinstate from `20260811000800_write_guards.sql`.
2. Check what changed while it was off: `core.object.updated_at` newer than the object's last
   audit event is the signature of a write that bypassed the dispatcher.

## `outbox_delivery` degraded

Delivery is behind. **No record is wrong** — derived indexes are stale, that is all. Do not
treat it as an outage.

1. Is the worker running?
2. Drain by hand if needed; it is idempotent and safe to run repeatedly.
3. If rows keep failing, the handler is throwing. The row stays pending on purpose, so the
   backlog grows visibly rather than the work disappearing.

## `search_index` degraded

Records exist that search cannot find. Nothing is lost; the index is derived.

```sql
select search.rebuild();
```

Expected after: a restore, a bulk import, or bootstrap records created before any action
existed to create them.

## `backup_freshness` FAILED — no recovery objective

Nobody has declared how much work this organization can afford to lose, so no backup schedule
can be called sufficient or insufficient. This is a decision, not a setting — see
[`deploy/systemd/README.md`](../../deploy/systemd/README.md) for the insert and what the
numbers mean.

## `backup_freshness` FAILED — the newest backup is older than the objective

Either the schedule is not running, or the objective is one nobody intends to meet. **Both are
worth knowing, and they have different fixes.**

1. `systemctl list-timers kf-backup.timer` — when did it last run, when does it run next?
2. `journalctl -u kf-backup.service -n 50` — did it fail, or did it never start?
3. If the schedule is fine and the objective is wrong, declare a NEW objective. Do not edit
   the existing row; the append-only trigger will refuse, and it is right to. Widening a target
   to match what you are achieving is a decision, and it should look like one.

## `backup_freshness` degraded — not off-site

The backup is current and sits beside the database it came from. That survives a dropped table
and not a lost host.

```
scripts/backup-offsite.sh /srv/kf-backups/<newest> <destination> <label>
```

If `kf-backup-offsite.service` is configured and this keeps recurring, the destination is
probably unreachable — `journalctl -u kf-backup-offsite.service`.

## `backup_freshness` degraded — never restored, or the drill has lapsed

**A backup is not valid until it has been restored.** Until then it is a hope with a digest.

```
systemctl start kf-restore-drill.service      # or: scripts/restore-drill.sh
```

The drill restores into a scratch database, compares a fresh export against the one taken at
backup time, records the result against the production ledger, and drops the scratch database.
Recording it anywhere else discards the evidence along with the database.

## `backup_freshness` FAILED — the most recent drill FAILED

An earlier drill succeeded and this one did not, so **something changed between them**. The row
stays; do not re-run and hope.

1. `journalctl -u kf-restore-drill.service` — where did `restore-verify.sh` stop? A digest
   mismatch, a `pg_restore` error and an export diff mean three different things.
2. An export diff means the backup does not contain what it claims to. That is a T5 event, not
   a maintenance task.
3. Check what changed: a schema migration, a PostgreSQL version, a tool chain.

## `pitr_readiness` FAILED

The declared objective requires continuous archiving and the server is not doing it — or is
failing at it, which is worse, because it looks configured.

- `archive_mode is off`: see [`deploy/postgres/pitr.conf`](../../deploy/postgres/pitr.conf).
  `archive_mode` needs a **restart**, not a reload.
- `most recent attempt FAILED`: WAL is accumulating in `pg_wal` and will fill the volume. When
  it does, PostgreSQL stops accepting writes. `select * from pg_stat_archiver` and check the
  archive destination has space and permissions.

Either fix the server or declare an objective that says PITR is not required. The second is a
legitimate decision — it means the recovery point is the backup interval — and it has to be
made deliberately rather than by leaving a check red.

## `federation_freshness` degraded

Citations of `openhuman-quality` or `LamQuant` have not been re-verified recently. Drift in
another system would not yet have been noticed.

Run a drift check. A **digest mismatch at a pinned commit** is not routine — content cannot
change at a fixed sha, so it means the history was rewritten or the source is not what it
claims to be. Escalate rather than re-record.

## `schema_release` FAILED

The ontology seed never ran. Any record written now would carry a schema version nothing can
resolve.

```
pnpm db:seed
```

If records already exist, find out how — they were written to a database that was not fully
migrated, and that is worth understanding before adding more.

## A readiness check reports `unknown`

The check could not run. **This counts as not ready**, deliberately: the alternative is a
dashboard that turns green when monitoring breaks.

Read the message. It is usually a permission or a missing object, both of which mean something
changed that nobody recorded.

---

## Restoring

```
scripts/restore-verify.sh <backup-directory> <target-database-url>
```

It refuses a target that already has a `core` schema, checks digests before writing anything,
and re-exports afterwards to diff against the backup. **A backup is not valid until it has
been restored** — if this has not been run against a given backup, that backup is a hope.

Remember the object store. The database holds artifact digests, not bytes; restoring one
without the other gives you a catalogue of things you no longer have.

## Rotating the checkpoint signing key

Old checkpoints stay valid under the old public key, which must be **kept forever** — a
checkpoint whose key has been discarded is unverifiable, and unverifiable is not the same as
valid.

1. Generate the new key where the API cannot reach it.
2. Publish the new public key alongside the old.
3. Point the signer at the new key; the next checkpoint uses it.
4. Verification supplies both keys. `unknown_key` is a finding, never a pass.

## Linking a person to an identity provider account

Nothing is auto-provisioned. A valid token for somebody nobody has linked is refused, because
the actor list is who can be held responsible and it should not grow because a provider
accepted a login.

Linking is a recorded decision — `linkIdentity` stores who made it. Revoking is immediate:
`revokeIdentity` sets `revoked_at`, and the next request with an already-issued token is
refused rather than waiting for it to expire. The row stays; who used to be able to sign in as
whom is a fact an investigation needs.

A person who holds several roles states which one they are acting under per request. This is
not a default the system can pick — choosing decides an authority question on their behalf,
and the audit trail would record a role they never selected.

## Step-up: somebody cannot approve a payment

They will have had a 401 with `step_up_required` and a `www-authenticate` header. This is not
an authorization problem and adding a role will not fix it: twelve actions — the ones that move
money, release a product, or withdraw a control — require an authentication no older than
fifteen minutes, and two of them require a real second factor.

The fix is to sign in again. Their client should be sending them back to the provider with
`max_age`; if it is not, that is a client bug and the header says so.

`authentication_age_unknown` means the provider is not issuing `auth_time` at all. That is a
provider configuration item, and until it is fixed **nobody can perform those twelve actions** —
which is the intended direction, because a session whose age cannot be established is not one
to authorize a payment on.

## The API will not start

- `KF_TLS_TERMINATED_UPSTREAM` — this process serves plain HTTP and refuses to run in staging
  or production unless the deployment asserts that something in front of it terminates TLS. If
  that assertion would be false, do not set it; fix the proxy.
- `DATABASE_URL was supplied inline` — outside development the credential must arrive as
  `DATABASE_URL_FILE`. An environment variable is readable from `/proc/<pid>/environ` by
  anything running as the same user.
- `is mode 644 — a secret readable beyond its owner` — `chmod 600`. Refused rather than warned,
  because a warning at startup is read once, on the day it is added.

## What is NOT covered here

- **Token lifetime and refresh policy.** Provider configuration, not held in this repository.
- **TLS certificates.** Issued and renewed at the proxy. This application refuses to run
  without the deployment asserting that a proxy is there, and can do nothing to verify it.
- **`kf-alert@`.** Every scheduled unit declares `OnFailure=kf-alert@%n.service`; writing it
  for whatever reaches a person here is an open item. There is no default, deliberately — a
  default that goes nowhere is worse than an absent one that fails to start.
- **Object store backups.** The database holds digests, not bytes. Back up the bucket on the
  same schedule, or a restore returns a catalogue of things you no longer have.

See the [threat model](../threat-model/) for the full list of open items.
