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
scripts/backup-offsite.sh /srv/kf-backups/<newest> <destination> <label> [--separate-domain <ref>]
```

A LOCAL destination is recorded as not off-site (`offsite_basis = local-unattested`) unless a
person has approved its failure domain in `ops.physical_failure_domain_evidence` and the copy
names it with `--separate-domain` (or `KF_OFFSITE_FAILURE_DOMAIN` in `/etc/kf/offsite.env`). A
second disk in the same machine is the same host; that is the check working. Look at
`select destination_label, offsite, offsite_basis from ops.backup_copy order by copied_at desc`.

If `kf-backup-offsite.service` is configured and this keeps recurring, the destination is
probably unreachable — `journalctl -u kf-backup-offsite.service`. A unit that fails before
copying anything says why in its first line: an empty `KF_OFFSITE_DESTINATION`, or a local
destination missing from `ReadWritePaths=`.

## `backup_freshness` degraded — never restored, or the drill has lapsed

**A backup is not valid until it has been restored.** Until then it is a hope with a digest.

```
systemctl start kf-restore-drill.service      # or: scripts/restore-drill.sh
```

The drill pulls the newest off-site copy back from `KF_DRILL_OFFSITE_SOURCE`, refuses it
unless its digest is the ciphertext the ledger recorded as sent, decrypts it with the sealed
`backup-decryption-key` credential, and restores THAT — not the local original — into a
throwaway PostgreSQL cluster it starts on a private Unix socket and its own port under
`/var/lib/kf-restore-drill`. It compares a fresh export, verifies historical checkpoints, invokes
the configured object-store verifier, records all three proof dimensions against the production
ledger with `notes` naming which copy was restored, then deletes the cluster. Nothing is created
in the production cluster.

If the off-site copy cannot be pulled back (source unset, a pre-encryption copy, no decryption
key) the drill refuses. `scripts/restore-drill.sh` with `--allow-local-fallback` restores the local
original instead and records `notes = source=local-fallback ...`, so it never reads as an
off-site drill.

## `backup_freshness` FAILED — latest restore is PARTIAL

Database round-trip passed, but checkpoint trust or external object bytes were not proven.
Read named missing dimensions in readiness output and restore journal. For object bytes, fill
`/etc/kf/drill.env` and `/etc/kf/drill/s3-secret-access-key` for the release's own verifier
(`sudo /opt/kf/scripts/deploy/provision-host.sh --check` names what is missing), or configure a
reviewed, digest-pinned `KF_OBJECT_STORE_VERIFY_PROGRAM` override; for checkpoint trust, restore
authenticated checkpoint public-key history. Never relabel partial row as verified;
rerun drill after missing substrate is available.
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

The check could not run. **This makes its named service or institutional partition not ready**,
deliberately: the alternative is a dashboard that turns green when monitoring breaks. One broken
check keeps its own ID and does not erase or contaminate evidence from the other partition.

Read the message. It is usually a permission or a missing object, both of which mean something
changed that nobody recorded.

The message is in the full report, which `GET /readiness` gives only to a direct loopback
connection (`curl http://127.0.0.1:4000/readiness` on the host) or to a caller sending
`X-KF-Readiness-Token` (the value of `KF_READINESS_TOKEN_FILE`, at least 32 bytes). Everyone
else, including anything arriving through nginx, gets `{"ready": …}` and nothing more; nginx
refuses `/readiness` from off-host outright. The report is assessed at most once per 10 seconds
and shared by concurrent callers, so a response can be that old. `kf-readiness.service` runs
the assessment directly and is unaffected.

---

## `kf-readiness` failed on timer liveness — a timer is not firing

`kf-readiness.service` also runs `scripts/timer-liveness.sh`, which asks systemd when each
shipped `kf-*.timer` last fired and fails, naming it, when one is inactive or has been silent
longer than the `X-KF-MaxSilenceSec=` its own file declares. A stopped or never-enabled timer
fails nothing by itself — its service just stops running — so this is where that absence
becomes an alert.

```
journalctl -u kf-readiness.service -n 30      # which timer, and how long silent
systemctl list-timers 'kf-*'
systemctl enable --now <timer>                # if it was stopped or never enabled
```

The readiness timer cannot report its own stop. `kf-alert-heartbeat.service` runs the same check
for `kf-readiness.timer` first and withholds the daily heartbeat while it is not firing, so the
receiver's missing-heartbeat rule is what notices.

---

## Restoring

```
scripts/restore-verify.sh <backup-directory> <owner-only-target-url-file> \
  [owner-only-production-ledger-url-file]
```

It first verifies signed `backup.manifest.json` against external historical trust, including
closed regular-file set and exact bytes for `roles.sql` and `dump.pgcustom`. Only then does it
stream those verified bytes into a private staging tree. It refuses a target that already has a
`core` schema, then executes roles and restores only from staged paths before re-exporting to diff
against backup, verifies checkpoint trust, and invokes external object-store adapter. Recomputed
`SHA256SUMS` or a post-verification source-path swap cannot authorize changed SQL or dump bytes.
Only database + checkpoint + object-store proofs produce `verified`; missing dimensions record
`partial` and exit nonzero. **A backup is not valid until all three have been restored.**

Connection strings must be stored in mode `0600` files. Never put a URL containing credentials
on the command line; it is visible in `/proc/<pid>/cmdline` before script code can sanitize it.

Remember the object store. The database holds artifact digests, not bytes; restoring one
without the other gives you a catalogue of things you no longer have.

## Rotating the checkpoint signing key

Old checkpoints stay valid under the old public key, which must be **kept forever** — a
checkpoint whose key has been discarded is unverifiable, and unverifiable is not the same as
valid.

1. Generate the new key where the API cannot reach it.
2. Write the new public key to the external append-only trust directory as
   `<CHECKPOINT_SIGNING_KEY_ID>.pub`. Keep every prior file; never place private keys there.
3. Set a NEW `CHECKPOINT_SIGNING_KEY_ID` in `/etc/kf/checkpoint.env` and point the signer at
   the new key; the next checkpoint uses it. Never reuse an id for a different key: `--run`
   refuses when `<id>.pub` is missing or is not the public half of the configured private key.
4. Set `CHECKPOINT_PUBLIC_KEY_DIR` for verification. It loads every regular `*.pub` file by
   signing-key id, refuses symlinks and non-Ed25519 keys, and reports `unknown_key` for any
   checkpoint whose historical key is absent.

Back up this directory with authenticated preservation metadata, independently of PostgreSQL.
Database contents are not a trust root: an administrator capable of rewriting the ledger must
not also be able to replace verification keys unnoticed.

## Linking a person to an identity provider account

Nothing is auto-provisioned. A valid token for somebody nobody has linked is refused, because
the actor list is who can be held responsible and it should not grow because a provider
accepted a login.

Linking is a recorded decision — `linkIdentity` stores who made it. The application login cannot
make it: since `20260923000200` `kf_app` holds no `INSERT` or `UPDATE` on `org.external_identity`,
so the one supported way to link is `pnpm kf:grant-authority`, run over the owner connection
(`DATABASE_OWNER_URL`), which links the identity, assigns the role and grants the clearance in one
transaction (see [`identity-and-login.md`](../deployment/identity-and-login.md)). Revoking is
immediate: `revokeIdentity` sets `revoked_at` — again over the owner connection; there is no
command for it yet — and the next request with an already-issued token is refused rather than
waiting for it to expire. The row stays; who used to be able to sign in as whom is a fact an
investigation needs.

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

## An act is refused: `act_not_granted`

The actor holds a role, but no live `act` grant reaches the target — or the actor is a service
actor, which never performs an institutional act (ADR 0020). The institutional acts are the
action types that declare `requires: act` in `ontology/action-types.yaml`: authorizing,
approving, accepting, issuing, making effective.

Adding a role fixes it only if the role assignment is scoped to the organization or to the
target. Otherwise the fix is a `grant_access` act with `capability: act` at the target's scope
(or the organization's), performed by somebody entitled to grant it. `explainAccess` says
which grants reach a person and why the others do not.

Since `20260924000100` the database makes the same decision the dispatcher does, on the ledger
row itself. The dispatcher still refuses first, with this error. A refusal that arrives instead
as a database error naming `act authority` means something wrote to `core.action` without going
through the dispatcher. That is not a configuration problem: treat it as an incident (threat
model T2).

## A write is refused: "must be performed by an act" or "not an act this transaction recorded"

Since `20260925020000` every table the application or the worker can write refuses a row that no
recorded act accounts for (threat model T2). The dispatcher always records its act in the same
transaction as the writes, so neither refusal is reachable through it:

- **must be performed by an act, and no action is bound** — something wrote a domain row with no
  action in the transaction context;
- **not an act this transaction recorded for its actor** — the context named an action the
  ledger does not hold, or (for the API) one recorded by an earlier transaction.

Either arriving from the API is not a configuration problem: treat it as an incident, as for an
`act authority` refusal above. From the worker it means a task wrote under an act it did not bind;
the document compiler is the one task that completes an act already recorded.

Five writes are exempt by design, each with its reason in `core.write_guard_exemption` (read it
as the owner): the ledger row itself, its audit event, outbox delivery marks, a federated
reference's `verified_at` (stamped with the database clock), and a shared-link bearer's access
log. `tests/database/write-guards.test.ts` pins that list; a new table the application can write
is guarded by calling `core.install_action_context_guards()` in its migration, or the test names
it.

## A verification is refused: reviewed individually, too fast

`verify_record` with basis `reviewed_individually` is refused when the same person recorded
another individual review less than one second earlier. A person reading records does not
finish two in a second. A script does, and a script's verifications are a bulk promotion
whatever basis it declares (KF-SAS-RQ-231).

Promoting many records at once is legitimate, and it has its own gesture, which stamps the
basis itself:

    POST /verifications/bulk
    body  { recordIds: [...], reason, idempotencyKey, acceptBulk? }

It dispatches one `verify_record` act per record (KF-SAS-RQ-227: one act, one record) with
basis `promoted_in_bulk`, and answers per record: which were applied, and which were refused
and why. It refuses a gesture above the sync ceiling (250 records; `acceptBulk: true` lifts it
to 2,000 and no further). Retrying with the same idempotency key replays rather than repeating.

Somebody who really did read each record, and was refused because two landed in the same
second, can retry the refused one: the pace is one second, not a quota.

## Orphaned evidence bytes were collected

`kf-storage --collect-orphans` deletes evidence bytes that no record references, after a grace
period (a week on the shipped timer). Each deletion is recorded in `content.orphan_collection`
by the same run: the key, the store, the digest the key names, how many object versions were
removed, when, which service actor did it, and why. The table is append-only and is carried in
preservation exports. To answer "where did these bytes go", as the auditor or backup login:

    select collected_at, store_id, storage_key, versions_removed, reason
      from content.orphan_collection
     where storage_key like 'ingest/<org>/%' order by collected_at;

A key the run deleted but could not record is reported as a refusal and the run exits
non-zero: the bytes are gone and the trail is not, which is the one outcome the alert must get
to somebody.

## The API will not start

- `NODE_ENV is required` — there is no default: the API refuses to start when it is unset rather than
  assuming `development`. The shipped unit sets `NODE_ENV=production` on its command line.
- `may listen only on loopback` — the `development` profile trusts identity headers and refuses
  any `HOST` other than loopback. A reachable API uses `KF_DEPLOYMENT_PROFILE=dogfood`.
- `KF_TLS_TERMINATED_UPSTREAM` — this process serves plain HTTP and refuses to run in staging
  or production unless the deployment asserts that something in front of it terminates TLS. If
  that assertion would be false, do not set it; fix the proxy.
- `refusing to serve: database login ...` — the login in `DATABASE_URL_FILE` is a superuser,
  has `BYPASSRLS`, is (or inherits) a table owner, or holds `kf_attestor` or `kf_service_actor`.
  Row-level security or attestation would not bind it. Almost always the migrator's or the
  attestor's URL in the API's file; supply a login that inherits `kf_app` and nothing more.
- `KF_ATTESTOR_SOCKET is required` — the `dogfood` profile binds a person only on an attestation
  from `kf-attestor`. The shipped unit sets it; under systemd the start instead fails at
  `kf-attestor socket /run/kf-attestor/attestor.sock is absent` when the attestor is not running
  — start `kf-attestor.service` first (see below).
- `DATABASE_URL was supplied inline` — outside development the credential must arrive as
  `DATABASE_URL_FILE`. An environment variable is readable from `/proc/<pid>/environ` by
  anything running as the same user.
- `is mode 644 — a secret readable beyond its owner` — `chmod 600`. Refused rather than warned,
  because a warning at startup is read once, on the day it is added.

## Requests refused `not_attested`, or 401 for everybody

The database binds a person for the API's login only on an attestation from `kf-attestor`
(`20260924001000`). An act refused `not_attested` ("nobody attested that the actor is present")
reached the database without one: the caller should identify again. When every bearer request
fails at once, the attestor is the first suspect — `GET /ready` reports `attestor: failing` while
the API cannot reach it on its socket. Check `systemctl status kf-attestor.service` and its journal:
it refuses to start through a login that is not in `kf_attestor` or that is also in `kf_app` or
`kf_worker`, and it needs `/etc/kf/attestor/database-url` and the same `OIDC_*` values as the API
in `/etc/kf/attestor.env`. After a crash loop it stays `failed` until `systemctl reset-failed
kf-attestor.service`. `kf-commissioning`'s `attestor_separation` check says whether the socket and
secrets are still separated from everyone but `kf-api`.

## What is NOT covered here

- **Token lifetime and refresh policy.** Provider configuration. The workstation realm
  (`deploy/keycloak/knowledge-fabric-realm.json`) ships a 300-second access-token lifespan, and
  `kf-commissioning`'s `identity_provider_policy` refuses a host realm with offline sessions idle
  beyond 7 days or unbounded past 30, or refresh tokens that are not revoked on use. The host's
  own access-token lifespan is still its reviewed configuration, not checked here.
- **TLS certificates.** Issued and renewed at the proxy. This application refuses to run
  without the deployment asserting that a proxy is there, and can do nothing to verify it.
- **Where alerts go.** `kf-alert@.service` ships: every unit's `OnFailure=` reaches it, and it
  posts to the `https://` webhook in `/etc/kf/alert/webhook-url`. Which receiver that is — and
  its rule to alert when the daily heartbeat stops arriving — is the deployment's to supply.
- **Object store backups.** The database holds digests, not bytes. Back up the bucket on the
  same schedule, or a restore returns a catalogue of things you no longer have.

See the [threat model](../threat-model/) for the full list of open items.
