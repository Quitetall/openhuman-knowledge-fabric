-- migrate:up

-- ── 1. the session ceiling is the person's clearance; the role's ceiling caps its grant ───
--
-- `org.resolve_effective_classification` took the LOWER of the person's clearance and the
-- acting role assignment's `classification_ceiling` as the ceiling bound to the session. That
-- made the role ceiling cap everything the session could see — including an object-scoped
-- `grant_access` to a record above it, which was therefore recorded and unreachable. The
-- first customer contact in the fixture company had exactly that: cleared to `confidential`
-- for their own agreement, capped at `public` through their role, and unable to see their
-- own person object.
--
-- The role ceiling means what `org.effective_access_grant` already says it means: the cap on
-- the organization-wide read grant that a role assignment IS. The clearance is the ceiling on
-- the session. What a person may read is then decided the way ADR 0016 says — by a grant that
-- reaches the object — and every read surface checks that grant (this release), not only the
-- master record.
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
  v_requested text;
  v_person_rank integer;
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

  v_requested := coalesce(nullif(btrim(p_requested), ''), v_person);
  select c.rank into v_requested_rank
    from registry.classification c where c.id = v_requested;
  if v_requested_rank is null then
    raise exception 'unknown classification %', v_requested
      using errcode = 'invalid_parameter_value';
  end if;
  if v_requested_rank > v_person_rank then
    raise exception 'requested classification % exceeds clearance %', v_requested, v_person
      using errcode = 'insufficient_privilege';
  end if;

  return query select p_subject, p_organization, p_assignment, v_person, v_assignment,
                      v_person, v_requested;
end;
$$;

-- ── 2. two minimal answers for the bootstrap tier ───────────────────────────────────────
--
-- A bootstrap-tier command runs on the owner login, which on a host is NOT the table owner
-- and therefore sees `org.person` and `org.organization` only under a bound organization.
-- It has to find the organization by name before it can bind one, and it has to verify a
-- decider who may belong to another organization. Each answer is the smallest that serves.
create function org.organization_by_name(p_legal_name text)
  returns uuid
  language sql
  stable
  security definer
  set search_path = pg_catalog, org
as $$
  select o.id from org.organization o
   where lower(btrim(o.legal_name)) = lower(btrim(p_legal_name)) and o.retired_at is null
   limit 1
$$;
revoke execute on function org.organization_by_name(text) from public;
grant execute on function org.organization_by_name(text) to kf_owner_role, kf_app;

create function org.person_lookup(p_person uuid)
  returns table (present boolean, organization uuid, display_name text)
  language sql
  stable
  security definer
  set search_path = pg_catalog, org
as $$
  select exists (select 1 from org.person p where p.id = p_person),
         (select p.organization from org.person p where p.id = p_person),
         (select p.display_name from org.person p where p.id = p_person)
$$;
revoke execute on function org.person_lookup(uuid) from public;
grant execute on function org.person_lookup(uuid) to kf_owner_role, kf_app;

-- ── 3. one vocabulary for artifact_kind ─────────────────────────────────────────────────
--
-- `content.artifact.artifact_kind` was checked against a list the ontology never had
-- (cad_assembly … report, specification … other) while `ontology/object-types.yaml` — the
-- R01-approved definition, byte-identical by test — declares document, cad, drawing, bom,
-- source_code, binary, dataset, model, test_evidence, message_snapshot, invoice_evidence,
-- payment_evidence, other. The ontology is the definition; the column follows it. Existing
-- values map to their nearest ontology kind and the mapping is this migration's record.
alter table content.artifact drop constraint artifact_artifact_kind_check;
update content.artifact set artifact_kind = case artifact_kind
  when 'cad_assembly'     then 'cad'
  when 'cad_part'         then 'cad'
  when 'pcb_layout'       then 'cad'
  when 'schematic'        then 'drawing'
  when 'drawing'          then 'drawing'
  when 'firmware_build'   then 'binary'
  when 'source_archive'   then 'source_code'
  when 'dataset'          then 'dataset'
  when 'report'           then 'document'
  when 'specification'    then 'document'
  when 'certificate'      then 'document'
  when 'photograph'       then 'other'
  when 'measurement'      then 'test_evidence'
  when 'invoice_evidence' then 'invoice_evidence'
  when 'correspondence'   then 'message_snapshot'
  else artifact_kind end
where artifact_kind not in ('document', 'cad', 'drawing', 'bom', 'source_code', 'binary',
  'dataset', 'model', 'test_evidence', 'message_snapshot', 'invoice_evidence',
  'payment_evidence', 'other');
-- `content.record_compilation_result` (20260814000400) inserts the compiled view's artifact
-- as `'report'`. The function is two hundred lines of which one word is wrong; its definition
-- is rewritten with that one word changed rather than restated in full, so the change IS the
-- diff and nothing else about the function can drift here.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('content.record_compilation_result(uuid, jsonb, jsonb)'::regprocedure);
  if position('''report'', ''object_store''' in v_def) = 0 then
    raise exception 'record_compilation_result no longer inserts ''report''; review this migration';
  end if;
  execute replace(v_def, '''report'', ''object_store''', '''document'', ''object_store''');
end $$;

alter table content.artifact add constraint artifact_artifact_kind_check
  check (artifact_kind in ('document', 'cad', 'drawing', 'bom', 'source_code', 'binary',
    'dataset', 'model', 'test_evidence', 'message_snapshot', 'invoice_evidence',
    'payment_evidence', 'other'));

-- ── 4. a person and an organization are the lowest tier of their own tenancy ────────────
--
-- Every person and organization object was `internal`, the envelope default. A member of
-- the organization capped at `public` therefore could not see their own person object, the
-- organization they belong to, or the target of their own `compile_master_record`.
-- `public` here is the lowest classification INSIDE a tenancy that row-level security
-- already scopes to one organization; it is not publication, which remains an act.
--
-- Reclassification is a write to `core.object`: it needs a transaction context (the guard
-- names the remedy) and, under forced row-level security, the organization bound. The
-- bootstrap identity is the actor, as for every act nobody performed by hand.
do $$
declare
  org record;
begin
  perform core.set_transaction_context(
    '01930000-0000-7000-8000-00000000b007'::uuid,
    '01930000-0000-7000-8000-00000000b007'::uuid,
    '01930000-0000-7000-8000-0000000000a2'::uuid,
    'migration-20260911000200');
  for org in select id from org.organization loop
    perform core.set_access_context(org.id, 'restricted');
    update core.object
       set classification = 'public', row_version = row_version + 1
     where organization_id = org.id
       and object_type in ('person', 'organization')
       and classification <> 'public';
  end loop;
end $$;

-- migrate:down

alter table content.artifact drop constraint artifact_artifact_kind_check;
alter table content.artifact add constraint artifact_artifact_kind_check
  check (artifact_kind in ('cad_assembly', 'cad_part', 'drawing', 'schematic', 'pcb_layout',
    'firmware_build', 'source_archive', 'dataset', 'report', 'specification', 'photograph',
    'measurement', 'certificate', 'invoice_evidence', 'correspondence', 'other'));
drop function org.person_lookup(uuid);
drop function org.organization_by_name(text);
-- The resolver's previous body is in 20260826000200_classification_clearance_entitlement.sql;
-- the classification of people and organizations is not reverted — a lower tier is not a loss.
