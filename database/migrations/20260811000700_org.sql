-- migrate:up

-- The organization schema: people, organizations, engagements and who may act as what.
--
-- These are typed domain tables that EXTEND core.object rather than duplicate it. Identity,
-- lifecycle, classification and retention live once, in core.object; the columns here are
-- the attributes only a person or an engagement has. The 1:1 link means a person cannot
-- exist without an identity, and an identity cannot be silently retyped underneath one.

create table org.organization (
  id                uuid primary key references core.object (id) on delete restrict,
  legal_name        text not null check (length(btrim(legal_name)) > 0),
  organization_kind text not null
    check (organization_kind in ('company','supplier','laboratory','university','regulator','other')),
  jurisdiction      text
);

create table org.person (
  id            uuid primary key references core.object (id) on delete restrict,
  display_name  text not null check (length(btrim(display_name)) > 0),
  organization  uuid references org.organization (id),
  -- Contact detail only. Tax identifiers, bank details and home addresses are NEVER stored
  -- in this system; they stay in the restricted HR/finance system and are referenced.
  email         text
);

comment on table org.person is
  'People. Contact detail only — TIN, bank details and personal addresses are never stored '
  'here; they remain in the restricted HR/finance system and are referenced, not copied.';

create table org.engagement (
  id                     uuid primary key references core.object (id) on delete restrict,
  principal_organization uuid not null references org.organization (id),
  counterparty           uuid not null references org.organization (id),
  engagement_kind        text not null
    check (engagement_kind in
      ('contractor','supplier','employee','research_collaboration','laboratory_service')),
  starts_on              date not null,
  ends_on                date,
  agreement_artifact     uuid,
  constraint engagement_dates_ordered check (ends_on is null or ends_on >= starts_on),
  -- An organization cannot be engaged with itself; that is a data-entry error, not a
  -- relationship, and it would make every "who is the counterparty" query ambiguous.
  constraint engagement_not_self check (principal_organization <> counterparty)
);

-- Roles are a controlled list, seeded here to match the ontology's role_assignment.role
-- enum. A test asserts the two agree, so a role added to the ontology and forgotten here
-- surfaces as a failure rather than as an action nobody can perform.
create table org.role (
  id           text primary key,
  description  text not null
);

insert into org.role (id, description) values
  ('project_owner',           'Outcome, scope, resource commitment and project closure.'),
  ('technical_authority',     'Technical direction, decision disposition and acceptance.'),
  ('design_authority',        'Design integrity and baseline change.'),
  ('work_order_manager',      'External scope, commercial limits and amendments.'),
  ('performer',               'Truthful work execution submission and evidence.'),
  ('reviewer',                'Independent or peer review of evidence and conformance.'),
  ('finance_approver',        'Invoice approval, payment authorization and reconciliation.'),
  ('quality_authority',       'QMS classification, required evidence and regulated approvals.'),
  ('configuration_authority', 'Configuration identification, baselines and releases.'),
  ('system_administrator',    'Schema release, retention, corrections and access policy.');

create table org.role_assignment (
  id           uuid primary key references core.object (id) on delete restrict,
  subject_id   uuid not null references org.person (id),
  role_id      text not null references org.role (id),
  -- What the role applies to: a project, a product, or the organization itself. An
  -- unscoped role would be authority everywhere, which no one should hold by accident.
  scope_id     uuid not null references core.object (id),
  valid_from   timestamptz not null default now(),
  valid_to     timestamptz,
  delegated_by uuid references org.person (id),
  constraint role_assignment_interval_ordered check (valid_to is null or valid_to > valid_from),

  -- Effective-dated, and non-overlapping per (subject, role, scope). Two overlapping
  -- assignments of the same role would make "was this person authorized on that date"
  -- ambiguous — exactly the question an investigation asks.
  constraint role_assignment_no_overlap
    exclude using gist (
      subject_id with =,
      role_id with =,
      scope_id with =,
      tstzrange(valid_from, valid_to) with &&
    )
);

create index role_assignment_by_subject on org.role_assignment (subject_id, role_id);

create table org.project_membership (
  id          uuid primary key default uuidv7(),
  project_id  uuid not null references core.object (id),
  person_id   uuid not null references org.person (id),
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  constraint project_membership_interval_ordered check (valid_to is null or valid_to > valid_from),
  constraint project_membership_no_overlap
    exclude using gist (
      project_id with =,
      person_id with =,
      tstzrange(valid_from, valid_to) with &&
    )
);

create index project_membership_by_person on org.project_membership (person_id);

-- ── helpers the dispatcher and policies use ─────────────────────────────────────────────

/*
 * Does `p_person` hold `p_role_assignment` right now?
 *
 * The assignment must belong to the person AND be within its effective window. Checking
 * only ownership would let an expired authority keep working, which is how a departed
 * contractor keeps approving things.
 */
create or replace function org.holds_role(p_person uuid, p_role_assignment uuid) returns boolean
language sql stable
as $$
  select exists (
    select 1 from org.role_assignment
     where id = p_role_assignment
       and subject_id = p_person
       and valid_from <= now()
       and (valid_to is null or valid_to > now())
  )
$$;

grant select on all tables in schema org to kf_app, kf_worker, kf_readonly, kf_auditor;
grant insert, update on org.organization, org.person, org.engagement,
                        org.role_assignment, org.project_membership to kf_app;

comment on constraint role_assignment_no_overlap on org.role_assignment is
  'Two overlapping assignments of the same role in the same scope would make "was this '
  'person authorized on that date" ambiguous — the question an investigation asks first.';

-- migrate:down

drop function if exists org.holds_role(uuid, uuid);
drop table if exists org.project_membership;
drop table if exists org.role_assignment;
drop table if exists org.role;
drop table if exists org.engagement;
drop table if exists org.person;
drop table if exists org.organization;
