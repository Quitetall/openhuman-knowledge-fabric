-- migrate:up

-- The work schema: projects, packages, orders, executions, deliverables, acceptance.
--
-- This is where the six invariants the R01 pack left in prose become things the database
-- refuses. Spec §27.1 is explicit that a rule affecting field validity, lifecycle,
-- permission, calculation, graph relation or release acceptance is NONCONFORMING unless it is
-- represented in the machine package — so "the reviewer will notice" is not an implementation.
--
-- Money is stored as integer MINOR UNITS plus an ISO 4217 code, never as a floating-point
-- number and never as a bare number without its currency. A financial control that compares
-- two amounts has to know they are the same currency before the comparison means anything.

-- ── projects ────────────────────────────────────────────────────────────────────────────

create table work.initiative_project (
  id                uuid primary key references core.object (id) on delete restrict,
  project_code      text unique check (project_code ~ '^[A-Z][A-Z0-9-]{1,31}$'),
  -- What the project is FOR, in the sponsor's words. Separate from `title` because a
  -- one-line title cannot carry an objective, and a project whose objective is unrecorded
  -- cannot be judged complete against anything.
  objective         text not null check (length(btrim(objective)) between 1 and 4000),
  sponsor_id        uuid not null references core.object (id),
  started_on        date,
  target_completion date,

  constraint project_dates_ordered
    check (target_completion is null or started_on is null or target_completion >= started_on)
);

create table work.milestone (
  id            uuid primary key references core.object (id) on delete restrict,
  project_id    uuid not null references work.initiative_project (id) on delete restrict,
  planned_on    date not null,
  achieved_on   date,
  criterion     text not null check (length(btrim(criterion)) between 1 and 2000)
);

create index milestone_by_project on work.milestone (project_id, planned_on);

-- Things that happened to a project which are not themselves controlled objects: a sponsor
-- changed, a scope conversation, a pause. Append-only, because a project history that can be
-- edited is a project history nobody can rely on.
create table work.project_event (
  id            uuid primary key default uuidv7(),
  project_id    uuid not null references work.initiative_project (id) on delete restrict,
  occurred_at   timestamptz not null,
  event_kind    text not null check (event_kind in (
    'scope_discussed', 'sponsor_changed', 'paused', 'resumed', 'risk_raised',
    'dependency_changed', 'note'
  )),
  summary       text not null check (length(btrim(summary)) between 1 and 4000),
  recorded_at   timestamptz not null default now(),
  recorded_by   uuid not null,
  recorded_by_action uuid references core.action (id)
);

create index project_event_by_project on work.project_event (project_id, occurred_at desc);

-- ── work packages ───────────────────────────────────────────────────────────────────────

create table work.work_package (
  id              uuid primary key references core.object (id) on delete restrict,
  project_id      uuid not null references work.initiative_project (id) on delete restrict,
  -- Ordering within the project, for reading and for reporting. Not an identifier.
  sequence_no     integer not null check (sequence_no > 0),
  scope_statement text not null check (length(btrim(scope_statement)) between 1 and 4000),
  -- What "done" means for this package, agreed before work starts. KF-PROJ-001 computes
  -- progress from ACCEPTED packages, which is only meaningful if acceptance had a criterion.
  acceptance_criterion text not null check (length(btrim(acceptance_criterion)) between 1 and 4000),
  planned_value_minor  bigint check (planned_value_minor >= 0),
  currency             char(3) check (currency ~ '^[A-Z]{3}$'),

  unique (project_id, sequence_no),
  -- An amount without a currency is not an amount.
  constraint work_package_value_has_currency
    check ((planned_value_minor is null) = (currency is null))
);

create index work_package_by_project on work.work_package (project_id, sequence_no);

-- ── engagements and work orders ─────────────────────────────────────────────────────────

create table work.work_order (
  id              uuid primary key references core.object (id) on delete restrict,
  -- KF-WORK-002: exactly one project and exactly one engagement. `not null` plus a single
  -- column is the whole enforcement — there is no shape this table can take that references
  -- two projects, which is why it is a column and not a relation row.
  project_id      uuid not null references work.initiative_project (id) on delete restrict,
  engagement_id   uuid not null references org.engagement (id) on delete restrict,
  order_number    text not null unique,
  scope_summary   text not null check (length(btrim(scope_summary)) between 1 and 4000),

  -- The authorized ceiling. KF-FIN-001: accepted value may not exceed this without an
  -- approved amendment, and amendments adjust it additively rather than overwriting it — an
  -- overwritten ceiling destroys the evidence of what was originally authorized.
  ceiling_minor   bigint not null check (ceiling_minor >= 0),
  currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),

  issued_on       date,
  performance_starts_on date,
  performance_ends_on   date,

  constraint work_order_performance_dates_ordered
    check (performance_ends_on is null or performance_starts_on is null
           or performance_ends_on >= performance_starts_on)
);

create index work_order_by_project on work.work_order (project_id);
create index work_order_by_engagement on work.work_order (engagement_id);

-- Which packages an order covers. A typed row rather than an object: it carries no lifecycle
-- of its own and is never independently controlled.
create table work.work_order_scope (
  work_order_id   uuid not null references work.work_order (id) on delete restrict,
  work_package_id uuid not null references work.work_package (id) on delete restrict,
  primary key (work_order_id, work_package_id)
);

-- Ceiling changes, as records rather than edits. §16.3: a change to an authorized figure is a
-- new attributable record, never a silent overwrite.
create table work.work_order_amendment (
  id              uuid primary key references core.object (id) on delete restrict,
  work_order_id   uuid not null references work.work_order (id) on delete restrict,
  amendment_no    integer not null check (amendment_no > 0),
  -- Signed: an amendment may reduce a ceiling as well as raise one.
  ceiling_delta_minor bigint not null,
  currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
  rationale       text not null check (length(btrim(rationale)) between 1 and 4000),
  approved_at     timestamptz,
  approved_by     uuid references core.object (id),

  unique (work_order_id, amendment_no)
);

create index amendment_by_order on work.work_order_amendment (work_order_id, amendment_no);

-- ── deliverables and execution ──────────────────────────────────────────────────────────

create table work.deliverable (
  id              uuid primary key references core.object (id) on delete restrict,
  work_package_id uuid not null references work.work_package (id) on delete restrict,
  deliverable_kind text not null check (deliverable_kind in (
    'document', 'design', 'firmware', 'software', 'hardware', 'test_report',
    'data', 'service', 'other'
  )),
  definition_of_done text not null check (length(btrim(definition_of_done)) between 1 and 4000)
);

create index deliverable_by_package on work.deliverable (work_package_id);

create table work.work_execution (
  id              uuid primary key references core.object (id) on delete restrict,
  -- KF-WORK-001: exactly one work order. Not null, single column, restrict on delete.
  work_order_id   uuid not null references work.work_order (id) on delete restrict,

  -- §13.2 keeps these three distinct, and they genuinely differ today: contractors have
  -- neither repository nor database access, so work is PERFORMED by one person, SUBMITTED by
  -- them via email or a marketplace, and RECORDED here by someone else. Collapsing them
  -- would attribute a contractor's work to whoever did the transcription.
  performed_by    uuid not null references core.object (id),
  submitted_by    uuid not null references core.object (id),
  recorded_by     uuid not null references core.object (id),

  -- The period the work covers, not when it was typed in.
  period_start    date not null,
  period_end      date not null,
  effort_hours    numeric(10, 2) check (effort_hours > 0),
  summary         text not null check (length(btrim(summary)) between 1 and 8000),

  -- What is being claimed for this execution, which acceptance may reduce but never raise.
  claimed_value_minor bigint not null check (claimed_value_minor >= 0),
  currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),

  constraint work_execution_period_ordered check (period_end >= period_start)
);

create index work_execution_by_order on work.work_execution (work_order_id);

-- What a submission actually handed over. The artifact VERSION, never the artifact: "we
-- accepted the enclosure drawing" is meaningless if the drawing can change afterwards.
create table work.deliverable_submission (
  id                 uuid primary key default uuidv7(),
  work_execution_id  uuid not null references work.work_execution (id) on delete restrict,
  deliverable_id     uuid not null references work.deliverable (id) on delete restrict,
  artifact_version_id uuid references content.artifact_version (id) on delete restrict,
  -- Where no artifact exists — a service, a conversation, an installed fixture — the note is
  -- what was handed over. One or the other must be present.
  note               text,

  unique (work_execution_id, deliverable_id),
  constraint submission_has_content
    check (artifact_version_id is not null or (note is not null and length(btrim(note)) > 0))
);

create index submission_by_execution on work.deliverable_submission (work_execution_id);

-- ── acceptance ──────────────────────────────────────────────────────────────────────────

create table work.acceptance_record (
  id                uuid primary key references core.object (id) on delete restrict,
  work_execution_id uuid not null unique references work.work_execution (id) on delete restrict,
  -- The technical authority who accepted. Separation of duty is enforced by the dispatcher;
  -- recording it here is what makes the enforcement auditable afterwards.
  accepted_by       uuid not null references core.object (id),
  disposition       text not null check (disposition in ('accepted', 'partially_accepted', 'rejected')),
  -- The value ACCEPTED, which drives KF-FIN-001 and KF-FIN-002. Zero on rejection.
  accepted_value_minor bigint not null check (accepted_value_minor >= 0),
  currency          char(3) not null check (currency ~ '^[A-Z]{3}$'),
  rationale         text not null check (length(btrim(rationale)) between 1 and 4000),
  accepted_at       timestamptz not null default now(),

  -- A rejection that accepts value, or a full acceptance that accepts nothing, is a
  -- contradiction between the words and the money. The words are not authoritative on their
  -- own (§27.1); this is the money agreeing with them.
  constraint acceptance_rejection_has_no_value
    check (disposition <> 'rejected' or accepted_value_minor = 0)
);

create index acceptance_by_execution on work.acceptance_record (work_execution_id);

-- Per-deliverable disposition within an acceptance.
create table work.acceptance_item (
  id                uuid primary key default uuidv7(),
  acceptance_id     uuid not null references work.acceptance_record (id) on delete restrict,
  deliverable_id    uuid not null references work.deliverable (id) on delete restrict,
  disposition       text not null check (disposition in ('accepted', 'rework', 'rejected', 'waived')),
  comment           text,

  unique (acceptance_id, deliverable_id)
);

-- migrate:down

drop table work.acceptance_item;
drop table work.acceptance_record;
drop table work.deliverable_submission;
drop table work.work_execution;
drop table work.deliverable;
drop table work.work_order_amendment;
drop table work.work_order_scope;
drop table work.work_order;
drop table work.work_package;
drop table work.project_event;
drop table work.milestone;
drop table work.initiative_project;
