-- migrate:up

-- Operational document compilation boundary.
--
-- Expensive input reads, Liminal execution and output writes happen outside PostgreSQL
-- transactions. These two narrow functions expose only one exact authorized request and
-- atomically record only its terminal derived receipt. They do not approve, publish,
-- allocate an enterprise identifier or change authored source authority.

-- Compiler identity and qualification are owner-controlled deployment facts. Registrations
-- are immutable; disabling one is an append-only revocation. Application and worker roles
-- receive no table privileges and can only consume a checked projection through the two
-- SECURITY DEFINER runtime functions below.
create table content.document_compiler_registration (
  id                           uuid primary key default uuidv7(),
  compiler_name                text not null check (length(btrim(compiler_name)) > 0),
  compiler_version             text not null check (length(btrim(compiler_version)) > 0),
  protocol                     text not null check (protocol = 'kf-document-v1'),
  liminal_commit_sha           text not null check (liminal_commit_sha ~ '^[0-9a-f]{40}$'),
  cargo_lock_digest            text not null check (cargo_lock_digest ~ '^[0-9a-f]{64}$'),
  executable_digest            text not null check (executable_digest ~ '^[0-9a-f]{64}$'),
  qualification_state          text not null check (
                                  qualification_state in (
                                    'not_run', 'incomplete', 'unratified', 'qualified'
                                  )
                                ),
  qualification_receipt_digest text check (
                                  qualification_receipt_digest is null
                                  or qualification_receipt_digest ~ '^[0-9a-f]{64}$'
                                ),
  qualification_ratified       boolean not null default false,
  registered_at                timestamptz not null default now(),
  registered_by                uuid not null,

  constraint document_compiler_registration_qualification check (
    (qualification_state = 'qualified'
      and qualification_ratified and qualification_receipt_digest is not null)
    or
    (qualification_state <> 'qualified' and not qualification_ratified)
  )
);

create unique index document_compiler_registration_identity
  on content.document_compiler_registration (
    compiler_name, compiler_version, protocol, liminal_commit_sha,
    cargo_lock_digest, executable_digest, qualification_state,
    coalesce(qualification_receipt_digest, ''), qualification_ratified
  );

create table content.document_compiler_revocation (
  registration_id  uuid primary key references content.document_compiler_registration (id)
                     on delete restrict,
  revoked_at        timestamptz not null default now(),
  revoked_by        uuid not null,
  revocation_reason text not null check (length(btrim(revocation_reason)) > 0)
);

create function content.refuse_duplicate_enabled_compiler() returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'kf-document-compiler-pin:' || new.compiler_name || ':' || new.compiler_version || ':'
      || new.protocol || ':' || new.liminal_commit_sha || ':' || new.cargo_lock_digest || ':'
      || new.executable_digest,
      0
    )
  );
  if exists (
    select 1 from content.document_compiler_registration r
     where r.compiler_name = new.compiler_name
       and r.compiler_version = new.compiler_version
       and r.protocol = new.protocol
       and r.liminal_commit_sha = new.liminal_commit_sha
       and r.cargo_lock_digest = new.cargo_lock_digest
       and r.executable_digest = new.executable_digest
       and not exists (
         select 1 from content.document_compiler_revocation revoked
          where revoked.registration_id = r.id
       )
  ) then
    raise exception 'an enabled registration already exists for this compiler pin'
      using errcode = 'unique_violation';
  end if;
  return new;
end
$$;

create trigger document_compiler_registration_one_enabled_pin
  before insert on content.document_compiler_registration
  for each row execute function content.refuse_duplicate_enabled_compiler();

create trigger document_compiler_registration_append_only
  before update or delete or truncate on content.document_compiler_registration
  for each statement execute function core.refuse_mutation();
create trigger document_compiler_revocation_append_only
  before update or delete or truncate on content.document_compiler_revocation
  for each statement execute function core.refuse_mutation();

revoke all on content.document_compiler_registration, content.document_compiler_revocation
  from public, kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
revoke all on function content.refuse_duplicate_enabled_compiler() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

-- Compiler pins and revocations are owner-controlled, but preservation must still see the
-- complete append-only registry. FORCE RLS makes every delegated table access explicit:
-- kf_backup can only SELECT, while kf_migrator is the narrow owner/SECURITY DEFINER authority
-- that can read pins and append registrations or revocations. Mutation triggers remain final.
grant usage on schema content to kf_migrator;
alter table content.document_compiler_registration enable row level security;
alter table content.document_compiler_registration force row level security;
create policy document_compiler_registration_backup
  on content.document_compiler_registration for select to kf_backup using (true);
create policy document_compiler_registration_authority_read
  on content.document_compiler_registration for select to kf_migrator using (true);
create policy document_compiler_registration_authority_insert
  on content.document_compiler_registration for insert to kf_migrator with check (true);
alter table content.document_compiler_revocation enable row level security;
alter table content.document_compiler_revocation force row level security;
create policy document_compiler_revocation_backup
  on content.document_compiler_revocation for select to kf_backup using (true);
create policy document_compiler_revocation_authority_read
  on content.document_compiler_revocation for select to kf_migrator using (true);
create policy document_compiler_revocation_authority_insert
  on content.document_compiler_revocation for insert to kf_migrator with check (true);
grant select on content.document_compiler_registration, content.document_compiler_revocation
  to kf_backup;
grant select, insert on content.document_compiler_registration, content.document_compiler_revocation
  to kf_migrator;

alter table content.compilation_basis
  add column compiler_registration_id uuid
    references content.document_compiler_registration (id) on delete restrict;
alter table content.compilation_run
  add column compiler_registration_id uuid
    references content.document_compiler_registration (id) on delete restrict,
  add column hir_provenance jsonb not null default '[]'::jsonb
    check (jsonb_typeof(hir_provenance) = 'array'),
  add column cir_provenance jsonb not null default '[]'::jsonb
    check (jsonb_typeof(cir_provenance) = 'array'),
  add column unresolved_references jsonb not null default '[]'::jsonb
    check (jsonb_typeof(unresolved_references) = 'array'),
  add column omitted_subgraphs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(omitted_subgraphs) = 'array'),
  add column projection_capabilities jsonb not null default '[]'::jsonb
    check (jsonb_typeof(projection_capabilities) = 'array');

do $$
begin
  if exists (select 1 from content.compilation_basis)
     or exists (select 1 from content.compilation_run) then
    raise exception
      'compiler registry activation requires an explicit owner migration for existing Basis/run rows';
  end if;
end
$$;

alter table content.compilation_basis alter column compiler_registration_id set not null;
alter table content.compilation_run alter column compiler_registration_id set not null;

create function content.bind_compilation_basis_compiler() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
declare
  v_registration content.document_compiler_registration%rowtype;
  v_identity jsonb;
begin
  if new.compiler_kind <> 'liminal' then
    raise exception 'database compilation Basis requires an owner-registered Liminal compiler'
      using errcode = 'feature_not_supported';
  end if;
  select r.* into v_registration
    from content.document_compiler_registration r
   where r.compiler_name = new.compiler_name
     and r.compiler_version = new.compiler_version
     and r.protocol = new.protocol
     and r.liminal_commit_sha = new.liminal_commit_sha
     and r.cargo_lock_digest = new.cargo_lock_digest
     and r.executable_digest = new.executable_digest
     and not exists (
       select 1 from content.document_compiler_revocation revoked
        where revoked.registration_id = r.id
     );
  if not found then
    raise exception 'compilation request names no enabled owner-registered compiler pin'
      using errcode = 'insufficient_privilege';
  end if;

  v_identity := jsonb_build_object(
    'kind', 'liminal',
    'name', v_registration.compiler_name,
    'version', v_registration.compiler_version,
    'protocol', v_registration.protocol,
    'commitSha', v_registration.liminal_commit_sha,
    'cargoLockDigest', v_registration.cargo_lock_digest,
    'executableDigest', v_registration.executable_digest,
    'qualification', jsonb_build_object(
      'state', v_registration.qualification_state,
      'receiptDigest', v_registration.qualification_receipt_digest,
      'ratified', v_registration.qualification_ratified
    )
  );
  if new.qualification_state is distinct from v_registration.qualification_state
     or new.qualification_receipt_digest is distinct from
        v_registration.qualification_receipt_digest
     or new.qualification_ratified is distinct from v_registration.qualification_ratified
     or new.basis -> 'compiler' is distinct from v_identity then
    raise exception 'request compiler identity or qualification differs from owner registry'
      using errcode = 'integrity_constraint_violation';
  end if;
  new.compiler_registration_id := v_registration.id;
  return new;
end
$$;

revoke all on function content.bind_compilation_basis_compiler() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create trigger compilation_basis_guard_0_registry
  before insert on content.compilation_basis
  for each row execute function content.bind_compilation_basis_compiler();

-- The application retains narrow INSERT grants because the typed action effects execute as
-- kf_app. This trigger turns those grants into an exact open-action capability: actor, role,
-- request, action kind, single target and row provenance must all agree, and a committed action
-- cannot be replayed to append extra rows later.
create function content.enforce_document_typed_insert() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content, core, org
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_action core.action%rowtype;
  v_action_id uuid := core.current_action_id();
  v_actor uuid := core.current_actor();
  v_acting_role text := nullif(current_setting('kf.acting_role', true), '');
  v_request_id text := nullif(current_setting('kf.request_id', true), '');
  v_target uuid;
  v_origin_action uuid;
  v_payload jsonb;
  v_holder jsonb;
  v_expected_input jsonb;
  v_proposal content.proposal_overlay%rowtype;
begin
  select a.* into v_action from core.action a where a.id = v_action_id;
  if not found
     or not (v_action.action_type = any (TG_ARGV))
     or v_action.result_status <> 'applied'
     or v_action.actor_id is distinct from v_actor
     or v_action.acting_role_id::text is distinct from v_acting_role
     or v_action.request_id is distinct from v_request_id
     or not org.holds_role(v_action.actor_id, v_action.acting_role_id)
     or exists (select 1 from core.audit_event e where e.action_id = v_action.id) then
    raise exception '% insert requires its exact open typed action context', TG_TABLE_NAME
      using errcode = 'insufficient_privilege';
  end if;

  v_payload := v_action.parameters;
  if v_action.action_type = 'apply_document_proposal' then
    begin
      select p.* into strict v_proposal
        from content.proposal_overlay p
       where p.id = (v_action.parameters ->> 'proposal_id')::uuid
         and p.proposal_digest = v_action.parameters ->> 'proposal_digest'
         and jsonb_array_length(p.operations) = 1;
    exception
      when no_data_found or invalid_text_representation then
        raise exception 'proposal application action does not name one exact recorded proposal'
          using errcode = 'integrity_constraint_violation';
    end;
    v_payload := v_proposal.operations -> 0;
  end if;

  if v_row ? 'created_by_action'
     and (v_row ->> 'created_by_action')::uuid is distinct from v_action_id then
    raise exception '% created_by_action differs from active action', TG_TABLE_NAME
      using errcode = 'insufficient_privilege';
  end if;
  if v_row ? 'recorded_by_action'
     and (v_row ->> 'recorded_by_action')::uuid is distinct from v_action_id then
    raise exception '% recorded_by_action differs from active action', TG_TABLE_NAME
      using errcode = 'insufficient_privilege';
  end if;
  if v_row ? 'created_by'
     and (v_row ->> 'created_by')::uuid is distinct from v_actor then
    raise exception '% created_by differs from active actor', TG_TABLE_NAME
      using errcode = 'insufficient_privilege';
  end if;
  if v_row ? 'recorded_by'
     and (v_row ->> 'recorded_by')::uuid is distinct from v_actor then
    raise exception '% recorded_by differs from active actor', TG_TABLE_NAME
      using errcode = 'insufficient_privilege';
  end if;

  case TG_TABLE_NAME
    when 'document_subject' then
      v_target := (v_row ->> 'object_id')::uuid;
      if v_row ->> 'id' is distinct from v_row ->> 'object_id'
         or v_row ->> 'subject_kind' is distinct from (case v_action.action_type
              when 'add_authored_fragment' then 'fragment'
              when 'add_document_composition' then 'composition'
              else null
            end)
         or v_row ->> 'stable_key' is distinct from v_action.parameters ->> 'stable_key'
         or v_row ->> 'document_policy' is distinct from
            v_action.parameters ->> 'document_policy'
         or v_row ->> 'current_holder_id' is distinct from
            v_action.parameters ->> 'holder_id' then
        raise exception 'document subject differs from exact action parameters'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'document_source_holder' then
      select s.object_id into v_target
        from content.document_subject s where s.id = (v_row ->> 'subject_id')::uuid;
      v_holder := v_payload -> 'holder';
      if jsonb_typeof(v_holder) is distinct from 'object'
         or v_row ->> 'id' is distinct from v_payload ->> 'holder_id'
         or v_row ->> 'previous_holder_id' is distinct from
            v_payload ->> 'previous_holder_id'
         or v_row ->> 'holder_kind' is distinct from v_holder ->> 'kind'
         or v_row ->> 'fabric_artifact_version_id' is distinct from
            (case when v_holder ->> 'kind' = 'fabric_native'
                  then v_holder ->> 'artifact_version_id' else null end)
         or v_row ->> 'git_repository' is distinct from
            (case when v_holder ->> 'kind' = 'git' then v_holder ->> 'repository' else null end)
         or v_row ->> 'git_commit_sha' is distinct from
            (case when v_holder ->> 'kind' = 'git' then v_holder ->> 'commit_sha' else null end)
         or v_row ->> 'git_path' is distinct from
            (case when v_holder ->> 'kind' = 'git' then v_holder ->> 'path' else null end)
         or v_row ->> 'git_submodule_commit_sha' is distinct from
            (case when v_holder ->> 'kind' = 'git'
                  then v_holder ->> 'submodule_commit_sha' else null end)
         or v_row ->> 'external_authority' is distinct from
            (case when v_holder ->> 'kind' = 'external'
                  then v_holder ->> 'authority' else null end)
         or v_row ->> 'external_revision' is distinct from
            (case when v_holder ->> 'kind' = 'external'
                  then v_holder ->> 'revision' else null end)
         or v_row ->> 'content_digest' is distinct from v_holder ->> 'content_digest'
         or v_row -> 'conversion_loss' is distinct from
            (case when v_action.action_type = 'change_document_source_holder'
                  then coalesce(v_action.parameters -> 'conversion_loss', '[]'::jsonb)
                  else '[]'::jsonb end)
         or v_row ->> 'migration_reason' is distinct from
            (case when v_action.action_type = 'change_document_source_holder'
                  then v_action.reason else null end)
         or v_row ->> 'reversible_migration_plan' is distinct from
            (case when v_action.action_type = 'change_document_source_holder'
                  then v_action.parameters ->> 'reversible_migration_plan' else null end) then
        raise exception 'document Holder differs from exact action parameters'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'authored_fragment' then
      select s.object_id, s.created_by_action into v_target, v_origin_action
        from content.document_subject s where s.id = (v_row ->> 'id')::uuid;
      if v_row ->> 'id' is distinct from v_target::text then
        raise exception 'authored fragment differs from exact action target'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'document_composition' then
      select s.object_id, s.created_by_action into v_target, v_origin_action
        from content.document_subject s where s.id = (v_row ->> 'id')::uuid;
      if v_row ->> 'id' is distinct from v_target::text then
        raise exception 'document composition differs from exact action target'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'authored_fragment_revision' then
      select s.object_id into v_target
        from content.document_subject s where s.id = (v_row ->> 'fragment_id')::uuid;
      if v_row ->> 'id' is distinct from v_action.parameters ->> 'revision_id'
         or v_row ->> 'previous_revision_id' is distinct from
            (case when v_action.action_type = 'add_authored_fragment' then null
                  when v_action.action_type = 'apply_document_proposal'
                    then v_proposal.base_fragment_revision_id::text
                  else v_action.parameters ->> 'previous_revision_id' end)
         or v_row ->> 'holder_id' is distinct from
            (case when v_action.action_type = 'retire_authored_fragment'
                  then (select s.current_holder_id::text
                          from content.document_subject s
                         where s.id = (v_row ->> 'fragment_id')::uuid)
                  else v_payload ->> 'holder_id' end)
         or v_row ->> 'media_type' is distinct from v_payload ->> 'media_type'
         or v_row ->> 'classification' is distinct from v_payload ->> 'classification'
         or v_row ->> 'revision_state' is distinct from
            (case when v_action.action_type = 'retire_authored_fragment' then 'retired'
                  when v_action.action_type = 'apply_document_proposal' then 'draft'
                  else 'active' end)
         or v_row ->> 'content_digest' is distinct from
            (select h.content_digest
               from content.document_source_holder h
              where h.id = (v_row ->> 'holder_id')::uuid) then
        raise exception 'fragment revision differs from exact action parameters'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'composition_revision' then
      select s.object_id into v_target
        from content.document_subject s where s.id = (v_row ->> 'composition_id')::uuid;
      if v_row ->> 'id' is distinct from v_action.parameters ->> 'revision_id'
         or v_row ->> 'previous_revision_id' is distinct from
            (case when v_action.action_type = 'add_document_composition' then null
                  when v_action.action_type = 'apply_document_proposal'
                    then v_proposal.base_composition_revision_id::text
                  else v_action.parameters ->> 'previous_revision_id' end)
         or (select o.classification
               from content.document_subject s
               join core.object o on o.id = s.object_id
              where s.id = (v_row ->> 'composition_id')::uuid)
            is distinct from v_payload ->> 'classification' then
        raise exception 'composition revision differs from exact action parameters'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'composition_input' then
      select s.object_id, r.created_by_action into v_target, v_origin_action
        from content.composition_revision r
        join content.document_subject s on s.id = r.composition_id
       where r.id = (v_row ->> 'composition_revision_id')::uuid;
      select item into v_expected_input
        from jsonb_array_elements(v_payload -> 'inputs') item
       where item ->> 'ordinal' = v_row ->> 'ordinal';
      if v_expected_input is null
         or v_row ->> 'input_role' is distinct from v_expected_input ->> 'role'
         or v_row ->> 'fragment_revision_id' is distinct from
            v_expected_input ->> 'fragment_revision_id'
         or v_row ->> 'child_composition_revision_id' is distinct from
            v_expected_input ->> 'composition_revision_id'
         or v_row ->> 'resource_version_id' is distinct from
            v_expected_input ->> 'resource_version_id'
         or v_row ->> 'binding_id' is distinct from v_expected_input ->> 'binding_id'
         or v_row ->> 'compiled_view_id' is distinct from
            v_expected_input ->> 'compiled_view_id'
         or v_row ->> 'content_digest' is distinct from
            v_expected_input ->> 'content_digest' then
        raise exception 'composition input differs from exact declared ordinal'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'compilation_basis' then
      select s.object_id into v_target
        from content.composition_revision r
        join content.document_subject s on s.id = r.composition_id
       where r.id = (v_row ->> 'root_composition_revision_id')::uuid;
      if v_action.parameters ->> 'basis_id' is distinct from v_row ->> 'id'
         or v_action.parameters -> 'basis' is distinct from v_row -> 'basis'
         or v_action.parameters -> 'basis' ->> 'basisDigest' is distinct from
            v_row ->> 'basis_digest'
         or v_action.parameters -> 'basis' ->> 'rootCompositionRevisionId'
            is distinct from v_row ->> 'root_composition_revision_id'
         or v_action.parameters -> 'basis' ->> 'ontologyDigest'
            is distinct from v_row ->> 'ontology_digest'
         or v_action.parameters -> 'basis' ->> 'policyDigest'
            is distinct from v_row ->> 'policy_digest'
         or v_action.parameters -> 'basis' -> 'targetProfiles'
            is distinct from v_row -> 'target_profiles' then
        raise exception 'compilation Basis differs from exact request action parameters'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'compilation_basis_fragment' then
      select s.object_id, b.created_by_action into v_target, v_origin_action
        from content.compilation_basis b
        join content.composition_revision r on r.id = b.root_composition_revision_id
        join content.document_subject s on s.id = r.composition_id
       where b.id = (v_row ->> 'basis_id')::uuid;
      if not exists (
        select 1 from jsonb_array_elements(v_action.parameters -> 'basis' -> 'fragmentRevisions') item
         where item ->> 'id' = v_row ->> 'fragment_revision_id'
      ) then
        raise exception 'Basis fragment is not declared by the request action'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'compilation_basis_composition' then
      select s.object_id, b.created_by_action into v_target, v_origin_action
        from content.compilation_basis b
        join content.composition_revision r on r.id = b.root_composition_revision_id
        join content.document_subject s on s.id = r.composition_id
       where b.id = (v_row ->> 'basis_id')::uuid;
      if not exists (
        select 1
          from jsonb_array_elements(v_action.parameters -> 'basis' -> 'compositionRevisions') item
         where item ->> 'id' = v_row ->> 'composition_revision_id'
      ) then
        raise exception 'Basis composition is not declared by the request action'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'compilation_basis_binding' then
      select s.object_id, b.created_by_action into v_target, v_origin_action
        from content.compilation_basis b
        join content.composition_revision r on r.id = b.root_composition_revision_id
        join content.document_subject s on s.id = r.composition_id
       where b.id = (v_row ->> 'basis_id')::uuid;
      if not exists (
        select 1 from jsonb_array_elements(v_action.parameters -> 'basis' -> 'bindings') item
         where item ->> 'id' = v_row ->> 'binding_id'
      ) then
        raise exception 'Basis binding is not declared by the request action'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'proposal_overlay' then
      select s.object_id into v_target
        from content.document_subject s where s.id = (v_row ->> 'subject_id')::uuid;
      if v_action.parameters ->> 'proposal_id' is distinct from v_row ->> 'id'
         or v_row ->> 'basis_id' is distinct from v_action.parameters ->> 'basis_id'
         or v_row ->> 'proposal_kind' is distinct from
            v_action.parameters ->> 'proposal_kind'
         or v_row ->> 'proposed_by_kind' is distinct from
            v_action.parameters ->> 'proposed_by_kind'
         or v_row ->> 'base_fragment_revision_id' is distinct from
            v_action.parameters ->> 'base_fragment_revision_id'
         or v_row ->> 'base_composition_revision_id' is distinct from
            v_action.parameters ->> 'base_composition_revision_id'
         or v_row -> 'operations' is distinct from v_action.parameters -> 'operations'
         or v_row ->> 'actor_id' is distinct from
            (case when v_action.parameters ->> 'proposed_by_kind' = 'human'
                  then v_actor::text else null end)
         or v_row ->> 'model_provider' is distinct from
            v_action.parameters ->> 'model_provider'
         or v_row ->> 'model_profile' is distinct from
            v_action.parameters ->> 'model_profile'
         or v_row ->> 'model_request_id' is distinct from
            v_action.parameters ->> 'model_request_id'
         or v_row -> 'model_provenance' is distinct from
            coalesce(v_action.parameters -> 'model_provenance', 'null'::jsonb)
         or (v_row ->> 'created_at')::timestamptz is distinct from v_action.effective_at
         or (select b.basis_digest from content.compilation_basis b
              where b.id = (v_row ->> 'basis_id')::uuid)
            is distinct from (select b.basis_digest from content.compilation_basis b
              where b.id = (v_action.parameters ->> 'basis_id')::uuid) then
        raise exception 'proposal row differs from exact proposal action parameters'
          using errcode = 'integrity_constraint_violation';
      end if;
    when 'document_publication' then
      select s.object_id into v_target
        from content.document_subject s where s.id = (v_row ->> 'subject_id')::uuid;
      if v_row ->> 'action_id' is distinct from v_action_id::text
         or v_row ->> 'published_by' is distinct from v_actor::text
         or v_row ->> 'organization_id' is distinct from core.current_organization()::text
         or v_row ->> 'compiled_view_id' is distinct from
            v_action.parameters ->> 'compiled_view_id'
         or v_row ->> 'compiled_view_digest' is distinct from
            v_action.parameters ->> 'compiled_view_digest'
         or v_row ->> 'acceptance_action_id' is distinct from
            v_action.parameters ->> 'acceptance_action_id'
         or v_row ->> 'controlled_document_id' is distinct from
            v_action.parameters ->> 'controlled_document_id'
         or v_row ->> 'controlled_content_version_id' is distinct from
            v_action.parameters ->> 'controlled_content_version_id'
         or v_row ->> 'publication_target_id' is distinct from
            v_action.parameters ->> 'publication_target_id' then
        raise exception 'publication receipt differs from exact action parameters'
          using errcode = 'integrity_constraint_violation';
      end if;
    else
      raise exception 'no typed document INSERT mapping for %', TG_TABLE_NAME
        using errcode = 'feature_not_supported';
  end case;

  if v_target is null
     or cardinality(v_action.target_ids) <> 1
     or v_action.target_ids[1] is distinct from v_target
     or (v_origin_action is not null and v_origin_action is distinct from v_action_id) then
    raise exception '% insert does not belong to the exact action target', TG_TABLE_NAME
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

revoke all on function content.enforce_document_typed_insert() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create trigger document_subject_guard_1_action before insert on content.document_subject
  for each row execute function content.enforce_document_typed_insert(
    'add_authored_fragment', 'add_document_composition'
  );
create trigger document_source_holder_guard_1_action before insert on content.document_source_holder
  for each row execute function content.enforce_document_typed_insert(
    'add_authored_fragment', 'add_document_composition', 'revise_authored_fragment',
    'revise_document_composition', 'change_document_source_holder', 'apply_document_proposal'
  );
create trigger authored_fragment_guard_1_action before insert on content.authored_fragment
  for each row execute function content.enforce_document_typed_insert('add_authored_fragment');
create trigger document_composition_guard_1_action before insert on content.document_composition
  for each row execute function content.enforce_document_typed_insert('add_document_composition');
create trigger authored_fragment_revision_guard_1_action
  before insert on content.authored_fragment_revision
  for each row execute function content.enforce_document_typed_insert(
    'add_authored_fragment', 'revise_authored_fragment', 'retire_authored_fragment',
    'apply_document_proposal'
  );
create trigger composition_revision_guard_1_action before insert on content.composition_revision
  for each row execute function content.enforce_document_typed_insert(
    'add_document_composition', 'revise_document_composition', 'apply_document_proposal'
  );
create trigger composition_input_guard_1_action before insert on content.composition_input
  for each row execute function content.enforce_document_typed_insert(
    'add_document_composition', 'revise_document_composition', 'apply_document_proposal'
  );
create trigger compilation_basis_guard_1_action before insert on content.compilation_basis
  for each row execute function content.enforce_document_typed_insert(
    'request_document_compilation'
  );
create trigger compilation_basis_fragment_guard_1_action
  before insert on content.compilation_basis_fragment
  for each row execute function content.enforce_document_typed_insert(
    'request_document_compilation'
  );
create trigger compilation_basis_composition_guard_1_action
  before insert on content.compilation_basis_composition
  for each row execute function content.enforce_document_typed_insert(
    'request_document_compilation'
  );
create trigger compilation_basis_binding_guard_1_action
  before insert on content.compilation_basis_binding
  for each row execute function content.enforce_document_typed_insert(
    'request_document_compilation'
  );
create trigger proposal_overlay_guard_1_action before insert on content.proposal_overlay
  for each row execute function content.enforce_document_typed_insert('record_document_proposal');
create trigger document_publication_guard_0_action before insert on content.document_publication
  for each row execute function content.enforce_document_typed_insert('publish_document_view');

-- A Holder pointer update is itself an authoritative write. Requiring the newly selected
-- Holder to have been inserted by this still-open action prevents replay of a closed action,
-- selection of a stale Holder, and an UPDATE that bypasses the typed effect entirely.
create function content.enforce_document_holder_update_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content, core, org
as $$
declare
  v_action core.action%rowtype;
  v_holder content.document_source_holder%rowtype;
  v_payload jsonb;
  v_proposal content.proposal_overlay%rowtype;
begin
  if new.current_holder_id = old.current_holder_id then
    return new;
  end if;
  select a.* into v_action from core.action a where a.id = core.current_action_id();
  if not found
     or v_action.action_type not in (
       'change_document_source_holder', 'revise_authored_fragment',
       'revise_document_composition', 'apply_document_proposal'
     )
     or v_action.result_status <> 'applied'
     or v_action.actor_id is distinct from core.current_actor()
     or v_action.acting_role_id::text is distinct from
        nullif(current_setting('kf.acting_role', true), '')
     or v_action.request_id is distinct from nullif(current_setting('kf.request_id', true), '')
     or not org.holds_role(v_action.actor_id, v_action.acting_role_id)
     or cardinality(v_action.target_ids) <> 1
     or v_action.target_ids[1] is distinct from new.object_id
     or exists (select 1 from core.audit_event e where e.action_id = v_action.id) then
    raise exception 'Holder update requires its exact open typed action context'
      using errcode = 'insufficient_privilege';
  end if;

  v_payload := v_action.parameters;
  if v_action.action_type = 'apply_document_proposal' then
    begin
      select p.* into strict v_proposal
        from content.proposal_overlay p
       where p.id = (v_action.parameters ->> 'proposal_id')::uuid
         and p.proposal_digest = v_action.parameters ->> 'proposal_digest'
         and p.subject_id = new.id
         and jsonb_array_length(p.operations) = 1;
    exception
      when no_data_found or invalid_text_representation then
        raise exception 'Holder update proposal does not match its action'
          using errcode = 'integrity_constraint_violation';
    end;
    v_payload := v_proposal.operations -> 0;
  end if;

  select h.* into v_holder
    from content.document_source_holder h
   where h.id = new.current_holder_id;
  if not found
     or v_holder.subject_id is distinct from new.id
     or v_holder.previous_holder_id is distinct from old.current_holder_id
     or v_holder.recorded_by_action is distinct from v_action.id
     or v_holder.recorded_by is distinct from v_action.actor_id
     or v_holder.id::text is distinct from v_payload ->> 'holder_id'
     or v_payload ->> 'previous_holder_id' is distinct from old.current_holder_id::text then
    raise exception 'new current Holder is not the exact Holder recorded by this action'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

revoke all on function content.enforce_document_holder_update_action() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create trigger document_subject_guard_0_holder_update
  before update of current_holder_id on content.document_subject
  for each row execute function content.enforce_document_holder_update_action();

-- Per-row input guards prevent undeclared ordinals. This deferred closure check prevents the
-- inverse attack: committing only a proper subset of the action's declared input set.
create function content.enforce_document_composition_action_complete() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_action core.action%rowtype;
  v_payload jsonb;
  v_proposal content.proposal_overlay%rowtype;
  v_expected_count integer;
  v_actual_count integer;
begin
  select a.* into v_action from core.action a where a.id = new.created_by_action;
  if not found
     or v_action.action_type not in (
       'add_document_composition', 'revise_document_composition', 'apply_document_proposal'
     ) then
    raise exception 'composition revision has no typed creating action'
      using errcode = 'integrity_constraint_violation';
  end if;
  v_payload := v_action.parameters;
  if v_action.action_type = 'apply_document_proposal' then
    select p.* into strict v_proposal
      from content.proposal_overlay p
     where p.id = (v_action.parameters ->> 'proposal_id')::uuid
       and p.proposal_digest = v_action.parameters ->> 'proposal_digest'
       and jsonb_array_length(p.operations) = 1;
    v_payload := v_proposal.operations -> 0;
  end if;
  v_expected_count := jsonb_array_length(v_payload -> 'inputs');
  select count(*)::integer into v_actual_count
    from content.composition_input i where i.composition_revision_id = new.id;
  if v_actual_count is distinct from v_expected_count then
    raise exception 'composition revision input set is not the exact action declaration'
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end
$$;

revoke all on function content.enforce_document_composition_action_complete() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create constraint trigger composition_revision_action_complete
  after insert on content.composition_revision
  deferrable initially deferred
  for each row execute function content.enforce_document_composition_action_complete();

-- Basis membership rows are staged before finalization. Bind their complete sets to the exact
-- canonical Basis in the request action at the finalization transition.
create function content.enforce_compilation_basis_action_members() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_action core.action%rowtype;
  v_expected uuid[];
  v_actual uuid[];
begin
  if new.finalized_at is null or old.finalized_at is not null then
    return new;
  end if;
  select a.* into v_action from core.action a where a.id = new.created_by_action;
  if not found
     or v_action.id is distinct from core.current_action_id()
     or v_action.action_type <> 'request_document_compilation'
     or v_action.result_status <> 'applied'
     or v_action.actor_id is distinct from core.current_actor()
     or v_action.acting_role_id::text is distinct from
        nullif(current_setting('kf.acting_role', true), '')
     or v_action.request_id is distinct from nullif(current_setting('kf.request_id', true), '')
     or cardinality(v_action.target_ids) <> 1
     or exists (select 1 from core.audit_event e where e.action_id = v_action.id) then
    raise exception 'Basis finalization requires its exact open request action'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), array[]::uuid[])
    into v_expected
    from jsonb_array_elements(v_action.parameters -> 'basis' -> 'fragmentRevisions') item;
  select coalesce(array_agg(fragment_revision_id order by fragment_revision_id), array[]::uuid[])
    into v_actual from content.compilation_basis_fragment where basis_id = new.id;
  if v_actual is distinct from v_expected then
    raise exception 'Basis fragment members differ from exact action parameters'
      using errcode = 'integrity_constraint_violation';
  end if;

  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), array[]::uuid[])
    into v_expected
    from jsonb_array_elements(v_action.parameters -> 'basis' -> 'compositionRevisions') item;
  select coalesce(array_agg(composition_revision_id order by composition_revision_id),
                  array[]::uuid[])
    into v_actual from content.compilation_basis_composition where basis_id = new.id;
  if v_actual is distinct from v_expected then
    raise exception 'Basis composition members differ from exact action parameters'
      using errcode = 'integrity_constraint_violation';
  end if;

  select coalesce(array_agg((item ->> 'id')::uuid order by item ->> 'id'), array[]::uuid[])
    into v_expected
    from jsonb_array_elements(v_action.parameters -> 'basis' -> 'bindings') item;
  select coalesce(array_agg(binding_id order by binding_id), array[]::uuid[])
    into v_actual from content.compilation_basis_binding where basis_id = new.id;
  if v_actual is distinct from v_expected then
    raise exception 'Basis binding members differ from exact action parameters'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

revoke all on function content.enforce_compilation_basis_action_members() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create trigger compilation_basis_guard_2_action_members
  before update of finalized_at on content.compilation_basis
  for each row execute function content.enforce_compilation_basis_action_members();

alter table content.compilation_run
  add constraint compilation_run_one_per_request unique (requested_by_action);

create or replace function content.enforce_compilation_run_qualification() returns trigger
language plpgsql
as $$
declare
  v_registration content.document_compiler_registration%rowtype;
  v_effective_classification text;
  v_finalized_at timestamptz;
  v_draft_only boolean;
begin
  select b.effective_classification, b.finalized_at
    into v_effective_classification, v_finalized_at
    from content.compilation_basis b
    join content.document_compiler_registration r on r.id = b.compiler_registration_id
   where b.id = new.basis_id
     and not exists (
       select 1 from content.document_compiler_revocation revoked
        where revoked.registration_id = r.id
     );
  if not found or v_finalized_at is null or v_effective_classification is null then
    raise exception 'compilation runs require an enabled registered compiler and finalized Basis'
      using errcode = 'integrity_constraint_violation';
  end if;
  select r.* into strict v_registration
    from content.compilation_basis b
    join content.document_compiler_registration r on r.id = b.compiler_registration_id
   where b.id = new.basis_id;
  v_draft_only := v_registration.qualification_state <> 'qualified'
                  or not v_registration.qualification_ratified
                  or v_registration.qualification_receipt_digest is null;
  if v_draft_only is distinct from new.draft_only then
    raise exception 'compilation run draft_only does not match registry qualification'
      using errcode = 'integrity_constraint_violation';
  end if;
  new.compiler_registration_id := v_registration.id;
  new.effective_classification := v_effective_classification;
  return new;
end
$$;

-- RLS remains fail-closed while the worker resolves a request whose organization is not yet
-- known to its session. Like the Basis classifier lease, this is an unguessable capability
-- scoped to one backend and transaction; setting the GUC alone grants no visibility.
create table content.compiler_runtime_lease (
  backend_pid     integer not null,
  transaction_id xid8 not null,
  token           uuid not null,
  primary key (backend_pid, transaction_id, token)
);

revoke all on content.compiler_runtime_lease from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create function content.compiler_runtime_active() returns boolean
language sql stable
security definer
set search_path = pg_catalog, content
as $$
  select current_user <> session_user and exists (
    select 1 from content.compiler_runtime_lease l
     where l.backend_pid = pg_backend_pid()
       and l.transaction_id = pg_current_xact_id()
       and l.token::text = nullif(current_setting('kf.compiler_runtime_lease', true), '')
  )
$$;

create policy object_compiler_runtime on core.object
  for select using (content.compiler_runtime_active());
create policy document_subject_compiler_runtime on content.document_subject
  for select using (content.compiler_runtime_active());
create policy document_source_holder_compiler_runtime on content.document_source_holder
  for select using (content.compiler_runtime_active());
create policy authored_fragment_compiler_runtime on content.authored_fragment
  for select using (content.compiler_runtime_active());
create policy document_composition_compiler_runtime on content.document_composition
  for select using (content.compiler_runtime_active());
create policy authored_fragment_revision_compiler_runtime on content.authored_fragment_revision
  for select using (content.compiler_runtime_active());
create policy composition_revision_compiler_runtime on content.composition_revision
  for select using (content.compiler_runtime_active());
create policy typed_binding_compiler_runtime on content.typed_binding
  for select using (content.compiler_runtime_active());
create policy composition_input_compiler_runtime on content.composition_input
  for select using (content.compiler_runtime_active());
create policy compilation_basis_compiler_runtime on content.compilation_basis
  for select using (content.compiler_runtime_active());
create policy compilation_basis_fragment_compiler_runtime on content.compilation_basis_fragment
  for select using (content.compiler_runtime_active());
create policy compilation_basis_composition_compiler_runtime
  on content.compilation_basis_composition
  for select using (content.compiler_runtime_active());
create policy compilation_basis_binding_compiler_runtime on content.compilation_basis_binding
  for select using (content.compiler_runtime_active());
create policy compilation_run_compiler_runtime on content.compilation_run
  for select using (content.compiler_runtime_active());
create policy compiled_view_compiler_runtime on content.compiled_view
  for select using (content.compiler_runtime_active());

-- One checked request envelope, including exact immutable object-store versions. Git and
-- external Holders remain unsupported here until they have independently auditable fetch
-- adapters; accepting a mutable path would make this runtime weaker than its Basis contract.
create function content.compiler_runtime_request(p_request_action uuid) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, content, core, registry
as $$
declare
  v_token uuid := uuidv7();
  v_action core.action%rowtype;
  v_basis content.compilation_basis%rowtype;
  v_registration content.document_compiler_registration%rowtype;
  v_organization uuid;
  v_target_object uuid;
  v_inputs jsonb;
  v_existing jsonb := null;
  v_existing_run content.compilation_run%rowtype;
  v_existing_views jsonb := '[]'::jsonb;
  v_expected_targets text[];
  v_actual_targets text[];
  v_result jsonb;
  v_identity jsonb;
  v_runtime_basis jsonb;
  v_draft_only boolean;
begin
  insert into content.compiler_runtime_lease (backend_pid, transaction_id, token)
  values (pg_backend_pid(), pg_current_xact_id(), v_token);
  perform set_config('kf.compiler_runtime_lease', v_token::text, true);

  select * into v_action from core.action where id = p_request_action;
  if not found
     or v_action.action_type <> 'request_document_compilation'
     or v_action.result_status <> 'applied'
     or cardinality(v_action.target_ids) <> 1 then
    raise exception 'compiler runtime requires one applied document compilation request'
      using errcode = 'integrity_constraint_violation';
  end if;

  begin
    select * into v_basis
      from content.compilation_basis
     where id = (v_action.parameters ->> 'basis_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'compilation request has an invalid Basis identifier'
      using errcode = 'integrity_constraint_violation';
  end;
  if not found
     or v_basis.created_by_action <> p_request_action
     or v_basis.finalized_at is null
     or v_basis.effective_classification is null
     or v_action.parameters -> 'basis' ->> 'basisDigest' is distinct from v_basis.basis_digest then
    raise exception 'compilation request does not identify one exact finalized Basis'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_basis.compiler_kind <> 'liminal' then
    raise exception 'operational compiler runtime accepts only pinned Liminal Basis identities'
      using errcode = 'feature_not_supported';
  end if;

  select r.* into v_registration
    from content.document_compiler_registration r
   where r.id = v_basis.compiler_registration_id
     and not exists (
       select 1 from content.document_compiler_revocation revoked
        where revoked.registration_id = r.id
     );
  if not found
     or v_registration.compiler_name is distinct from v_basis.compiler_name
     or v_registration.compiler_version is distinct from v_basis.compiler_version
     or v_registration.protocol is distinct from v_basis.protocol
     or v_registration.liminal_commit_sha is distinct from v_basis.liminal_commit_sha
     or v_registration.cargo_lock_digest is distinct from v_basis.cargo_lock_digest
     or v_registration.executable_digest is distinct from v_basis.executable_digest then
    raise exception 'compilation request compiler registration is disabled or mismatched'
      using errcode = 'insufficient_privilege';
  end if;
  v_identity := jsonb_build_object(
    'kind', 'liminal',
    'name', v_registration.compiler_name,
    'version', v_registration.compiler_version,
    'protocol', v_registration.protocol,
    'commitSha', v_registration.liminal_commit_sha,
    'cargoLockDigest', v_registration.cargo_lock_digest,
    'executableDigest', v_registration.executable_digest,
    'qualification', jsonb_build_object(
      'state', v_registration.qualification_state,
      'receiptDigest', v_registration.qualification_receipt_digest,
      'ratified', v_registration.qualification_ratified
    )
  );
  if v_basis.basis -> 'compiler' is distinct from v_identity
     or v_basis.qualification_state is distinct from v_registration.qualification_state
     or v_basis.qualification_receipt_digest is distinct from
        v_registration.qualification_receipt_digest
     or v_basis.qualification_ratified is distinct from
        v_registration.qualification_ratified then
    raise exception 'compilation request self-asserted compiler qualification is not authoritative'
      using errcode = 'integrity_constraint_violation';
  end if;
  v_runtime_basis := jsonb_set(v_basis.basis, '{compiler}', v_identity, false);
  v_draft_only := v_registration.qualification_state <> 'qualified'
                  or not v_registration.qualification_ratified
                  or v_registration.qualification_receipt_digest is null;

  select s.object_id, o.organization_id
    into v_target_object, v_organization
    from content.composition_revision r
    join content.document_subject s on s.id = r.composition_id
    join core.object o on o.id = s.object_id
   where r.id = v_basis.root_composition_revision_id;
  if not found or v_action.target_ids[1] <> v_target_object then
    raise exception 'compilation request target does not own the Basis root composition'
      using errcode = 'integrity_constraint_violation';
  end if;

  if exists (
    select 1
      from content.compilation_basis_fragment bf
      join content.authored_fragment_revision r on r.id = bf.fragment_revision_id
      join content.document_source_holder h on h.id = r.holder_id
     where bf.basis_id = v_basis.id and h.holder_kind <> 'fabric_native'
  ) then
    raise exception 'Git and external document Holders require a qualified runtime source adapter'
      using errcode = 'feature_not_supported';
  end if;

  with input_refs as (
    select 'fragment'::text as kind, r.id, av.storage_uri, av.storage_version,
           av.sha256 as content_digest, av.size_bytes
      from content.compilation_basis_fragment bf
      join content.authored_fragment_revision r on r.id = bf.fragment_revision_id
      join content.document_source_holder h on h.id = r.holder_id
      join content.artifact_version av on av.id = h.fabric_artifact_version_id
     where bf.basis_id = v_basis.id and h.holder_kind = 'fabric_native'
    union
    select 'resource'::text, av.id, av.storage_uri, av.storage_version,
           av.sha256, av.size_bytes
      from content.compilation_basis_composition bc
      join content.composition_input i on i.composition_revision_id = bc.composition_revision_id
      join content.artifact_version av on av.id = i.resource_version_id
     where bc.basis_id = v_basis.id and i.input_role = 'resource'
    union
    select 'compiled_view'::text, cv.id, av.storage_uri, av.storage_version,
           cv.content_digest, av.size_bytes
      from content.compilation_basis_composition bc
      join content.composition_input i on i.composition_revision_id = bc.composition_revision_id
      join content.compiled_view cv on cv.id = i.compiled_view_id
      join content.artifact_version av on av.id = cv.artifact_version_id
     where bc.basis_id = v_basis.id and i.input_role = 'generated_view'
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'kind', kind,
               'id', id,
               'storageUri', storage_uri,
               'storageVersion', storage_version,
               'contentDigest', content_digest,
               'sizeBytes', size_bytes
             ) order by kind, id
           ),
           '[]'::jsonb
         )
    into v_inputs
    from input_refs;

  if exists (
    select 1 from jsonb_array_elements(v_inputs) i
     where i ->> 'storageUri' is null
        or length(btrim(i ->> 'storageUri')) = 0
        or i ->> 'storageVersion' is null
        or length(btrim(i ->> 'storageVersion')) = 0
  ) then
    raise exception 'compiler inputs require exact object-store URI and version identities'
      using errcode = 'integrity_constraint_violation';
  end if;

  select * into v_existing_run
    from content.compilation_run where requested_by_action = p_request_action;
  if found then
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'target', cv.target,
                 'mediaType', cv.media_type,
                 'contentDigest', cv.content_digest,
                 'sizeBytes', av.size_bytes,
                 'storageUri', av.storage_uri,
                 'storageVersion', av.storage_version
               ) order by cv.target
             ),
             '[]'::jsonb
           ),
           coalesce(array_agg(cv.target order by cv.target), array[]::text[])
      into v_existing_views, v_actual_targets
      from content.compiled_view cv
      join content.artifact_version av on av.id = cv.artifact_version_id
     where cv.compilation_run_id = v_existing_run.id;
    select coalesce(array_agg(profile ->> 'target' order by profile ->> 'target'), array[]::text[])
      into v_expected_targets
      from jsonb_array_elements(v_basis.target_profiles) profile;
    if (v_existing_run.run_status = 'succeeded'
        and v_actual_targets is distinct from v_expected_targets)
       or (v_existing_run.run_status = 'failed' and jsonb_array_length(v_existing_views) <> 0) then
      raise exception 'existing compilation receipt has an incomplete terminal view set'
        using errcode = 'integrity_constraint_violation';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_existing_views) view
       where view ->> 'storageUri' is null
          or view ->> 'storageVersion' is null
    ) then
      raise exception 'existing compiled view lacks exact versioned storage identity'
        using errcode = 'integrity_constraint_violation';
    end if;
    v_existing := jsonb_build_object(
      'runId', v_existing_run.id,
      'runDigest', v_existing_run.run_digest,
      'status', v_existing_run.run_status,
      'views', v_existing_views
    );
  end if;

  v_result := jsonb_build_object(
    'actionId', v_action.id,
    'actorId', v_action.actor_id,
    'actingRoleId', v_action.acting_role_id,
    'requestId', v_action.request_id,
    'organizationId', v_organization,
    'maxClassification', v_basis.effective_classification,
    'basisId', v_basis.id,
    'compilerRegistrationId', v_registration.id,
    'draftOnly', v_draft_only,
    'basis', v_runtime_basis,
    'inputs', v_inputs,
    'existing', v_existing
  );

  delete from content.compiler_runtime_lease
   where backend_pid = pg_backend_pid()
     and transaction_id = pg_current_xact_id()
     and token = v_token;
  perform set_config('kf.compiler_runtime_lease', '', true);
  return v_result;
exception when others then
  delete from content.compiler_runtime_lease
   where backend_pid = pg_backend_pid()
     and transaction_id = pg_current_xact_id()
     and token = v_token;
  perform set_config('kf.compiler_runtime_lease', '', true);
  raise;
end
$$;

create function content.compiler_runtime_exact_keys(p_value jsonb, p_keys text[]) returns boolean
language sql immutable
set search_path = pg_catalog
as $$
  select case
    when jsonb_typeof(p_value) = 'object' then
      coalesce(
        (select array_agg(key order by key) from jsonb_object_keys(p_value) key),
        array[]::text[]
      ) =
      coalesce(
        (select array_agg(key order by key) from unnest(p_keys) key),
        array[]::text[]
      )
    else false
  end
$$;

revoke all on function content.compiler_runtime_exact_keys(jsonb, text[]) from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

-- Persist one complete terminal result. A short transaction-scoped advisory lock serializes
-- only competing recorders for this request; compiler and object-store work never hold it.
create function content.record_compilation_result(
  p_request_action uuid,
  p_result jsonb,
  p_views jsonb
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, content, core, registry
as $$
declare
  v_action core.action%rowtype;
  v_basis content.compilation_basis%rowtype;
  v_registration content.document_compiler_registration%rowtype;
  v_root_object core.object%rowtype;
  v_existing content.compilation_run%rowtype;
  v_existing_logical_views jsonb;
  v_proposed_logical_views jsonb;
  v_expected_targets text[];
  v_proposed_targets text[];
  v_proposed_capability_targets text[];
  v_schema_version text;
  v_view jsonb;
  v_evidence jsonb;
  v_capability jsonb;
  v_status text;
  v_draft_only boolean;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('kf-document-compilation-request:' || p_request_action::text, 0)
  );

  if core.current_action_id() is distinct from p_request_action then
    raise exception 'compiler recorder transaction action does not match request authority'
      using errcode = 'insufficient_privilege';
  end if;
  select * into v_action from core.action where id = p_request_action;
  if not found
     or v_action.action_type <> 'request_document_compilation'
     or v_action.result_status <> 'applied'
     or cardinality(v_action.target_ids) <> 1
     or v_action.actor_id is distinct from core.current_actor()
     or v_action.acting_role_id::text is distinct from
        nullif(current_setting('kf.acting_role', true), '')
     or v_action.request_id is distinct from
        nullif(current_setting('kf.request_id', true), '') then
    raise exception 'compiler recorder context does not match recorded request actor and role'
      using errcode = 'insufficient_privilege';
  end if;

  if p_result is null
     or p_views is null
     or not content.compiler_runtime_exact_keys(
    p_result,
    array[
      'id', 'basisId', 'basisDigest', 'compilerDigest', 'dependencyDigest', 'status',
      'draftOnly', 'effectiveClassification', 'semanticDigest', 'failureCode',
      'failureMessage', 'hirProvenance', 'cirProvenance', 'unresolvedReferences',
      'omittedSubgraphs', 'projectionCapabilities', 'diagnostics', 'conversionLoss',
      'runDigest'
    ]
  ) or jsonb_typeof(p_views) <> 'array' then
    raise exception 'compiler result envelope has invalid fields'
      using errcode = 'invalid_parameter_value';
  end if;

  if jsonb_typeof(p_result -> 'id') <> 'string'
     or coalesce(p_result ->> 'id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(p_result -> 'basisId') <> 'string'
     or coalesce(p_result ->> 'basisId', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(p_result -> 'basisDigest') <> 'string'
     or coalesce(p_result ->> 'basisDigest', '') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_result -> 'compilerDigest') <> 'string'
     or coalesce(p_result ->> 'compilerDigest', '') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_result -> 'dependencyDigest') <> 'string'
     or coalesce(p_result ->> 'dependencyDigest', '') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_result -> 'status') <> 'string'
     or jsonb_typeof(p_result -> 'effectiveClassification') <> 'string'
     or length(btrim(coalesce(p_result ->> 'effectiveClassification', ''))) = 0
     or jsonb_typeof(p_result -> 'runDigest') <> 'string'
     or coalesce(p_result ->> 'runDigest', '') !~ '^[0-9a-f]{64}$' then
    raise exception 'compiler result scalar fields are malformed'
      using errcode = 'invalid_parameter_value';
  end if;

  begin
    select * into v_basis
      from content.compilation_basis where id = (p_result ->> 'basisId')::uuid;
  exception when invalid_text_representation then
    raise exception 'compiler result has an invalid Basis identifier'
      using errcode = 'invalid_parameter_value';
  end;
  if not found
     or v_basis.created_by_action <> p_request_action
     or v_basis.finalized_at is null
     or v_basis.effective_classification is null
     or v_action.parameters ->> 'basis_id' is distinct from v_basis.id::text
     or v_action.parameters -> 'basis' ->> 'basisDigest' is distinct from v_basis.basis_digest
     or p_result ->> 'basisDigest' is distinct from v_basis.basis_digest
     or p_result ->> 'effectiveClassification' is distinct from v_basis.effective_classification
     or v_basis.compiler_kind <> 'liminal' then
    raise exception 'compiler result does not match exact finalized request Basis'
      using errcode = 'integrity_constraint_violation';
  end if;

  select r.* into v_registration
    from content.document_compiler_registration r
   where r.id = v_basis.compiler_registration_id
     and not exists (
       select 1 from content.document_compiler_revocation revoked
        where revoked.registration_id = r.id
     );
  if not found then
    raise exception 'compiler registration was revoked before result recording'
      using errcode = 'insufficient_privilege';
  end if;
  v_draft_only := v_registration.qualification_state <> 'qualified'
                  or not v_registration.qualification_ratified
                  or v_registration.qualification_receipt_digest is null;

  select o.* into v_root_object
    from content.composition_revision r
    join content.document_subject s on s.id = r.composition_id
    join core.object o on o.id = s.object_id
   where r.id = v_basis.root_composition_revision_id;
  if not found
     or v_action.target_ids[1] <> v_root_object.id
     or core.current_organization() is distinct from v_root_object.organization_id
     or (select rank from registry.classification where id = v_basis.effective_classification)
        > core.current_classification_rank() then
    raise exception 'compiler recorder access context cannot cover requested Basis'
      using errcode = 'insufficient_privilege';
  end if;

  v_status := p_result ->> 'status';
  if v_status is null
     or v_status not in ('succeeded', 'failed')
     or jsonb_typeof(p_result -> 'draftOnly') <> 'boolean'
     or (p_result ->> 'draftOnly')::boolean is distinct from v_draft_only
     or jsonb_typeof(p_result -> 'hirProvenance') <> 'array'
     or jsonb_typeof(p_result -> 'cirProvenance') <> 'array'
     or jsonb_typeof(p_result -> 'unresolvedReferences') <> 'array'
     or jsonb_typeof(p_result -> 'omittedSubgraphs') <> 'array'
     or jsonb_typeof(p_result -> 'projectionCapabilities') <> 'array'
     or jsonb_typeof(p_result -> 'diagnostics') <> 'array'
     or jsonb_typeof(p_result -> 'conversionLoss') <> 'array'
     or not (
       (v_status = 'succeeded'
         and jsonb_typeof(p_result -> 'semanticDigest') = 'string'
         and coalesce(p_result ->> 'semanticDigest', '') ~ '^[0-9a-f]{64}$'
         and jsonb_typeof(p_result -> 'failureCode') = 'null'
         and jsonb_typeof(p_result -> 'failureMessage') = 'null')
       or
       (v_status = 'failed'
         and jsonb_typeof(p_result -> 'semanticDigest') = 'null'
         and jsonb_typeof(p_result -> 'failureCode') = 'string'
         and length(btrim(coalesce(p_result ->> 'failureCode', ''))) > 0
         and jsonb_typeof(p_result -> 'failureMessage') = 'string'
         and length(btrim(coalesce(p_result ->> 'failureMessage', ''))) > 0)
     ) then
    raise exception 'compiler result outcome fields are malformed'
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(array_agg(profile ->> 'target' order by profile ->> 'target'), array[]::text[])
    into v_expected_targets
    from jsonb_array_elements(v_basis.target_profiles) profile;

  -- These JSON receipts are authoritative database evidence, not an opaque copy of a typed
  -- caller value. Revalidate every key and scalar here because kf_worker can invoke this
  -- SECURITY DEFINER function directly without passing through the TypeScript validators.
  for v_evidence in
    select value from jsonb_array_elements(
      jsonb_build_array(
        jsonb_build_object('label', 'HIR provenance', 'items', p_result -> 'hirProvenance'),
        jsonb_build_object('label', 'CIR provenance', 'items', p_result -> 'cirProvenance')
      )
    ) value
  loop
    for v_view in select value from jsonb_array_elements(v_evidence -> 'items') value loop
      if not content.compiler_runtime_exact_keys(
        v_view,
        array['nodeId', 'sourceKind', 'sourceId', 'sourcePath', 'sourceDigest']
      )
         or jsonb_typeof(v_view -> 'nodeId') <> 'string'
         or length(btrim(coalesce(v_view ->> 'nodeId', ''))) = 0
         or jsonb_typeof(v_view -> 'sourceKind') <> 'string'
         or v_view ->> 'sourceKind' not in (
           'fragment', 'composition', 'resource', 'binding', 'compiled_view'
         )
         or jsonb_typeof(v_view -> 'sourceId') <> 'string'
         or length(btrim(coalesce(v_view ->> 'sourceId', ''))) = 0
         or not (
           jsonb_typeof(v_view -> 'sourcePath') = 'null'
           or (
             jsonb_typeof(v_view -> 'sourcePath') = 'string'
             and length(btrim(coalesce(v_view ->> 'sourcePath', ''))) > 0
           )
         )
         or jsonb_typeof(v_view -> 'sourceDigest') <> 'string'
         or coalesce(v_view ->> 'sourceDigest', '') !~ '^[0-9a-f]{64}$' then
        raise exception '% element is malformed', v_evidence ->> 'label'
          using errcode = 'invalid_parameter_value';
      end if;
    end loop;
    if exists (
      select 1
        from jsonb_array_elements(v_evidence -> 'items') value
       group by value ->> 'nodeId', value ->> 'sourceKind', value ->> 'sourceId',
                value ->> 'sourcePath'
      having count(*) > 1
    ) then
      raise exception '% contains a duplicate source claim', v_evidence ->> 'label'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  for v_evidence in
    select value from jsonb_array_elements(p_result -> 'unresolvedReferences') value
  loop
    if not content.compiler_runtime_exact_keys(
      v_evidence,
      array['sourceNodeId', 'reference', 'reasonCode', 'message']
    )
       or not (
         jsonb_typeof(v_evidence -> 'sourceNodeId') = 'null'
         or (
           jsonb_typeof(v_evidence -> 'sourceNodeId') = 'string'
           and length(btrim(coalesce(v_evidence ->> 'sourceNodeId', ''))) > 0
         )
       )
       or jsonb_typeof(v_evidence -> 'reference') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'reference', ''))) = 0
       or jsonb_typeof(v_evidence -> 'reasonCode') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'reasonCode', ''))) = 0
       or jsonb_typeof(v_evidence -> 'message') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'message', ''))) = 0 then
      raise exception 'unresolved reference element is malformed'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  for v_evidence in
    select value from jsonb_array_elements(p_result -> 'omittedSubgraphs') value
  loop
    if not content.compiler_runtime_exact_keys(
      v_evidence,
      array['rootNodeId', 'reasonCode', 'message']
    )
       or jsonb_typeof(v_evidence -> 'rootNodeId') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'rootNodeId', ''))) = 0
       or jsonb_typeof(v_evidence -> 'reasonCode') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'reasonCode', ''))) = 0
       or jsonb_typeof(v_evidence -> 'message') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'message', ''))) = 0 then
      raise exception 'omitted subgraph element is malformed'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  for v_evidence in
    select value from jsonb_array_elements(p_result -> 'projectionCapabilities') value
  loop
    if not content.compiler_runtime_exact_keys(v_evidence, array['target', 'capabilities'])
       or jsonb_typeof(v_evidence -> 'target') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'target', ''))) = 0
       or not exists (
         select 1 from jsonb_array_elements(v_basis.target_profiles) profile
          where profile ->> 'target' = v_evidence ->> 'target'
       )
       or jsonb_typeof(v_evidence -> 'capabilities') <> 'array' then
      raise exception 'projection capability element is malformed'
        using errcode = 'invalid_parameter_value';
    end if;
    for v_capability in
      select value from jsonb_array_elements(v_evidence -> 'capabilities') value
    loop
      if jsonb_typeof(v_capability) <> 'string'
         or length(btrim(coalesce(v_capability #>> '{}', ''))) = 0 then
        raise exception 'projection capability name is malformed'
          using errcode = 'invalid_parameter_value';
      end if;
    end loop;
    if exists (
      select 1 from jsonb_array_elements(v_evidence -> 'capabilities') value
       group by value #>> '{}'
      having count(*) > 1
    ) then
      raise exception 'projection capability repeats a capability name'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(p_result -> 'projectionCapabilities') value
     group by value ->> 'target'
    having count(*) > 1
  ) then
    raise exception 'projection capabilities repeat a target'
      using errcode = 'invalid_parameter_value';
  end if;
  select coalesce(array_agg(value ->> 'target' order by value ->> 'target'), array[]::text[])
    into v_proposed_capability_targets
    from jsonb_array_elements(p_result -> 'projectionCapabilities') value;
  if v_status = 'succeeded'
     and v_proposed_capability_targets is distinct from v_expected_targets then
    raise exception 'projection capabilities do not contain the exact declared target set'
      using errcode = 'integrity_constraint_violation';
  end if;

  for v_evidence in select value from jsonb_array_elements(p_result -> 'diagnostics') value loop
    if not content.compiler_runtime_exact_keys(
      v_evidence,
      array['severity', 'code', 'message']
    )
       or jsonb_typeof(v_evidence -> 'severity') <> 'string'
       or v_evidence ->> 'severity' not in ('info', 'warning', 'error')
       or jsonb_typeof(v_evidence -> 'code') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'code', ''))) = 0
       or jsonb_typeof(v_evidence -> 'message') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'message', ''))) = 0 then
      raise exception 'compiler diagnostic element is malformed'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  for v_evidence in
    select value from jsonb_array_elements(p_result -> 'conversionLoss') value
  loop
    if not content.compiler_runtime_exact_keys(v_evidence, array['code', 'path', 'message'])
       or jsonb_typeof(v_evidence -> 'code') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'code', ''))) = 0
       or not (
         jsonb_typeof(v_evidence -> 'path') = 'null'
         or (
           jsonb_typeof(v_evidence -> 'path') = 'string'
           and length(btrim(coalesce(v_evidence ->> 'path', ''))) > 0
         )
       )
       or jsonb_typeof(v_evidence -> 'message') <> 'string'
       or length(btrim(coalesce(v_evidence ->> 'message', ''))) = 0 then
      raise exception 'conversion loss element is malformed'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  for v_view in select value from jsonb_array_elements(p_views) value loop
    if not content.compiler_runtime_exact_keys(
      v_view,
      array[
        'id', 'artifactId', 'artifactVersionId', 'target', 'mediaType', 'contentDigest',
        'sizeBytes', 'storageUri', 'storageVersion'
      ]
    )
       or length(btrim(coalesce(v_view ->> 'target', ''))) = 0
       or length(btrim(coalesce(v_view ->> 'mediaType', ''))) = 0
       or coalesce(v_view ->> 'contentDigest', '') !~ '^[0-9a-f]{64}$'
       or v_view ->> 'storageUri' is distinct from
          'compiled-views/sha256/' || (v_view ->> 'contentDigest')
       or length(btrim(coalesce(v_view ->> 'storageVersion', ''))) = 0
       or (v_view ->> 'sizeBytes')::bigint < 0 then
      raise exception 'compiled view materialization envelope is malformed'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  select coalesce(array_agg(view ->> 'target' order by view ->> 'target'), array[]::text[])
    into v_proposed_targets
    from jsonb_array_elements(p_views) view;
  if (v_status = 'succeeded' and v_proposed_targets is distinct from v_expected_targets)
     or (v_status = 'failed' and jsonb_array_length(p_views) <> 0) then
    raise exception 'terminal compiler result does not contain exact declared target set'
      using errcode = 'integrity_constraint_violation';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'target', view ->> 'target',
               'mediaType', view ->> 'mediaType',
               'contentDigest', view ->> 'contentDigest'
             ) order by view ->> 'target'
           ),
           '[]'::jsonb
         )
    into v_proposed_logical_views
    from jsonb_array_elements(p_views) view;

  select * into v_existing
    from content.compilation_run where requested_by_action = p_request_action;
  if found then
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'target', target,
                 'mediaType', media_type,
                 'contentDigest', content_digest
               ) order by target
             ),
             '[]'::jsonb
           )
      into v_existing_logical_views
      from content.compiled_view where compilation_run_id = v_existing.id;
    if v_existing.id is distinct from (p_result ->> 'id')::uuid
       or v_existing.basis_id is distinct from v_basis.id
       or v_existing.compiler_digest is distinct from p_result ->> 'compilerDigest'
       or v_existing.dependency_digest is distinct from p_result ->> 'dependencyDigest'
       or v_existing.run_status is distinct from v_status
       or v_existing.draft_only is distinct from (p_result ->> 'draftOnly')::boolean
       or v_existing.effective_classification is distinct from
          p_result ->> 'effectiveClassification'
       or v_existing.semantic_digest is distinct from nullif(p_result ->> 'semanticDigest', '')
       or v_existing.hir_provenance is distinct from p_result -> 'hirProvenance'
       or v_existing.cir_provenance is distinct from p_result -> 'cirProvenance'
       or v_existing.unresolved_references is distinct from p_result -> 'unresolvedReferences'
       or v_existing.omitted_subgraphs is distinct from p_result -> 'omittedSubgraphs'
       or v_existing.projection_capabilities is distinct from
          p_result -> 'projectionCapabilities'
       or v_existing.failure_code is distinct from nullif(p_result ->> 'failureCode', '')
       or v_existing.failure_message is distinct from nullif(p_result ->> 'failureMessage', '')
       or v_existing.diagnostics is distinct from p_result -> 'diagnostics'
       or v_existing.conversion_loss is distinct from p_result -> 'conversionLoss'
       or v_existing.run_digest is distinct from p_result ->> 'runDigest'
       or v_existing_logical_views is distinct from v_proposed_logical_views then
      raise exception 'idempotent compiler replay differs from recorded terminal receipt'
        using errcode = 'integrity_constraint_violation';
    end if;
    return v_existing.id;
  end if;

  insert into content.compilation_run
    (id, basis_id, compiler_registration_id, compiler_digest, dependency_digest,
     run_status, draft_only, effective_classification, semantic_digest,
     hir_provenance, cir_provenance, unresolved_references, omitted_subgraphs,
     projection_capabilities, diagnostics, conversion_loss, failure_code, failure_message,
     run_digest, requested_by_action, recorded_by)
  values
    ((p_result ->> 'id')::uuid, v_basis.id, v_registration.id,
     p_result ->> 'compilerDigest', p_result ->> 'dependencyDigest', v_status, v_draft_only,
     v_basis.effective_classification, nullif(p_result ->> 'semanticDigest', ''),
     p_result -> 'hirProvenance', p_result -> 'cirProvenance',
     p_result -> 'unresolvedReferences', p_result -> 'omittedSubgraphs',
     p_result -> 'projectionCapabilities', p_result -> 'diagnostics',
     p_result -> 'conversionLoss', nullif(p_result ->> 'failureCode', ''),
     nullif(p_result ->> 'failureMessage', ''), p_result ->> 'runDigest',
     p_request_action, v_action.actor_id);

  if v_status = 'succeeded' then
    select version into strict v_schema_version
      from registry.schema_release where is_current;
    for v_view in select value from jsonb_array_elements(p_views) value loop
      insert into core.object
        (id, object_type, authority_domain, lifecycle_state, classification,
         retention_class, schema_version, organization_id, title, created_by, updated_by)
      values
        ((v_view ->> 'artifactId')::uuid, 'artifact', 'artifact', 'draft',
         v_basis.effective_classification, 'project_record', v_schema_version,
         v_root_object.organization_id,
         left('Compiled document view: ' || (v_view ->> 'target'), 240),
         v_action.actor_id, v_action.actor_id);
      insert into content.artifact (id, artifact_kind, source_system)
      values ((v_view ->> 'artifactId')::uuid, 'report', 'object_store');
      insert into content.artifact_version
        (id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
         storage_uri, storage_version, created_by, created_by_action)
      values
        ((v_view ->> 'artifactVersionId')::uuid, (v_view ->> 'artifactId')::uuid, 1,
         'compiled:' || v_basis.basis_digest, v_view ->> 'contentDigest',
         (v_view ->> 'sizeBytes')::bigint, v_view ->> 'mediaType',
         v_view ->> 'storageUri', v_view ->> 'storageVersion',
         v_action.actor_id, p_request_action);
      insert into content.compiled_view
        (id, compilation_run_id, target, media_type, artifact_version_id,
         content_digest, effective_classification, recorded_by)
      values
        ((v_view ->> 'id')::uuid, (p_result ->> 'id')::uuid, v_view ->> 'target',
         v_view ->> 'mediaType', (v_view ->> 'artifactVersionId')::uuid,
         v_view ->> 'contentDigest', v_basis.effective_classification, v_action.actor_id);
    end loop;
  end if;
  return (p_result ->> 'id')::uuid;
end
$$;

revoke all on function content.compiler_runtime_active() from public;
-- Every role whose SELECT policies include this predicate must be able to evaluate it.
-- Direct invocation returns false: only SECURITY DEFINER execution plus matching lease wins.
grant execute on function content.compiler_runtime_active()
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
revoke all on function content.compiler_runtime_request(uuid) from public;
grant execute on function content.compiler_runtime_request(uuid) to kf_worker;
revoke all on function content.record_compilation_result(uuid, jsonb, jsonb) from public;
grant execute on function content.record_compilation_result(uuid, jsonb, jsonb) to kf_worker;

-- Raw DML cannot create a partial authoritative receipt. The SECURITY DEFINER recorder above
-- owns the complete run/view transaction; typed bindings have no action atom yet and therefore
-- remain owner-import-only until one is introduced.
revoke insert on content.compilation_run, content.compiled_view from kf_worker, kf_app;
revoke insert on content.typed_binding from kf_app, kf_worker;

comment on function content.compiler_runtime_request(uuid) is
  'Worker-only exact finalized Liminal Basis and immutable versioned input projection.';
comment on function content.record_compilation_result(uuid, jsonb, jsonb) is
  'Worker-only atomic terminal compilation receipt and content-addressed view recorder.';
comment on table content.document_compiler_registration is
  'Owner-only immutable compiler pin and qualification registry; absence of revocation means enabled.';

-- migrate:down

drop function if exists content.record_compilation_result(uuid, jsonb, jsonb);
drop function if exists content.compiler_runtime_request(uuid);
drop policy if exists document_compiler_revocation_authority_insert
  on content.document_compiler_revocation;
drop policy if exists document_compiler_revocation_authority_read
  on content.document_compiler_revocation;
drop policy if exists document_compiler_revocation_backup on content.document_compiler_revocation;
drop policy if exists document_compiler_registration_authority_insert
  on content.document_compiler_registration;
drop policy if exists document_compiler_registration_authority_read
  on content.document_compiler_registration;
drop policy if exists document_compiler_registration_backup
  on content.document_compiler_registration;
drop policy if exists compiled_view_compiler_runtime on content.compiled_view;
drop policy if exists compilation_run_compiler_runtime on content.compilation_run;
drop policy if exists compilation_basis_binding_compiler_runtime on content.compilation_basis_binding;
drop policy if exists compilation_basis_composition_compiler_runtime on content.compilation_basis_composition;
drop policy if exists compilation_basis_fragment_compiler_runtime on content.compilation_basis_fragment;
drop policy if exists compilation_basis_compiler_runtime on content.compilation_basis;
drop policy if exists composition_input_compiler_runtime on content.composition_input;
drop policy if exists typed_binding_compiler_runtime on content.typed_binding;
drop policy if exists composition_revision_compiler_runtime on content.composition_revision;
drop policy if exists authored_fragment_revision_compiler_runtime on content.authored_fragment_revision;
drop policy if exists document_composition_compiler_runtime on content.document_composition;
drop policy if exists authored_fragment_compiler_runtime on content.authored_fragment;
drop policy if exists document_source_holder_compiler_runtime on content.document_source_holder;
drop policy if exists document_subject_compiler_runtime on content.document_subject;
drop policy if exists object_compiler_runtime on core.object;
drop function if exists content.compiler_runtime_active();
drop table if exists content.compiler_runtime_lease;
drop function if exists content.compiler_runtime_exact_keys(jsonb, text[]);
alter table if exists content.compilation_run
  drop constraint if exists compilation_run_one_per_request;

drop trigger if exists document_publication_guard_0_action on content.document_publication;
drop trigger if exists document_subject_guard_0_holder_update on content.document_subject;
drop trigger if exists composition_revision_action_complete on content.composition_revision;
drop trigger if exists compilation_basis_guard_2_action_members on content.compilation_basis;
drop function if exists content.enforce_document_holder_update_action();
drop function if exists content.enforce_document_composition_action_complete();
drop function if exists content.enforce_compilation_basis_action_members();

drop trigger if exists proposal_overlay_guard_1_action on content.proposal_overlay;
drop trigger if exists compilation_basis_binding_guard_1_action
  on content.compilation_basis_binding;
drop trigger if exists compilation_basis_composition_guard_1_action
  on content.compilation_basis_composition;
drop trigger if exists compilation_basis_fragment_guard_1_action
  on content.compilation_basis_fragment;
drop trigger if exists compilation_basis_guard_1_action on content.compilation_basis;
drop trigger if exists composition_input_guard_1_action on content.composition_input;
drop trigger if exists composition_revision_guard_1_action on content.composition_revision;
drop trigger if exists authored_fragment_revision_guard_1_action
  on content.authored_fragment_revision;
drop trigger if exists document_composition_guard_1_action on content.document_composition;
drop trigger if exists authored_fragment_guard_1_action on content.authored_fragment;
drop trigger if exists document_source_holder_guard_1_action on content.document_source_holder;
drop trigger if exists document_subject_guard_1_action on content.document_subject;
drop function if exists content.enforce_document_typed_insert();

drop trigger if exists compilation_basis_guard_0_registry on content.compilation_basis;
drop function if exists content.bind_compilation_basis_compiler();

create or replace function content.enforce_compilation_run_qualification() returns trigger
language plpgsql
as $$
declare
  v_draft_only boolean;
  v_effective_classification text;
  v_finalized_at timestamptz;
begin
  select b.compiler_kind <> 'liminal'
         or b.qualification_state <> 'qualified'
         or not b.qualification_ratified
         or b.qualification_receipt_digest is null,
         b.effective_classification,
         b.finalized_at
    into v_draft_only, v_effective_classification, v_finalized_at
    from content.compilation_basis b
   where b.id = new.basis_id;
  if not found or v_finalized_at is null or v_effective_classification is null then
    raise exception 'compilation runs require a complete finalized basis'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_draft_only is distinct from new.draft_only then
    raise exception 'compilation run draft_only does not match its compiler qualification'
      using errcode = 'integrity_constraint_violation';
  end if;
  new.effective_classification := v_effective_classification;
  return new;
end
$$;

alter table if exists content.compilation_run
  drop column if exists projection_capabilities,
  drop column if exists omitted_subgraphs,
  drop column if exists unresolved_references,
  drop column if exists cir_provenance,
  drop column if exists hir_provenance,
  drop column if exists compiler_registration_id;
alter table if exists content.compilation_basis
  drop column if exists compiler_registration_id;

drop policy if exists document_compiler_revocation_backup
  on content.document_compiler_revocation;
drop policy if exists document_compiler_registration_backup
  on content.document_compiler_registration;
drop table if exists content.document_compiler_revocation;
drop table if exists content.document_compiler_registration;
drop function if exists content.refuse_duplicate_enabled_compiler();
revoke usage on schema content from kf_migrator;

grant insert on content.compilation_run, content.compiled_view to kf_worker;
grant insert on content.typed_binding to kf_app;
