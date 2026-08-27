-- migrate:up

-- OW-WAR-0054 M2E/M2F.
-- Person vetting and assignment need-to-know are different facts and therefore live in
-- different rows. A clearance change must not rewrite an assignment's authorization history.
alter table org.role_assignment
  add column classification_ceiling text references registry.classification (id);

create table org.person_clearance (
  id                 uuid primary key default uuidv7(),
  subject_id         uuid not null references org.person (id) on delete restrict,
  organization_id    uuid not null references org.organization (id) on delete restrict,
  max_classification text not null references registry.classification (id),
  valid_from         timestamptz not null default now(),
  valid_to           timestamptz,
  granted_by         uuid not null references org.person (id) on delete restrict,
  granted_at         timestamptz not null default now(),
  granted_by_action  uuid not null references core.action (id) on delete restrict,
  reason             text not null check (length(btrim(reason)) > 0),
  constraint person_clearance_interval_ordered
    check (valid_to is null or valid_to > valid_from),
  constraint person_clearance_subject_org_distinct
    check (subject_id is not null and organization_id is not null),
  unique (id, subject_id, organization_id)
);

create extension if not exists btree_gist;
alter table org.person_clearance
  add constraint person_clearance_no_overlap
  exclude using gist (
    subject_id with =,
    organization_id with =,
    tstzrange(valid_from, valid_to) with &&
  );

create table org.person_clearance_retirement (
  clearance_id      uuid primary key references org.person_clearance (id) on delete restrict,
  retired_at        timestamptz not null default now(),
  retired_by        uuid not null references org.person (id) on delete restrict,
  retirement_reason text not null check (length(btrim(retirement_reason)) > 0),
  retired_by_action uuid not null references core.action (id) on delete restrict
);

create table content.person_entitlement_exclusion (
  id              uuid primary key default uuidv7(),
  subject_id      uuid not null references org.person (id) on delete restrict,
  organization_id uuid not null references org.organization (id) on delete restrict,
  object_id       uuid not null references core.object (id) on delete restrict,
  reason_class    text not null check (reason_class in ('legal_hold', 'exclusion', 'third_party')),
  reason          text not null check (length(btrim(reason)) > 0),
  authorizer      uuid not null references org.person (id) on delete restrict,
  created_at      timestamptz not null default now(),
  created_by_action uuid not null references core.action (id) on delete restrict,
  released_at     timestamptz,
  released_by_action uuid references core.action (id) on delete restrict,
  unique (id, subject_id, organization_id)
);

create index person_entitlement_exclusion_lookup
  on content.person_entitlement_exclusion (subject_id, organization_id, object_id)
  where released_at is null;

comment on table org.person_clearance is
  'Organization-scoped, effective-dated personnel vetting. Never a column on org.person.';
comment on table org.person_clearance_retirement is
  'Append-only retirement of a clearance version; the original grant remains evidence.';
comment on column org.role_assignment.classification_ceiling is
  'Need-to-know cap for this assignment. Null means no additional cap beyond person clearance.';
comment on table content.person_entitlement_exclusion is
  'Subtractive entitlement. Empty rows mean every permission-set member remains visible.';

-- Resolve both facts under explicit predicates before the application binds transaction RLS.
-- SECURITY DEFINER is intentional: calling with an untrusted ceiling must never be required to
-- read the clearance row that decides whether that ceiling is allowed. The function returns only
-- the caller's decision and uses a fixed search path so caller objects cannot shadow names.
create or replace function org.resolve_effective_classification(
  p_subject uuid,
  p_organization uuid,
  p_assignment uuid,
  p_requested text
) returns table (
  subject_id uuid,
  organization_id uuid,
  assignment_id uuid,
  person_clearance text,
  assignment_ceiling text,
  effective_classification text,
  requested_classification text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, org, registry, core
as $$
declare
  v_person text;
  v_assignment text;
  v_effective text;
  v_requested text;
  v_person_rank integer;
  v_assignment_rank integer;
  v_effective_rank integer;
  v_requested_rank integer;
begin
  select pc.max_classification, ra.classification_ceiling
    into v_person, v_assignment
    from org.person_clearance pc
    join org.role_assignment ra
      on ra.id = p_assignment
     and ra.subject_id = p_subject
     and ra.valid_from <= now()
     and (ra.valid_to is null or ra.valid_to > now())
    join core.object assignment_object
      on assignment_object.id = ra.id
     and assignment_object.organization_id = p_organization
   where pc.subject_id = p_subject
     and pc.organization_id = p_organization
     and pc.valid_from <= now()
     and (pc.valid_to is null or pc.valid_to > now())
     and not exists (
       select 1 from org.person_clearance_retirement retired
        where retired.clearance_id = pc.id
     )
   order by pc.valid_from desc
   limit 1;

  if v_person is null then
    raise exception 'classification clearance is not granted for this person and organization'
      using errcode = 'insufficient_privilege';
  end if;

  v_person_rank := (select c.rank from registry.classification c where c.id = v_person);
  v_assignment_rank := coalesce(
    (select c.rank from registry.classification c where c.id = v_assignment),
    v_person_rank
  );
  if v_assignment_rank < v_person_rank then
    v_effective := v_assignment;
    v_effective_rank := v_assignment_rank;
  else
    v_effective := v_person;
    v_effective_rank := v_person_rank;
  end if;

  v_requested := coalesce(nullif(btrim(p_requested), ''), v_effective);
  select c.rank into v_requested_rank
    from registry.classification c where c.id = v_requested;
  if v_requested_rank is null then
    raise exception 'unknown classification %', v_requested
      using errcode = 'invalid_parameter_value';
  end if;
  if v_requested_rank > v_effective_rank then
    raise exception 'requested classification % exceeds effective clearance %',
      v_requested, v_effective
      using errcode = 'insufficient_privilege';
  end if;

  return query select p_subject, p_organization, p_assignment, v_person, v_assignment,
                      v_effective, v_requested;
end;
$$;

revoke all on function org.resolve_effective_classification(uuid, uuid, uuid, text) from public;
grant execute on function org.resolve_effective_classification(uuid, uuid, uuid, text) to kf_app;

create or replace function org.resolve_identity_role(
  p_issuer text,
  p_subject text,
  p_organization uuid,
  p_assignment uuid
) returns table (
  person_id uuid,
  identity_revoked boolean,
  role_held boolean
)
language sql
stable
security definer
set search_path = pg_catalog, org, registry, core
as $$
  select identity.person_id,
         identity.revoked_at is not null,
         exists (
           select 1
             from org.role_assignment assignment
             join core.object assignment_object on assignment_object.id = assignment.id
            where assignment.id = p_assignment
              and assignment.subject_id = identity.person_id
              and assignment_object.organization_id = p_organization
              and assignment_object.lifecycle_state = 'active'
              and assignment.valid_from <= now()
              and (assignment.valid_to is null or assignment.valid_to > now())
         )
    from org.external_identity identity
   where identity.issuer = p_issuer
     and identity.subject = p_subject
   order by (identity.revoked_at is null) desc, identity.linked_at desc
   limit 1
$$;

revoke all on function org.resolve_identity_role(text, text, uuid, uuid) from public;
grant execute on function org.resolve_identity_role(text, text, uuid, uuid) to kf_app;

alter table org.person_clearance enable row level security;
alter table org.person_clearance force row level security;
create policy person_clearance_scope on org.person_clearance
  for select using (
    organization_id = core.current_organization()
    and exists (select 1 from core.object envelope where envelope.id = person_clearance.subject_id)
  );
create policy person_clearance_write on org.person_clearance
  for insert with check (
    organization_id = core.current_organization()
    and granted_by = core.current_actor()
    and granted_by_action = core.current_action_id()
    and exists (select 1 from core.object envelope where envelope.id = person_clearance.subject_id)
  );

alter table org.person_clearance_retirement enable row level security;
alter table org.person_clearance_retirement force row level security;
create policy person_clearance_retirement_scope on org.person_clearance_retirement
  for select using (exists (
    select 1 from org.person_clearance clearance
     where clearance.id = person_clearance_retirement.clearance_id
  ));

alter table content.person_entitlement_exclusion enable row level security;
alter table content.person_entitlement_exclusion force row level security;
create policy person_entitlement_exclusion_scope on content.person_entitlement_exclusion
  for select using (
    organization_id = core.current_organization()
    and exists (select 1 from core.object envelope where envelope.id = object_id)
  );
create policy person_entitlement_exclusion_write on content.person_entitlement_exclusion
  for insert with check (
    organization_id = core.current_organization()
    and authorizer = core.current_actor()
    and created_by_action = core.current_action_id()
    and exists (select 1 from core.object envelope where envelope.id = object_id)
  );

grant select on org.person_clearance, org.person_clearance_retirement,
                     content.person_entitlement_exclusion to kf_app, kf_worker, kf_readonly,
                     kf_auditor, kf_backup;
grant insert on org.person_clearance, content.person_entitlement_exclusion to kf_app;
grant usage, select on all sequences in schema org, content to kf_app;

-- migrate:down
-- kf:forward-only reverting clearance and entitlement policy would restore caller-asserted access
