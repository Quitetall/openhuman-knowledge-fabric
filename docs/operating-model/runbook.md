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

## What is NOT covered here

- **Identity.** There is no identity provider. Every action today is attributed to a
  development identity and cannot be relied on as a record of who did anything. This is the
  reason the system is not in service.
- **TLS.** Not terminated by this application.
- **Off-site backups and PITR.** The mechanism is proven; the schedule is not built.

See the [threat model](../threat-model/) for the full list of open items.
