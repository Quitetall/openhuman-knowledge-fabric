-- migrate:up

-- Qualification is evidence against a versioned pack (ADR 0038; SAS §24A, KF-SAS-RQ-254 to RQ-261;
-- closes §100.41 for milestone M5, KF-WAR-0007).
--
-- The Fabric could say what a person MAY do (grants) and nothing about what they have shown they
-- are READY to do. Two record types, their typed rows, and the checks the database owns:
--
--   1. PACKS. `org.qualification_pack` is the typed row of a `qualification_pack` object;
--      `org.qualification_pack_revision` holds each revision's document
--      (`kf-qualification-pack-v1`, validated by @kf/qualification before it is written) and its
--      approval. `org.qualification_requirement_revision` holds each requirement's definition at
--      each revision, keyed by a stable requirement key per organization, so a requirement two
--      packs share is ONE requirement. `org.qualification_pack_requirement` is a pack revision's
--      composition, flattened from its explicit list of parts: which requirement, at which
--      revision, from which part. A requirement revision is in force once the pack revision that
--      introduced it is approved. Approving is institutional (`requires: act`).
--
--   2. RECORDS. `org.qualification_record` is the typed row of a `qualification_record` object:
--      one person, one scope, the exact pack revision assigned, the named contact.
--      `org.qualification_credit` is the evidence credited against a requirement, by whom, in
--      which act; `org.qualification_evidence_submission` is what the person (or their agent)
--      named as evidence, waiting for a reviewer in Needs you.
--
--   3. THE RULES, IN THE DATABASE.
--        * A credit's evidence mode is the requirement's, set here, never the caller's: a mode is
--          never upgraded (RQ-256). A credit of another requirement counts only through an
--          explicit equivalence the requirement declares, and only at the same mode.
--        * The creditor holds the authority the requirement names (`self` for an
--          acknowledgement only, the record's `contact`, or a role held live), is never an agent
--          (an assistant never credits, ADR 0038 decision 10), and never credits their own work
--          or their own record unless the requirement is a self-acknowledgement (RQ-047).
--        * Evidence is accepted work: verified as reviewed individually by someone other than the
--          person; the act that credits may verify it in the same act (RQ-257).
--        * A record becomes `qualified` only when every mandatory requirement applicable to its
--          scope has a current credit, checked at commit, naming what is missing; the act that
--          accepts credits the last evidence itself, so closing needs no second approval.
--        * Currency is computed: a credit is current while no later revision of its requirement
--          declares behavioural impact (RQ-259). Nothing resets on a calendar.
--
--   4. REQUIRES_QUALIFICATION. An action type that declares `requires_qualification`
--      (`registry.action_type.requires_qualification`) is checked at the moment of the act,
--      beside act-grant coverage and after it (`action_requires_act_authority` fires first, by
--      name), as ADR 0033 checks authority: every in-force requirement that names the act in
--      `gates`, organization-wide or scoped to one of the act's targets, must have a current
--      credit of the actor, or the act is refused naming the requirement (KF-QUAL-001). An act
--      that declares nothing is never checked, and qualification never grants: it can only add a
--      refusal to an act the actor's grants already allow (RQ-258).
--
--   5. CONFIDENTIALITY (ADR 0038 decision 12). A record, its credits and its submissions are read
--      by the person, their named contact and the people who may credit it (the holders of a role
--      a requirement of its pack names, and anyone who has credited it). Others see the record's
--      envelope through the ordinary grant path: its scope and state, which is its eligibility.
--      The policies read only their own row's columns and the pack tables, never each other's
--      table, so no policy recurses. Computations that must see a person's whole evidence (the
--      act check, the completeness check) seal `kf.qualification_subject` for their own duration,
--      as `core.assignment_is_live` seals its provisional context, and restore it before
--      returning; a session cannot seal it.
--
--   6. INVITATIONS. `org.invitation` records that the owner invited a person: the token's digest,
--      the assignment and the record prepared for them, the contact. Written only by the owner
--      credential, like the person, identity link and role assignment it accompanies
--      (KF-SAS-RQ-236). Read by the invited person only.
--
-- THE GUARDS EVERY NEW TABLE INHERITS: row security enabled and forced; every context accessor in
-- a policy wrapped `(select …)`; the act write guard (core.install_action_context_guards) on every
-- table kf_app writes; a kf_backup read policy and grant; the master-record input triggers
-- (content.install_master_record_input_triggers), since a record's typed row and its credits are
-- read by the payload walk of a reader who is granted the envelope. None is transient: packs,
-- records, credits, submissions and invitations are records of decisions, exported and restored.

-- 0. The declaration --------------------------------------------------------------------------

alter table registry.action_type
  add column requires_qualification boolean not null default false;

comment on column registry.action_type.requires_qualification is
  'ADR 0038 decision 8: the act may be gated by a qualification requirement (a requirement of an '
  'approved pack names it in gates). Checked at the moment of the act by '
  'core.action_requires_qualification; false means never checked. Qualification grants nothing.';

-- 1. Packs --------------------------------------------------------------------------------------

create table org.qualification_pack (
  id              uuid primary key references core.object (id) on delete restrict,
  organization_id uuid not null references org.organization (id) on delete restrict,
  pack_key        text not null check (pack_key ~ '^[a-z0-9][a-z0-9._-]{0,119}$'),
  unique (organization_id, pack_key)
);

comment on table org.qualification_pack is
  'The typed row of a qualification_pack object (ADR 0038): its stable key in the organization. '
  'Revisions in org.qualification_pack_revision.';

create table org.qualification_pack_revision (
  pack_id            uuid not null references org.qualification_pack (id) on delete restrict,
  revision           integer not null check (revision >= 1),
  organization_id    uuid not null references org.organization (id) on delete restrict,
  title              text not null check (length(btrim(title)) >= 1),
  -- The `kf-qualification-pack-v1` document as drafted, and its tagged digest
  -- (taggedDigest('kf-qualification-pack-v1', document), @kf/qualification).
  document           jsonb not null check (jsonb_typeof(document) = 'object'),
  document_digest    text not null check (document_digest ~ '^[0-9a-f]{64}$'),
  -- Who maintains the pack, and its standing rule: a record closes when the last mandatory
  -- requirement is evidenced (on_evidence), or by a holder of acceptor_role (on_acceptance).
  owner_role         text not null references org.role (id),
  closing            text not null check (closing in ('on_evidence', 'on_acceptance')),
  acceptor_role      text references org.role (id),
  drafted_by         uuid not null references org.person (id),
  drafted_by_action  uuid not null unique references core.action (id) on delete restrict,
  drafted_at         timestamptz not null default now(),
  approved_by        uuid references org.person (id),
  approved_by_action uuid references core.action (id) on delete restrict,
  approved_at        timestamptz,
  primary key (pack_id, revision),
  check ((closing = 'on_acceptance') = (acceptor_role is not null)),
  check ((approved_by is null) = (approved_by_action is null)
         and (approved_by is null) = (approved_at is null))
);

comment on table org.qualification_pack_revision is
  'One revision of a qualification pack: the document, its digest, its owner and standing rule, '
  'and its approval (institutional). Append-only but for the one approval, written once.';

create table org.qualification_requirement_revision (
  organization_id        uuid not null references org.organization (id) on delete restrict,
  requirement_key        text not null check (requirement_key ~ '^[a-z0-9][a-z0-9._-]{0,159}$'),
  revision               integer not null check (revision >= 1),
  -- The requirement as the pack document declared it, and its tagged digest
  -- (taggedDigest('kf-qualification-requirement-v1', definition)).
  definition             jsonb not null check (jsonb_typeof(definition) = 'object'),
  definition_digest      text not null check (definition_digest ~ '^[0-9a-f]{64}$'),
  stage                  text not null check (stage in ('read_in', 'role_read_in', 'references',
                                                       'execution', 'first_contribution')),
  outcome                text not null check (length(btrim(outcome)) >= 8),
  evidence_mode          text not null check (evidence_mode in ('acknowledge', 'locate',
                                                                'demonstrate')),
  accepted_by            text not null check (accepted_by ~ '^(self|contact|role:[a-z_][a-z0-9_]*)$'),
  mandatory              boolean not null,
  -- KF-SAS-RQ-260: what becomes unsafe, unauthorized or unreliable without it.
  consequence            text,
  -- RQ-259: whether this revision changes required behaviour. A first revision introduces it.
  behavioural_impact     boolean not null,
  -- Null: the organization. Otherwise the one scope object the requirement applies to.
  scope_object_id        uuid references core.object (id) on delete restrict,
  -- The acts this requirement gates (each declares requires_qualification).
  gates                  text[] not null default '{}',
  introduced_by_pack     uuid not null,
  introduced_in_revision integer not null,
  primary key (organization_id, requirement_key, revision),
  foreign key (introduced_by_pack, introduced_in_revision)
    references org.qualification_pack_revision (pack_id, revision) on delete restrict,
  check (not mandatory or length(btrim(coalesce(consequence, ''))) >= 8),
  check (accepted_by <> 'self' or evidence_mode = 'acknowledge'),
  check (revision > 1 or behavioural_impact)
);

comment on table org.qualification_requirement_revision is
  'A qualification requirement at one revision (ADR 0038 decision 4): the outcome, evidence mode, '
  'accepting authority, consequence, behavioural impact and gated acts. Keyed by a stable key per '
  'organization, so a requirement shared by packs is one requirement. In force once the pack '
  'revision that introduced it is approved. Append-only.';

create table org.qualification_pack_requirement (
  pack_id              uuid not null,
  pack_revision        integer not null,
  organization_id      uuid not null references org.organization (id) on delete restrict,
  requirement_key      text not null,
  requirement_revision integer not null,
  part                 text not null check (part in ('common', 'role', 'scope')),
  -- The part pack it was composed from, or null for the pack's own requirement.
  via_pack             uuid references org.qualification_pack (id) on delete restrict,
  via_revision         integer,
  primary key (pack_id, pack_revision, requirement_key),
  foreign key (pack_id, pack_revision)
    references org.qualification_pack_revision (pack_id, revision) on delete restrict,
  foreign key (organization_id, requirement_key, requirement_revision)
    references org.qualification_requirement_revision (organization_id, requirement_key, revision)
    on delete restrict,
  check ((via_pack is null) = (via_revision is null))
);

comment on table org.qualification_pack_requirement is
  'A pack revision''s composition, flattened from its explicit list of parts (common, role, '
  'scope): one row per requirement, which appears once however many parts carry it. Append-only.';

-- 2. Records ------------------------------------------------------------------------------------

create table org.qualification_record (
  id                 uuid primary key references core.object (id) on delete restrict,
  organization_id    uuid not null references org.organization (id) on delete restrict,
  person_id          uuid not null references org.person (id),
  -- Null: the organization. Otherwise the scope object the qualification is for.
  scope_object_id    uuid references core.object (id) on delete restrict,
  pack_id            uuid not null,
  pack_revision      integer not null,
  contact_person_id  uuid not null references org.person (id),
  assigned_by        uuid not null references org.person (id),
  assigned_by_action uuid not null unique references core.action (id) on delete restrict,
  assigned_at        timestamptz not null default now(),
  foreign key (pack_id, pack_revision)
    references org.qualification_pack_revision (pack_id, revision) on delete restrict,
  check (contact_person_id <> person_id)
);

create index qualification_record_by_person on org.qualification_record (organization_id, person_id);
create index qualification_record_by_contact on org.qualification_record (organization_id, contact_person_id);

comment on table org.qualification_record is
  'One person''s qualification for one scope (ADR 0038 decision 3), pinned to the pack revision it '
  'was assigned under. Confidential to the person, their contact and its reviewers (decision 12). '
  'State on the envelope: assigned, qualified, withdrawn, superseded. Append-only.';

create table org.qualification_evidence_submission (
  id                  uuid primary key default uuidv7(),
  organization_id     uuid not null references org.organization (id) on delete restrict,
  record_id           uuid not null references org.qualification_record (id) on delete restrict,
  -- The record's person, contact and pack, carried so the read policy needs no other table.
  person_id           uuid not null references org.person (id),
  contact_person_id   uuid not null references org.person (id),
  pack_id             uuid not null,
  pack_revision       integer not null,
  requirement_key     text not null,
  evidence_object_id  uuid not null references core.object (id) on delete restrict,
  note                text,
  agent_client_id     text,
  submitted_by_action uuid not null unique references core.action (id) on delete restrict,
  submitted_at        timestamptz not null default now(),
  foreign key (pack_id, pack_revision)
    references org.qualification_pack_revision (pack_id, revision) on delete restrict
);

create index qualification_submission_by_record
  on org.qualification_evidence_submission (record_id, requirement_key);

comment on table org.qualification_evidence_submission is
  'What the person (or their agent) named as evidence for a requirement. Credits nothing; waits '
  'in Needs you until a reviewer credits it. Append-only.';

create table org.qualification_credit (
  id                   uuid primary key default uuidv7(),
  organization_id      uuid not null references org.organization (id) on delete restrict,
  record_id            uuid not null references org.qualification_record (id) on delete restrict,
  -- The record's person, contact and pack, carried so the read policy needs no other table.
  person_id            uuid not null references org.person (id),
  contact_person_id    uuid not null references org.person (id),
  pack_id              uuid not null,
  pack_revision        integer not null,
  requirement_key      text not null,
  requirement_revision integer not null,
  -- The requirement's mode at that revision, set by the database (RQ-256).
  evidence_mode        text not null check (evidence_mode in ('acknowledge', 'locate',
                                                              'demonstrate')),
  -- What evidences it: an accepted record, or an existing credit of an equivalent requirement.
  evidence_object_id   uuid references core.object (id) on delete restrict,
  prior_credit_id      uuid references org.qualification_credit (id) on delete restrict,
  submission_id        uuid references org.qualification_evidence_submission (id) on delete restrict,
  credited_by          uuid not null references org.person (id),
  credited_by_action   uuid not null references core.action (id) on delete restrict,
  credited_at          timestamptz not null default now(),
  unique (record_id, requirement_key, requirement_revision),
  foreign key (pack_id, pack_revision)
    references org.qualification_pack_revision (pack_id, revision) on delete restrict,
  foreign key (organization_id, requirement_key, requirement_revision)
    references org.qualification_requirement_revision (organization_id, requirement_key, revision)
    on delete restrict,
  check (num_nonnulls(evidence_object_id, prior_credit_id) = 1)
);

create index qualification_credit_by_person
  on org.qualification_credit (organization_id, person_id, requirement_key, requirement_revision);

comment on table org.qualification_credit is
  'Evidence credited against one requirement of one record, by whom and in which act (ADR 0038 '
  'decision 7). The mode is the requirement''s, never upgraded. Append-only.';

-- Every typed row is its type (20260925012000): a pack row can only be a qualification_pack, a
-- record row only a qualification_record.
alter table org.qualification_pack
  add column object_type text generated always as ('qualification_pack') stored;
alter table org.qualification_pack
  add constraint qualification_pack_is_qualification_pack
  foreign key (id, object_type) references core.object (id, object_type);
alter table org.qualification_record
  add column object_type text generated always as ('qualification_record') stored;
alter table org.qualification_record
  add constraint qualification_record_is_qualification_record
  foreign key (id, object_type) references core.object (id, object_type);

-- 3. Invitations ------------------------------------------------------------------------------

create table org.invitation (
  id                      uuid primary key default uuidv7(),
  organization_id         uuid not null references org.organization (id) on delete restrict,
  person_id               uuid not null references org.person (id),
  -- sha256 of the token in the link; the token itself is never stored.
  token_digest            text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  role_assignment_id      uuid references org.role_assignment (id) on delete restrict,
  qualification_record_id uuid references org.qualification_record (id) on delete restrict,
  contact_person_id       uuid references org.person (id),
  invited_by              uuid not null references org.person (id),
  invited_by_action       uuid not null references core.action (id) on delete restrict,
  invited_at              timestamptz not null default now(),
  expires_at              timestamptz not null,
  check (expires_at > invited_at and expires_at <= invited_at + interval '30 days')
);

comment on table org.invitation is
  'That the owner invited a person (ADR 0040 decision 12): the digest of the link''s token, the '
  'assignment and qualification record prepared, the contact. Written only by the owner '
  'credential (KF-SAS-RQ-236); read by the invited person. The link carries no authority: it '
  'leads to sign-in as the account the owner already linked, and then to Start Here.';

-- 4. Helpers ------------------------------------------------------------------------------------

-- Whether a person holds a role live in an organization, directly (inclusion composes scope, not
-- authority: 20261007200000). A provisional context, as core.assignment_is_live binds one, so the
-- answer does not depend on the bound reader's ceiling; restored before returning.
create function org.qualification_holds_role(p_person uuid, p_organization uuid, p_role text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_org   text := core.sealed_setting('kf.organization', true);
  v_class text := core.sealed_setting('kf.max_classification', true);
  v_held  boolean;
begin
  if p_person is null or p_role is null then
    return false;
  end if;
  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', 'restricted', true);
  select exists (
    select 1
      from org.role_assignment ra
      join core.object o on o.id = ra.id
     where ra.subject_id = p_person
       and ra.role_id = p_role
       and o.organization_id = p_organization
       and o.lifecycle_state = 'active'
       and ra.valid_from <= now()
       and (ra.valid_to is null or ra.valid_to > now())
  ) into v_held;
  perform core.seal_setting('kf.organization', v_org, true);
  perform core.seal_setting('kf.max_classification', v_class, true);
  return v_held;
end
$$;

revoke all on function org.qualification_holds_role(uuid, uuid, text) from public;
grant execute on function org.qualification_holds_role(uuid, uuid, text) to kf_app;

-- Whether anyone other than p_except holds a role live in an organization: a reviewer exists.
-- Existence only; it names nobody.
create function org.qualification_role_has_holder(p_organization uuid, p_role text, p_except uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_org   text := core.sealed_setting('kf.organization', true);
  v_class text := core.sealed_setting('kf.max_classification', true);
  v_held  boolean;
begin
  if p_organization is distinct from core.current_organization()
     and not core.session_is_administrator() then
    return false;
  end if;
  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', 'restricted', true);
  select exists (
    select 1
      from org.role_assignment ra
      join core.object o on o.id = ra.id
     where ra.role_id = p_role
       and ra.subject_id is distinct from p_except
       and o.organization_id = p_organization
       and o.lifecycle_state = 'active'
       and ra.valid_from <= now()
       and (ra.valid_to is null or ra.valid_to > now())
  ) into v_held;
  perform core.seal_setting('kf.organization', v_org, true);
  perform core.seal_setting('kf.max_classification', v_class, true);
  return v_held;
end
$$;

revoke all on function org.qualification_role_has_holder(uuid, text, uuid) from public;
grant execute on function org.qualification_role_has_holder(uuid, text, uuid) to kf_app;

-- Whether a person holds any live assignment in the bound organization: their contact can answer
-- them. Existence only, for the bound organization only.
create function org.qualification_person_is_live(p_person uuid)
returns boolean
language sql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
  select core.current_organization() is not null
     and exists (select 1 from org.live_assignments_of(p_person, core.current_organization()))
$$;

revoke all on function org.qualification_person_is_live(uuid) from public;
grant execute on function org.qualification_person_is_live(uuid) to kf_app;

-- Whether the bound principal may credit a requirement of this pack revision: they hold live a
-- role one of its requirements names as its accepting authority, or its acceptor role. The read
-- policies below call it with their own row's pack; it reads only the pack tables.
create function org.qualification_reviews_pack(p_pack uuid, p_revision integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_principal uuid := core.current_principal_or_null();
  v_org       uuid := core.current_organization();
  v_role      text;
begin
  if v_principal is null or v_org is null then
    return false;
  end if;
  for v_role in
    select distinct substr(rr.accepted_by, 6)
      from org.qualification_pack_requirement pr
      join org.qualification_requirement_revision rr
        on rr.organization_id = pr.organization_id
       and rr.requirement_key = pr.requirement_key
       and rr.revision = pr.requirement_revision
     where pr.pack_id = p_pack and pr.pack_revision = p_revision
       and pr.organization_id = v_org
       and rr.accepted_by like 'role:%'
    union
    select r.acceptor_role
      from org.qualification_pack_revision r
     where r.pack_id = p_pack and r.revision = p_revision and r.acceptor_role is not null
  loop
    if org.qualification_holds_role(v_principal, v_org, v_role) then
      return true;
    end if;
  end loop;
  return false;
end
$$;

revoke all on function org.qualification_reviews_pack(uuid, integer) from public;
grant execute on function org.qualification_reviews_pack(uuid, integer) to kf_app, kf_worker;

-- The person a computation is about, sealed by a definer for its own duration, or null.
create function org.qualification_subject_or_null() returns uuid
language sql
stable
as $$ select core.sealed_setting('kf.qualification_subject', true)::uuid $$;

grant execute on function org.qualification_subject_or_null() to kf_app, kf_worker;

-- A requirement in force in an organization: its latest revision introduced by an approved pack
-- revision, and the latest revision at or below it that declared behavioural impact (the floor a
-- credit must reach to be current, RQ-259).
create function org.qualification_requirement_in_force(p_organization uuid, p_key text)
returns table (revision integer, current_floor integer, evidence_mode text, outcome text,
               mandatory boolean, consequence text, scope_object_id uuid, gates text[],
               accepted_by text, definition jsonb)
language sql
stable
set search_path = pg_catalog, org
as $$
  with approved as (
    select rr.*
      from org.qualification_requirement_revision rr
      join org.qualification_pack_revision pr
        on pr.pack_id = rr.introduced_by_pack and pr.revision = rr.introduced_in_revision
     where rr.organization_id = p_organization
       and rr.requirement_key = p_key
       and pr.approved_at is not null
  ), top as (
    select * from approved order by revision desc limit 1
  )
  select top.revision,
         (select max(a.revision) from approved a where a.behavioural_impact),
         top.evidence_mode, top.outcome, top.mandatory, top.consequence, top.scope_object_id,
         top.gates, top.accepted_by, top.definition
    from top
$$;

grant execute on function org.qualification_requirement_in_force(uuid, text) to kf_app, kf_worker;

-- Whether a person holds a current credit for a requirement: a credit of that key, at its mode,
-- at or above its behavioural floor, in a record of theirs that is not withdrawn. Satisfied once
-- across every record and pack (decision 3), never by a weaker mode (RQ-256).
create function org.qualification_credit_is_current(
  p_person uuid, p_organization uuid, p_key text, p_mode text, p_floor integer)
returns boolean
language sql
stable
set search_path = pg_catalog, core, org
as $$
  select exists (
    select 1
      from org.qualification_credit c
      join core.object rec on rec.id = c.record_id
     where c.organization_id = p_organization
       and c.person_id = p_person
       and c.requirement_key = p_key
       and c.evidence_mode = p_mode
       and c.requirement_revision >= coalesce(p_floor, 1)
       and rec.lifecycle_state <> 'withdrawn'
  )
$$;

grant execute on function org.qualification_credit_is_current(uuid, uuid, text, text, integer)
  to kf_app, kf_worker;

-- The requirements an act would need and the actor lacks. Asked about the bound actor only, so it
-- is not an oracle on anyone else's evidence. Seals the subject for its own duration so the
-- actor's credits are visible whatever record they sit in.
create function org.qualification_gaps_for_act(
  p_actor uuid, p_organization uuid, p_action_type text, p_targets uuid[])
returns table (requirement_key text, revision integer, outcome text, credited_revision integer)
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_subject text := core.sealed_setting('kf.qualification_subject', true);
  r record;
  f record;
begin
  if not core.session_is_administrator()
     and p_actor is distinct from core.current_actor_or_null()
     and p_actor is distinct from core.current_principal_or_null() then
    raise exception 'KF-QUAL-002: qualification gaps are answered for the bound actor only'
      using errcode = 'check_violation';
  end if;
  if not coalesce((select a.requires_qualification from registry.action_type a
                    where a.id = p_action_type), false) then
    return;
  end if;
  perform core.seal_setting('kf.qualification_subject', p_actor::text, true);
  for r in
    select distinct rr.requirement_key as key
      from org.qualification_requirement_revision rr
     where rr.organization_id = p_organization
       and p_action_type = any (rr.gates)
  loop
    select * into f from org.qualification_requirement_in_force(p_organization, r.key);
    if f.revision is null or not (p_action_type = any (f.gates)) then
      continue;
    end if;
    if f.scope_object_id is not null and not (f.scope_object_id = any (coalesce(p_targets, '{}'))) then
      continue;
    end if;
    if not org.qualification_credit_is_current(p_actor, p_organization, r.key, f.evidence_mode,
                                               f.current_floor) then
      requirement_key := r.key;
      revision := f.revision;
      outcome := f.outcome;
      credited_revision := (select max(c.requirement_revision) from org.qualification_credit c
                             where c.organization_id = p_organization and c.person_id = p_actor
                               and c.requirement_key = r.key and c.evidence_mode = f.evidence_mode);
      return next;
    end if;
  end loop;
  perform core.seal_setting('kf.qualification_subject', v_subject, true);
end
$$;

revoke all on function org.qualification_gaps_for_act(uuid, uuid, text, uuid[]) from public;
grant execute on function org.qualification_gaps_for_act(uuid, uuid, text, uuid[]) to kf_app;

-- The mandatory requirements of a record, applicable to its scope, without a current credit of its
-- person. Asked about a record the caller can see; seals its person as the subject.
create function org.qualification_record_missing(p_record uuid)
returns table (requirement_key text, revision integer, outcome text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_subject text := core.sealed_setting('kf.qualification_subject', true);
  v_rec     org.qualification_record%rowtype;
  r record;
  f record;
begin
  select * into v_rec from org.qualification_record where id = p_record;
  if not found then
    raise exception 'KF-QUAL-012: qualification record % is not one this person may read', p_record
      using errcode = 'check_violation';
  end if;
  perform core.seal_setting('kf.qualification_subject', v_rec.person_id::text, true);
  for r in
    select pr.requirement_key as key
      from org.qualification_pack_requirement pr
     where pr.pack_id = v_rec.pack_id and pr.pack_revision = v_rec.pack_revision
     order by pr.requirement_key
  loop
    select * into f from org.qualification_requirement_in_force(v_rec.organization_id, r.key);
    if f.revision is null or not f.mandatory then
      continue;
    end if;
    if f.scope_object_id is not null and f.scope_object_id is distinct from v_rec.scope_object_id then
      continue;
    end if;
    if not org.qualification_credit_is_current(v_rec.person_id, v_rec.organization_id, r.key,
                                               f.evidence_mode, f.current_floor) then
      requirement_key := r.key;
      revision := f.revision;
      outcome := f.outcome;
      return next;
    end if;
  end loop;
  perform core.seal_setting('kf.qualification_subject', v_subject, true);
end
$$;

revoke all on function org.qualification_record_missing(uuid) from public;
grant execute on function org.qualification_record_missing(uuid) to kf_app;

-- Every credit of a record's person, for a caller who may read the record: the evaluator counts a
-- requirement satisfied once, whichever of the person's records carries the credit (decision 3).
create function org.qualification_credits_for_record(p_record uuid)
returns table (id uuid, record_id uuid, requirement_key text, requirement_revision integer,
               evidence_mode text, evidence_object_id uuid, prior_credit_id uuid,
               credited_by uuid, credited_at timestamptz, record_state text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_subject text := core.sealed_setting('kf.qualification_subject', true);
  v_class   text := core.sealed_setting('kf.max_classification', true);
  v_person  uuid;
  v_org     uuid;
begin
  select r.person_id, r.organization_id into v_person, v_org
    from org.qualification_record r where r.id = p_record;
  if v_person is null then
    raise exception 'KF-QUAL-012: qualification record % is not one this person may read', p_record
      using errcode = 'check_violation';
  end if;
  perform core.seal_setting('kf.qualification_subject', v_person::text, true);
  -- The state of each credit's record, whatever its envelope's classification: a withdrawn
  -- record's credits stop counting, and that must not depend on who is reading.
  perform core.seal_setting('kf.max_classification', 'restricted', true);
  return query
    select c.id, c.record_id, c.requirement_key, c.requirement_revision, c.evidence_mode,
           c.evidence_object_id, c.prior_credit_id, c.credited_by, c.credited_at,
           rec.lifecycle_state
      from org.qualification_credit c
      join core.object rec on rec.id = c.record_id
     where c.organization_id = v_org and c.person_id = v_person
     order by c.requirement_key, c.requirement_revision, c.id;
  perform core.seal_setting('kf.qualification_subject', v_subject, true);
  perform core.seal_setting('kf.max_classification', v_class, true);
end
$$;

revoke all on function org.qualification_credits_for_record(uuid) from public;
grant execute on function org.qualification_credits_for_record(uuid) to kf_app;

-- Whether a person can read one record of an organization: `missing` (no such record there),
-- `not_granted` (above their clearance, or no live read grant reaches it) or `readable`. The
-- grant rule is the permitted set's (ADR 0016): an organization-wide or object-scoped read grant,
-- to the person or to a role assignment they hold live, whose ceiling admits the record. A
-- provisional context, restored before returning.
create function org.qualification_person_reaches(p_person uuid, p_organization uuid, p_object uuid)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_org      text := core.sealed_setting('kf.organization', true);
  v_class    text := core.sealed_setting('kf.max_classification', true);
  v_rank     integer;
  v_obj_id   uuid;
  v_obj_rank integer;
  v_reach    text;
begin
  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', 'restricted', true);
  select max(c.rank) into v_rank
    from org.person_clearance pc
    join registry.classification c on c.id = pc.max_classification
   where pc.subject_id = p_person and pc.organization_id = p_organization
     and pc.valid_from <= now() and (pc.valid_to is null or pc.valid_to > now());
  select o.id, c.rank into v_obj_id, v_obj_rank
    from core.object o join registry.classification c on c.id = o.classification
   where o.id = p_object and o.organization_id = p_organization;
  if v_obj_id is null then
    v_reach := 'missing';
  elsif v_rank is null or v_obj_rank > v_rank then
    v_reach := 'not_granted';
  elsif exists (
    select 1 from org.effective_access_grant g
     where g.organization_id = p_organization
       and g.capability = 'read'
       and g.scope_object_id in (p_organization, p_object)
       and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
       and (g.classification_ceiling is null
            or v_obj_rank <= (select c2.rank from registry.classification c2
                               where c2.id = g.classification_ceiling))
       and ((g.principal_kind = 'person' and g.principal_id = p_person)
            or (g.principal_kind = 'role_assignment' and exists (
                  select 1 from org.role_assignment ra
                   where ra.id = g.principal_id and ra.subject_id = p_person
                     and ra.valid_from <= now()
                     and (ra.valid_to is null or ra.valid_to > now()))))) then
    v_reach := 'readable';
  else
    v_reach := 'not_granted';
  end if;
  perform core.seal_setting('kf.organization', v_org, true);
  perform core.seal_setting('kf.max_classification', v_class, true);
  return v_reach;
end
$$;

revoke all on function org.qualification_person_reaches(uuid, uuid, uuid) from public;

-- Whether the record's PERSON can read each resource its requirements name, for a caller who may
-- read the record: the person's reach, not the caller's, so a contact sees the blocker the person
-- meets (RQ-261). Names no resource the caller could not already name from the pack.
create function org.qualification_resource_reach(p_record uuid)
returns table (resource_id uuid, reach text)
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_rec org.qualification_record%rowtype;
  v_id  uuid;
begin
  select * into v_rec from org.qualification_record where id = p_record;
  if not found then
    raise exception 'KF-QUAL-012: qualification record % is not one this person may read', p_record
      using errcode = 'check_violation';
  end if;
  for v_id in
    select distinct (e ->> 'id')::uuid
      from org.qualification_pack_requirement pr
      cross join lateral org.qualification_requirement_in_force(pr.organization_id,
                                                                pr.requirement_key) f
      cross join lateral jsonb_array_elements(coalesce(f.definition -> 'resources', '[]'::jsonb)) e
     where pr.pack_id = v_rec.pack_id and pr.pack_revision = v_rec.pack_revision
  loop
    resource_id := v_id;
    reach := org.qualification_person_reaches(v_rec.person_id, v_rec.organization_id, v_id);
    return next;
  end loop;
end
$$;

revoke all on function org.qualification_resource_reach(uuid) from public;
grant execute on function org.qualification_resource_reach(uuid) to kf_app;

-- 5. requires_qualification, checked at the moment of the act ---------------------------------

create function core.action_requires_qualification() returns trigger
language plpgsql
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_gap record;
begin
  if core.session_is_administrator() then
    return new;
  end if;
  if not coalesce((select a.requires_qualification from registry.action_type a
                    where a.id = new.action_type), false) then
    return new;
  end if;
  select * into v_gap
    from org.qualification_gaps_for_act(new.actor_id, new.organization_id, new.action_type,
                                        new.target_ids)
   order by requirement_key
   limit 1;
  if found then
    raise exception 'KF-QUAL-001: % requires qualification "%" (revision %): %. %',
      new.action_type, v_gap.requirement_key, v_gap.revision, v_gap.outcome,
      case when v_gap.credited_revision is null
           then 'No evidence for it has been credited to this person'
           else format('The credit at revision %s predates a revision that changed required '
                       'behaviour', v_gap.credited_revision) end
      using errcode = 'check_violation',
            hint = 'Qualification is checked, never granted (KF-SAS-RQ-258): a grant is still '
                   || 'needed, and a credit of this requirement by its accepting authority.';
  end if;
  return new;
end
$$;

revoke all on function core.action_requires_qualification() from public;

-- Named after action_requires_act_authority, so an absent grant is refused first: qualification
-- never stands in for authority.
create trigger action_requires_qualification
  before insert on core.action
  for each row execute function core.action_requires_qualification();

-- 6. Who writes what ------------------------------------------------------------------------

-- An assistant never credits, accepts, assigns, approves or withdraws (ADR 0038 decision 10). It
-- may submit evidence for its person. M2's bar already refuses the institutional acts; the
-- non-institutional ones are named here.
create function core.qualification_agent_bar() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
begin
  if core.session_is_administrator() or core.current_agent_or_null() is null then
    return new;
  end if;
  if new.action_type in ('credit_qualification_evidence', 'accept_qualification') then
    raise exception 'KF-QUAL-011: % is a person''s judgement; agent % may explain, assemble and '
      'submit evidence for its person, and never credits or accepts it (ADR 0038 decision 10)',
      new.action_type, core.current_agent_or_null()
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

revoke all on function core.qualification_agent_bar() from public;

create trigger action_qualification_agent_bar
  before insert on core.action
  for each row execute function core.qualification_agent_bar();

-- Packs: written only by their acts. The approval is the one update, once.
create function org.qualification_pack_bounded() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, org
as $$
begin
  if core.session_is_administrator() then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'KF-QUAL-004: % is retired, never deleted (Law 6)', tg_table_name
      using errcode = 'check_violation';
  end if;
  if tg_table_name = 'qualification_pack_revision' and tg_op = 'UPDATE' then
    if old.approved_at is not null
       or (to_jsonb(new) - array['approved_by', 'approved_by_action', 'approved_at'])
          is distinct from (to_jsonb(old) - array['approved_by', 'approved_by_action', 'approved_at'])
       or core.current_action_type() is distinct from 'approve_qualification_pack' then
      raise exception 'KF-QUAL-004: a pack revision is approved once, by approve_qualification_pack, '
        'and never otherwise changed'
        using errcode = 'check_violation';
    end if;
    new.approved_by := core.current_actor_or_null();
    new.approved_by_action := core.current_action_id();
    new.approved_at := now();
    return new;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'KF-QUAL-004: % is append-only', tg_table_name
      using errcode = 'check_violation';
  end if;
  if coalesce(core.current_action_type(), '') not in ('draft_qualification_pack',
                                                     'supersede_qualification_pack') then
    raise exception 'KF-QUAL-002: % is written only by draft_qualification_pack or '
      'supersede_qualification_pack; this transaction recorded %', tg_table_name,
      coalesce(core.current_action_type(), 'no act')
      using errcode = 'check_violation';
  end if;
  if tg_table_name = 'qualification_pack_revision' then
    new.organization_id := core.current_organization();
    new.drafted_by := core.current_actor_or_null();
    new.drafted_by_action := core.current_action_id();
    new.drafted_at := now();
    -- A superseding revision is approved by the act that writes it; a draft is not.
    if core.current_action_type() = 'supersede_qualification_pack' then
      new.approved_by := core.current_actor_or_null();
      new.approved_by_action := core.current_action_id();
      new.approved_at := now();
    else
      new.approved_by := null;
      new.approved_by_action := null;
      new.approved_at := null;
    end if;
  elsif tg_table_name = 'qualification_requirement_revision' then
    -- KF-QUAL-003: a requirement at a revision means one thing.
    if exists (select 1 from org.qualification_requirement_revision rr
                where rr.organization_id = new.organization_id
                  and rr.requirement_key = new.requirement_key
                  and rr.revision = new.revision) then
      raise exception 'KF-QUAL-003: requirement % revision % is already defined; a changed '
        'requirement is a new revision, and an unchanged one is referenced, not redefined',
        new.requirement_key, new.revision
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

revoke all on function org.qualification_pack_bounded() from public;

create trigger qualification_pack_bounded
  before insert or update or delete on org.qualification_pack
  for each row execute function org.qualification_pack_bounded();
create trigger qualification_pack_revision_bounded
  before insert or update or delete on org.qualification_pack_revision
  for each row execute function org.qualification_pack_bounded();
create trigger qualification_requirement_revision_bounded
  before insert or update or delete on org.qualification_requirement_revision
  for each row execute function org.qualification_pack_bounded();
create trigger qualification_pack_requirement_bounded
  before insert or update or delete on org.qualification_pack_requirement
  for each row execute function org.qualification_pack_bounded();

-- Records: written only by assign_qualification, for an approved pack, at its current approved
-- revision, with a contact who is a live member of the organization.
create function org.qualification_record_bounded() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_revision integer;
begin
  if tg_op <> 'INSERT' then
    if core.session_is_administrator() then
      return coalesce(new, old);
    end if;
    raise exception 'KF-QUAL-004: a qualification record is withdrawn or superseded, never % (Law 6)',
      lower(tg_op)
      using errcode = 'check_violation';
  end if;
  if core.session_is_administrator() then
    return new;
  end if;
  if core.current_action_type() is distinct from 'assign_qualification' then
    raise exception 'KF-QUAL-002: a qualification record is written only by assign_qualification; '
      'this transaction recorded %', coalesce(core.current_action_type(), 'no act')
      using errcode = 'check_violation';
  end if;
  select max(r.revision) into v_revision
    from org.qualification_pack_revision r
    join core.object p on p.id = r.pack_id
   where r.pack_id = new.pack_id and r.approved_at is not null and p.lifecycle_state = 'approved';
  if v_revision is null then
    raise exception 'KF-QUAL-030: pack % is not approved; a person is assigned only an approved pack',
      new.pack_id
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from org.person p where p.id = new.person_id
                    and p.organization = core.current_organization()) then
    raise exception 'KF-QUAL-030: person % is not a member of this organization', new.person_id
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from org.live_assignments_of(new.contact_person_id,
                                                       core.current_organization())) then
    raise exception 'KF-QUAL-030: the contact % holds no live assignment here; each person has one '
      'named contact who can answer them (ADR 0038 decision 10)', new.contact_person_id
      using errcode = 'check_violation';
  end if;
  new.organization_id := core.current_organization();
  new.pack_revision := v_revision;
  new.assigned_by := core.current_actor_or_null();
  new.assigned_by_action := core.current_action_id();
  new.assigned_at := now();
  return new;
end
$$;

revoke all on function org.qualification_record_bounded() from public;

create trigger qualification_record_bounded
  before insert or update or delete on org.qualification_record
  for each row execute function org.qualification_record_bounded();

-- Submissions: the record's own person (or their agent), on an open record, for a requirement of
-- its pack.
create function org.qualification_submission_bounded() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_rec   org.qualification_record%rowtype;
  v_state text;
begin
  if tg_op <> 'INSERT' then
    if core.session_is_administrator() then
      return coalesce(new, old);
    end if;
    raise exception 'KF-QUAL-004: a submission is answered by a credit, never % (Law 6)', lower(tg_op)
      using errcode = 'check_violation';
  end if;
  if core.session_is_administrator() then
    return new;
  end if;
  if core.current_action_type() is distinct from 'submit_qualification_evidence' then
    raise exception 'KF-QUAL-002: a submission is written only by submit_qualification_evidence; '
      'this transaction recorded %', coalesce(core.current_action_type(), 'no act')
      using errcode = 'check_violation';
  end if;
  select * into v_rec from org.qualification_record where id = new.record_id;
  select lifecycle_state into v_state from core.object where id = new.record_id;
  if not found or v_rec.id is null
     or v_rec.person_id is distinct from core.current_actor_or_null() then
    raise exception 'KF-QUAL-031: only the record''s own person (or their agent) submits evidence for it'
      using errcode = 'check_violation';
  end if;
  if v_state not in ('assigned', 'qualified') then
    raise exception 'KF-QUAL-012: record % is %, and takes no more evidence', new.record_id, v_state
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from org.qualification_pack_requirement pr
                  where pr.pack_id = v_rec.pack_id and pr.pack_revision = v_rec.pack_revision
                    and pr.requirement_key = new.requirement_key) then
    raise exception 'KF-QUAL-013: % is not a requirement of this record''s pack', new.requirement_key
      using errcode = 'check_violation';
  end if;
  new.organization_id := v_rec.organization_id;
  new.person_id := v_rec.person_id;
  new.contact_person_id := v_rec.contact_person_id;
  new.pack_id := v_rec.pack_id;
  new.pack_revision := v_rec.pack_revision;
  new.agent_client_id := core.current_agent_or_null();
  new.submitted_by_action := core.current_action_id();
  new.submitted_at := now();
  return new;
end
$$;

revoke all on function org.qualification_submission_bounded() from public;

create trigger qualification_submission_bounded
  before insert or update or delete on org.qualification_evidence_submission
  for each row execute function org.qualification_submission_bounded();

-- Credits: the rules of ADR 0038 decisions 5 and 7, in one place.
create function org.qualification_credit_bounded() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_rec      org.qualification_record%rowtype;
  v_state    text;
  v_req      record;
  v_actor    uuid := core.current_actor_or_null();
  v_creator  uuid;
  v_verifier uuid;
  v_basis    text;
  v_prior    org.qualification_credit%rowtype;
  v_subject  text := core.sealed_setting('kf.qualification_subject', true);
begin
  if tg_op <> 'INSERT' then
    if core.session_is_administrator() then
      return coalesce(new, old);
    end if;
    raise exception 'KF-QUAL-004: a credit is withdrawn with its record, never % (Law 6)', lower(tg_op)
      using errcode = 'check_violation';
  end if;
  if core.session_is_administrator() then
    return new;
  end if;
  if coalesce(core.current_action_type(), '') not in ('credit_qualification_evidence',
                                                     'accept_qualification') then
    raise exception 'KF-QUAL-010: a credit is written only by credit_qualification_evidence or '
      'accept_qualification; this transaction recorded %', coalesce(core.current_action_type(), 'no act')
      using errcode = 'check_violation';
  end if;
  if core.current_agent_or_null() is not null then
    raise exception 'KF-QUAL-011: agent % may not credit evidence; an assistant never infers '
      'competence (ADR 0038 decision 10)', core.current_agent_or_null()
      using errcode = 'check_violation';
  end if;
  select * into v_rec from org.qualification_record where id = new.record_id;
  if not found then
    raise exception 'KF-QUAL-012: qualification record % is not one this person may credit',
      new.record_id
      using errcode = 'check_violation';
  end if;
  select lifecycle_state into v_state from core.object where id = new.record_id;
  if v_state is null or v_state not in ('assigned', 'qualified') then
    raise exception 'KF-QUAL-012: record % is %, and takes no more evidence', new.record_id,
      coalesce(v_state, 'not visible')
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from org.qualification_pack_requirement pr
                  where pr.pack_id = v_rec.pack_id and pr.pack_revision = v_rec.pack_revision
                    and pr.requirement_key = new.requirement_key) then
    raise exception 'KF-QUAL-013: % is not a requirement of this record''s pack', new.requirement_key
      using errcode = 'check_violation';
  end if;
  select * into v_req from org.qualification_requirement_in_force(v_rec.organization_id,
                                                                  new.requirement_key);
  if v_req.revision is null then
    raise exception 'KF-QUAL-013: requirement % is not in force', new.requirement_key
      using errcode = 'check_violation';
  end if;

  -- The authority the requirement names (decision 7).
  if v_req.accepted_by = 'self' then
    if v_actor is distinct from v_rec.person_id then
      raise exception 'KF-QUAL-014: % is acknowledged by the person themself', new.requirement_key
        using errcode = 'check_violation';
    end if;
  elsif v_req.accepted_by = 'contact' then
    if v_actor is distinct from v_rec.contact_person_id then
      raise exception 'KF-QUAL-014: % is credited by the record''s named contact', new.requirement_key
        using errcode = 'check_violation';
    end if;
  elsif not org.qualification_holds_role(v_actor, v_rec.organization_id, substr(v_req.accepted_by, 6)) then
    raise exception 'KF-QUAL-014: % is credited by a holder of %, and this person holds none live',
      new.requirement_key, substr(v_req.accepted_by, 6)
      using errcode = 'check_violation';
  end if;
  -- RQ-047: nobody credits their own record but by self-acknowledgement.
  if v_req.accepted_by <> 'self' and v_actor = v_rec.person_id then
    raise exception 'KF-QUAL-015: a person does not credit their own qualification (KF-SAS-RQ-047)'
      using errcode = 'check_violation';
  end if;

  -- The evidence.
  if new.evidence_object_id is not null then
    select o.created_by into v_creator from core.object o
     where o.id = new.evidence_object_id and o.organization_id = v_rec.organization_id;
    if not found then
      raise exception 'KF-QUAL-016: evidence % is not a record this person can see here',
        new.evidence_object_id
        using errcode = 'check_violation';
    end if;
    if v_req.evidence_mode = 'acknowledge' then
      -- What is acknowledged is one of the requirement's own resources.
      if not exists (select 1 from jsonb_array_elements(coalesce(v_req.definition -> 'resources',
                                                                 '[]'::jsonb)) e
                      where e ->> 'id' = new.evidence_object_id::text) then
        raise exception 'KF-QUAL-016: an acknowledgement names one of the requirement''s resources'
          using errcode = 'check_violation';
      end if;
      -- Received and reviewed: a person cannot have reviewed what they are not granted. That is
      -- the organization's blocker (RQ-261), not an acknowledgement.
      if org.qualification_person_reaches(v_rec.person_id, v_rec.organization_id,
                                          new.evidence_object_id) <> 'readable' then
        raise exception 'KF-QUAL-017: % cannot be acknowledged: this person is not granted the '
          'resource, which is a blocker on the organization (KF-SAS-RQ-261)', new.requirement_key
          using errcode = 'check_violation';
      end if;
    else
      if v_creator = v_actor then
        raise exception 'KF-QUAL-015: a reviewer does not credit work they made (KF-SAS-RQ-047)'
          using errcode = 'check_violation';
      end if;
      select v.verified_by, v.basis into v_verifier, v_basis
        from core.object_verification v where v.object_id = new.evidence_object_id;
      if v_verifier is null or v_basis is distinct from 'reviewed_individually'
         or v_verifier = v_rec.person_id then
        raise exception 'KF-QUAL-016: evidence % is not accepted work: it must be reviewed '
          'individually by someone other than the person, as the crediting act does when it '
          'accepts the work', new.evidence_object_id
          using errcode = 'check_violation';
      end if;
    end if;
  else
    perform core.seal_setting('kf.qualification_subject', v_rec.person_id::text, true);
    select * into v_prior from org.qualification_credit c where c.id = new.prior_credit_id;
    perform core.seal_setting('kf.qualification_subject', v_subject, true);
    if v_prior.id is null or v_prior.person_id is distinct from v_rec.person_id
       or v_prior.organization_id is distinct from v_rec.organization_id then
      raise exception 'KF-QUAL-016: prior credit % is not this person''s', new.prior_credit_id
        using errcode = 'check_violation';
    end if;
    if not (v_prior.requirement_key = new.requirement_key
            or coalesce(v_req.definition -> 'equivalent_to', '[]'::jsonb) ? v_prior.requirement_key) then
      raise exception 'KF-QUAL-016: % does not declare % equivalent; one task is not evidence of an '
        'unrelated one (KF-SAS-RQ-256)', new.requirement_key, v_prior.requirement_key
        using errcode = 'check_violation';
    end if;
    if v_prior.evidence_mode <> v_req.evidence_mode then
      raise exception 'KF-QUAL-016: a credit % is not % (KF-SAS-RQ-256: a mode is never upgraded)',
        v_prior.evidence_mode, v_req.evidence_mode
        using errcode = 'check_violation';
    end if;
  end if;

  new.organization_id := v_rec.organization_id;
  new.person_id := v_rec.person_id;
  new.contact_person_id := v_rec.contact_person_id;
  new.pack_id := v_rec.pack_id;
  new.pack_revision := v_rec.pack_revision;
  new.requirement_revision := v_req.revision;
  new.evidence_mode := v_req.evidence_mode;
  new.credited_by := v_actor;
  new.credited_by_action := core.current_action_id();
  new.credited_at := now();
  return new;
end
$$;

revoke all on function org.qualification_credit_bounded() from public;

create trigger qualification_credit_bounded
  before insert or update or delete on org.qualification_credit
  for each row execute function org.qualification_credit_bounded();

-- Invitations: the owner's act, never the application's.
create function org.invitation_bounded() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
begin
  if core.session_is_administrator() then
    return coalesce(new, old);
  end if;
  raise exception 'KF-QUAL-040: an invitation is written by the owner credential, with the person, '
    'identity link and role assignment it accompanies (KF-SAS-RQ-236)'
    using errcode = 'check_violation';
end
$$;

revoke all on function org.invitation_bounded() from public;

create trigger invitation_bounded
  before insert or update or delete on org.invitation
  for each row execute function org.invitation_bounded();

-- Accepting: the record enters `qualified` only complete, by someone with the authority to close
-- it, never its own person. Deferred: the dispatcher moves the state before the act's effect
-- writes the credits that complete it, and by commit both are there.
create function org.qualification_record_closes() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_rec      org.qualification_record%rowtype;
  v_rev      org.qualification_pack_revision%rowtype;
  v_actor    uuid := core.current_actor_or_null();
  v_missing  record;
  v_names    text;
begin
  if core.session_is_administrator() then
    return null;
  end if;
  select * into v_rec from org.qualification_record where id = new.id;
  if not found then
    raise exception 'KF-QUAL-021: qualification record % is not one this person may accept', new.id
      using errcode = 'check_violation';
  end if;
  select * into v_rev from org.qualification_pack_revision
   where pack_id = v_rec.pack_id and revision = v_rec.pack_revision;
  if v_actor = v_rec.person_id then
    raise exception 'KF-QUAL-021: a person does not accept their own qualification (KF-SAS-RQ-047)'
      using errcode = 'check_violation';
  end if;
  if v_rev.closing = 'on_acceptance' then
    if not org.qualification_holds_role(v_actor, v_rec.organization_id, v_rev.acceptor_role) then
      raise exception 'KF-QUAL-021: this pack''s records are accepted by a holder of %',
        v_rev.acceptor_role
        using errcode = 'check_violation';
    end if;
  elsif v_actor is distinct from v_rec.contact_person_id
        and not org.qualification_reviews_pack(v_rec.pack_id, v_rec.pack_revision) then
    raise exception 'KF-QUAL-021: a record is closed by its contact or by a reviewer of its pack'
      using errcode = 'check_violation';
  end if;
  select string_agg(format('%s (revision %s): %s', m.requirement_key, m.revision, m.outcome), '; '
                    order by m.requirement_key)
    into v_names
    from org.qualification_record_missing(new.id) m;
  if v_names is not null then
    raise exception 'KF-QUAL-020: the record cannot close while mandatory requirements lack '
      'current evidence: %', v_names
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

revoke all on function org.qualification_record_closes() from public;

create constraint trigger qualification_record_closes
  after update on core.object
  deferrable initially deferred
  for each row
  when (new.object_type = 'qualification_record' and new.lifecycle_state = 'qualified'
        and old.lifecycle_state is distinct from new.lifecycle_state)
  execute function org.qualification_record_closes();

-- 7. Row security -------------------------------------------------------------------------------

alter table org.qualification_pack enable row level security;
alter table org.qualification_pack force row level security;
alter table org.qualification_pack_revision enable row level security;
alter table org.qualification_pack_revision force row level security;
alter table org.qualification_requirement_revision enable row level security;
alter table org.qualification_requirement_revision force row level security;
alter table org.qualification_pack_requirement enable row level security;
alter table org.qualification_pack_requirement force row level security;
alter table org.qualification_record enable row level security;
alter table org.qualification_record force row level security;
alter table org.qualification_evidence_submission enable row level security;
alter table org.qualification_evidence_submission force row level security;
alter table org.qualification_credit enable row level security;
alter table org.qualification_credit force row level security;
alter table org.invitation enable row level security;
alter table org.invitation force row level security;

-- Packs are the organization's public statement of what each scope requires (decision 12: "public
-- role packs do not make individual records public"): read by its members.
create policy qualification_pack_read on org.qualification_pack
  for select using (
    organization_id = (select core.current_organization())
    and exists (select 1 from core.object envelope where envelope.id = qualification_pack.id)
  );
create policy qualification_pack_insert on org.qualification_pack
  for insert with check (
    organization_id = (select core.current_organization())
    and exists (select 1 from core.object envelope where envelope.id = qualification_pack.id)
  );

create policy qualification_pack_revision_read on org.qualification_pack_revision
  for select using (organization_id = (select core.current_organization()));
create policy qualification_pack_revision_insert on org.qualification_pack_revision
  for insert with check (
    organization_id = (select core.current_organization())
    and drafted_by_action = (select core.current_action_id())
  );
create policy qualification_pack_revision_approve on org.qualification_pack_revision
  for update
  using (organization_id = (select core.current_organization()))
  with check (
    organization_id = (select core.current_organization())
    and approved_by_action = (select core.current_action_id())
  );

create policy qualification_requirement_revision_read on org.qualification_requirement_revision
  for select using (organization_id = (select core.current_organization()));
create policy qualification_requirement_revision_insert on org.qualification_requirement_revision
  for insert with check (organization_id = (select core.current_organization()));

create policy qualification_pack_requirement_read on org.qualification_pack_requirement
  for select using (organization_id = (select core.current_organization()));
create policy qualification_pack_requirement_insert on org.qualification_pack_requirement
  for insert with check (organization_id = (select core.current_organization()));

-- A record: its person, its contact, the people who may credit it, and anyone who has.
create policy qualification_record_read on org.qualification_record
  for select using (
    organization_id = (select core.current_organization())
    and exists (select 1 from core.object envelope where envelope.id = qualification_record.id)
    and (
      person_id = (select core.current_principal_or_null())
      or contact_person_id = (select core.current_principal_or_null())
      or person_id = (select org.qualification_subject_or_null())
      or org.qualification_reviews_pack(pack_id, pack_revision)
      or exists (select 1 from org.qualification_credit c
                  where c.record_id = qualification_record.id
                    and c.credited_by = (select core.current_principal_or_null()))
    )
  );
create policy qualification_record_insert on org.qualification_record
  for insert with check (
    organization_id = (select core.current_organization())
    and assigned_by_action = (select core.current_action_id())
    and exists (select 1 from core.object envelope where envelope.id = qualification_record.id)
  );

create policy qualification_submission_read on org.qualification_evidence_submission
  for select using (
    organization_id = (select core.current_organization())
    and (
      person_id = (select core.current_principal_or_null())
      or contact_person_id = (select core.current_principal_or_null())
      or person_id = (select org.qualification_subject_or_null())
      or org.qualification_reviews_pack(pack_id, pack_revision)
    )
  );
create policy qualification_submission_insert on org.qualification_evidence_submission
  for insert with check (
    organization_id = (select core.current_organization())
    and person_id = (select core.current_actor_or_null())
    and submitted_by_action = (select core.current_action_id())
  );

create policy qualification_credit_read on org.qualification_credit
  for select using (
    organization_id = (select core.current_organization())
    and (
      person_id = (select core.current_principal_or_null())
      or contact_person_id = (select core.current_principal_or_null())
      or credited_by = (select core.current_principal_or_null())
      or person_id = (select org.qualification_subject_or_null())
      or org.qualification_reviews_pack(pack_id, pack_revision)
    )
  );
create policy qualification_credit_insert on org.qualification_credit
  for insert with check (
    organization_id = (select core.current_organization())
    and credited_by = (select core.current_actor_or_null())
    and credited_by_action = (select core.current_action_id())
  );

create policy invitation_read on org.invitation
  for select using (
    organization_id = (select core.current_organization())
    and person_id = (select core.current_principal_or_null())
  );

-- Auditors and the backup login read everything, as on every governed table.
create policy qualification_pack_auditor_read on org.qualification_pack for select to kf_auditor using (true);
create policy qualification_pack_backup_read on org.qualification_pack for select to kf_backup using (true);
create policy qualification_pack_revision_auditor_read on org.qualification_pack_revision for select to kf_auditor using (true);
create policy qualification_pack_revision_backup_read on org.qualification_pack_revision for select to kf_backup using (true);
create policy qualification_requirement_revision_auditor_read on org.qualification_requirement_revision for select to kf_auditor using (true);
create policy qualification_requirement_revision_backup_read on org.qualification_requirement_revision for select to kf_backup using (true);
create policy qualification_pack_requirement_auditor_read on org.qualification_pack_requirement for select to kf_auditor using (true);
create policy qualification_pack_requirement_backup_read on org.qualification_pack_requirement for select to kf_backup using (true);
create policy qualification_record_auditor_read on org.qualification_record for select to kf_auditor using (true);
create policy qualification_record_backup_read on org.qualification_record for select to kf_backup using (true);
create policy qualification_submission_auditor_read on org.qualification_evidence_submission for select to kf_auditor using (true);
create policy qualification_submission_backup_read on org.qualification_evidence_submission for select to kf_backup using (true);
create policy qualification_credit_auditor_read on org.qualification_credit for select to kf_auditor using (true);
create policy qualification_credit_backup_read on org.qualification_credit for select to kf_backup using (true);
create policy invitation_auditor_read on org.invitation for select to kf_auditor using (true);
create policy invitation_backup_read on org.invitation for select to kf_backup using (true);

revoke all on org.qualification_pack, org.qualification_pack_revision,
              org.qualification_requirement_revision, org.qualification_pack_requirement,
              org.qualification_record, org.qualification_evidence_submission,
              org.qualification_credit, org.invitation
  from public;
grant select, insert on org.qualification_pack, org.qualification_pack_revision,
                        org.qualification_requirement_revision, org.qualification_pack_requirement,
                        org.qualification_record, org.qualification_evidence_submission,
                        org.qualification_credit
  to kf_app;
grant update (approved_by, approved_by_action, approved_at) on org.qualification_pack_revision
  to kf_app;
grant select on org.invitation to kf_app;
grant select on org.qualification_pack, org.qualification_pack_revision,
                org.qualification_requirement_revision, org.qualification_pack_requirement,
                org.qualification_record, org.qualification_evidence_submission,
                org.qualification_credit, org.invitation
  to kf_readonly, kf_auditor, kf_backup;
-- The payload walk reads every org table that references core.object (20260925121600), under
-- the reader's row security, and the worker may run it: with no principal bound, the record,
-- submission and credit policies admit nothing.
grant select on org.qualification_pack, org.qualification_pack_revision,
                org.qualification_requirement_revision, org.qualification_pack_requirement,
                org.qualification_record, org.qualification_evidence_submission,
                org.qualification_credit
  to kf_worker;

-- 8. The guards every new table inherits ---------------------------------------------------------

-- Every row kf_app writes here belongs to an act recorded in this transaction (20260925011000).
select core.install_action_context_guards();

-- The typed rows and credits are read by the payload walk of a reader granted the envelope, so a
-- write to them is a write to an input of a master record (20260926110100). The pack tables and
-- invitations are not read by any permitted set; they still carry the note, which costs a currency
-- check its shortcut and never its soundness.
select content.install_master_record_input_triggers();

-- migrate:down

drop trigger if exists qualification_record_closes on core.object;
drop function if exists org.qualification_record_closes();
drop trigger if exists action_qualification_agent_bar on core.action;
drop function if exists core.qualification_agent_bar();
drop trigger if exists action_requires_qualification on core.action;
drop function if exists core.action_requires_qualification();

drop table org.invitation;
drop table org.qualification_credit;
drop table org.qualification_evidence_submission;
drop table org.qualification_record;
drop table org.qualification_pack_requirement;
drop table org.qualification_requirement_revision;
drop table org.qualification_pack_revision;
drop table org.qualification_pack;

drop function org.invitation_bounded();
drop function org.qualification_credit_bounded();
drop function org.qualification_submission_bounded();
drop function org.qualification_record_bounded();
drop function org.qualification_pack_bounded();
drop function org.qualification_record_missing(uuid);
drop function org.qualification_resource_reach(uuid);
drop function org.qualification_person_reaches(uuid, uuid, uuid);
drop function org.qualification_credits_for_record(uuid);
drop function org.qualification_gaps_for_act(uuid, uuid, text, uuid[]);
drop function org.qualification_credit_is_current(uuid, uuid, text, text, integer);
drop function org.qualification_requirement_in_force(uuid, text);
drop function org.qualification_subject_or_null();
drop function org.qualification_reviews_pack(uuid, integer);
drop function org.qualification_role_has_holder(uuid, text, uuid);
drop function org.qualification_holds_role(uuid, uuid, text);
drop function org.qualification_person_is_live(uuid);

alter table registry.action_type drop column requires_qualification;
