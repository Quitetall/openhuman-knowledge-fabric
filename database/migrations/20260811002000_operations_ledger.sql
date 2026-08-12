-- migrate:up

-- Preservation, as a record rather than a habit.
--
-- Everything else in Gate 8 is checkable from inside the database: a trigger is present or it
-- is not, the chain links or it does not. Backups are not. The evidence that a backup was
-- taken lives on some other filesystem, and the evidence that it can be RESTORED does not
-- exist at all until somebody restores it.
--
-- So the backup scripts write here, and readiness reads it. That turns three claims that were
-- previously prose in a runbook into things the system can be wrong about out loud:
--
--   1. a backup was taken recently enough to meet a STATED recovery objective
--   2. that objective was stated by a named person, with a reason
--   3. a backup was actually restored, recently enough to still mean something
--
-- The second one is the load-bearing one. "Back up nightly" is not an objective; it is an
-- activity. An objective says how much work the organization has decided it can afford to
-- lose, and until somebody has decided that, no schedule can be called sufficient or
-- insufficient — which is why an undeclared objective is a FAILURE here and not a default.

create schema if not exists ops;

grant usage on schema ops to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;

-- ---------------------------------------------------------------------------------------
-- What the organization has decided it can afford to lose.
-- ---------------------------------------------------------------------------------------

create table ops.recovery_objective (
  id uuid primary key default uuidv7(),
  -- How much work may be lost, in seconds. A backup older than this is a failure, not a
  -- warning: the deployment has already said this much loss is unacceptable.
  rpo_seconds integer not null check (rpo_seconds > 0),
  -- How often the restore drill must be repeated. A backup verified two years ago was
  -- verified against a schema and a tool chain that no longer exist.
  restore_drill_days integer not null check (restore_drill_days > 0),
  -- Whether continuous WAL archiving is required. An RPO shorter than the backup interval
  -- cannot be met without it, and saying so here lets readiness check the server settings
  -- against the decision rather than against an assumption.
  requires_pitr boolean not null,
  declared_by uuid not null references org.person (id),
  declared_at timestamptz not null default now(),
  -- Why this number. An RPO with no rationale gets revised by whoever finds it inconvenient.
  rationale text not null check (length(btrim(rationale)) >= 20)
);

-- Superseded by writing a new row, never by editing this one. What the objective USED to be
-- is the question an investigation asks after a loss, and an updated row cannot answer it.
create trigger recovery_objective_append_only
  after update or delete or truncate on ops.recovery_objective
  for each statement execute function core.refuse_mutation();

comment on table ops.recovery_objective is
  'Declared recovery objective. Append-only; the current objective is the most recently '
  'declared row. Readiness FAILS when none exists — an undeclared objective means no '
  'schedule can be called sufficient.';

-- ---------------------------------------------------------------------------------------
-- Backups that were actually taken.
-- ---------------------------------------------------------------------------------------

create table ops.backup_run (
  id uuid primary key default uuidv7(),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  kind text not null check (kind in ('logical', 'base')),
  -- Where it went. Unique, because recording the same directory twice would make a stale
  -- backup look fresh by re-announcing it.
  location text not null unique,
  -- The digest OF the manifest, not of the dump: it is what `sha256sum -c SHA256SUMS`
  -- checks, so it covers every file in the backup including the canonical export.
  manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size > 0),
  -- Which database this is a backup OF. A ledger that cannot distinguish production from a
  -- staging rehearsal reports a green light for the wrong system.
  database_name text not null,
  recorded_at timestamptz not null default now(),
  constraint backup_run_ends_after_it_starts check (finished_at >= started_at)
);

create index backup_run_recent on ops.backup_run (finished_at desc);

create trigger backup_run_append_only
  after update or delete or truncate on ops.backup_run
  for each statement execute function core.refuse_mutation();

comment on table ops.backup_run is
  'One row per completed backup, written by scripts/backup.sh. Append-only: a backup that '
  'happened cannot stop having happened.';

-- ---------------------------------------------------------------------------------------
-- Copies of a backup that reached somewhere else.
-- ---------------------------------------------------------------------------------------

-- A separate table rather than an `offsite` flag on backup_run, because taking a backup and
-- moving it somewhere else are two events that happen at different times and can fail
-- independently — and because backup_run is append-only, so a flag set at insert time could
-- never be corrected once the copy actually landed.
create table ops.backup_copy (
  id uuid primary key default uuidv7(),
  backup_run_id uuid not null references ops.backup_run (id),
  -- A name, not a URI with credentials in it. Read by every read role in the system.
  destination_label text not null,
  -- Whether this destination is a different failure domain from the database host. A copy on
  -- the same machine survives a dropped table and not a lost host.
  offsite boolean not null,
  copied_at timestamptz not null default now(),
  -- Re-checked on arrival, so a truncated transfer is caught here rather than during a
  -- restore that somebody is attempting under pressure.
  manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  unique (backup_run_id, destination_label)
);

create trigger backup_copy_append_only
  after update or delete or truncate on ops.backup_copy
  for each statement execute function core.refuse_mutation();

comment on table ops.backup_copy is
  'One row per copy of a backup that reached another location. Written by '
  'scripts/backup-offsite.sh after the digest is re-verified at the destination.';

-- ---------------------------------------------------------------------------------------
-- Restores that were actually performed.
-- ---------------------------------------------------------------------------------------

create table ops.restore_drill (
  id uuid primary key default uuidv7(),
  backup_run_id uuid not null references ops.backup_run (id),
  verified_at timestamptz not null default now(),
  -- Where it was restored to. Not the connection string: that carries a password, and this
  -- table is readable by every read role in the system.
  target_label text not null,
  outcome text not null check (outcome in ('verified', 'failed')),
  notes text
);

create index restore_drill_recent on ops.restore_drill (verified_at desc);

-- Failed drills are recorded too, and stay. A drill that failed is the most useful row in
-- this table, and the temptation to delete it and re-run is exactly what append-only is for.
create trigger restore_drill_append_only
  after update or delete or truncate on ops.restore_drill
  for each statement execute function core.refuse_mutation();

comment on table ops.restore_drill is
  'One row per restore drill, written by scripts/restore-verify.sh. A backup is not valid '
  'until it has been restored; this is where that fact is recorded.';

-- ---------------------------------------------------------------------------------------
-- Who may write here.
-- ---------------------------------------------------------------------------------------

-- The backup role writes its own history and nothing else. It cannot read a domain row, and
-- these three tables contain no record content — only digests, sizes and timestamps.
grant insert, select on ops.backup_run, ops.backup_copy, ops.restore_drill to kf_backup;

-- Everyone who can be asked "is this system in order" can read the answer.
grant select on ops.recovery_objective, ops.backup_run, ops.backup_copy, ops.restore_drill
  to kf_app, kf_worker, kf_readonly, kf_auditor;

-- Declaring the objective is an operator decision made once and rarely, through a migration
-- or a psql session as the migrator. Deliberately not grantable to the application: an RPO
-- the API can rewrite is an RPO that will be rewritten to whatever the API is meeting.

-- migrate:down

drop table if exists ops.restore_drill;
drop table if exists ops.backup_copy;
drop table if exists ops.backup_run;
drop table if exists ops.recovery_objective;
drop schema if exists ops;
