-- migrate:up

-- Expand safely for installations that already applied compiler runtime v004. Historical rows
-- remain preserved with a NULL closure and are therefore disabled. An owner may later attach
-- measured closure evidence; this migration never guesses or fabricates that identity.
alter table content.document_compiler_registration
  add column runtime_closure_digest text
    check (runtime_closure_digest ~ '^[0-9a-f]{64}$');
alter table content.compilation_basis
  add column runtime_closure_digest text
    check (runtime_closure_digest ~ '^[0-9a-f]{64}$');

drop index content.document_compiler_registration_identity;
create unique index document_compiler_registration_identity
  on content.document_compiler_registration (
    compiler_name, compiler_version, protocol, liminal_commit_sha,
    cargo_lock_digest, executable_digest, runtime_closure_digest, qualification_state,
    coalesce(qualification_receipt_digest, ''), qualification_ratified
  );

create or replace function content.refuse_duplicate_enabled_compiler() returns trigger
language plpgsql
as $$
begin
  if new.runtime_closure_digest is null then
    raise exception 'new compiler registrations require an exact runtime-closure digest'
      using errcode = 'not_null_violation';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'kf-document-compiler-pin:' || new.compiler_name || ':' || new.compiler_version || ':'
      || new.protocol || ':' || new.liminal_commit_sha || ':' || new.cargo_lock_digest || ':'
      || new.executable_digest || ':' || new.runtime_closure_digest,
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
       and r.runtime_closure_digest = new.runtime_closure_digest
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

create or replace function content.bind_compilation_basis_compiler() returns trigger
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
     and r.runtime_closure_digest = new.runtime_closure_digest
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
    'runtimeClosureDigest', v_registration.runtime_closure_digest,
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
  new.runtime_closure_digest := v_registration.runtime_closure_digest;
  return new;
end
$$;

revoke all on function content.bind_compilation_basis_compiler() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

-- Re-declare v004's audited request projection at its stable signature. Same-signature
-- replacement works after an already-applied v004 and in a fresh migration chain.
create or replace function content.compiler_runtime_request(p_request_action uuid) returns jsonb
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
     or v_registration.executable_digest is distinct from v_basis.executable_digest
     or v_registration.runtime_closure_digest is distinct from v_basis.runtime_closure_digest then
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
    'runtimeClosureDigest', v_registration.runtime_closure_digest,
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

revoke all on function content.compiler_runtime_request(uuid) from public;
grant execute on function content.compiler_runtime_request(uuid) to kf_worker;

-- Recorder validates receipt shape; this table trigger independently binds every HIR/CIR source
-- tuple to exact immutable Basis membership and digest, including any owner-side import path.
create function content.enforce_compilation_provenance_basis() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
declare
  v_claim jsonb;
  v_source_id uuid;
begin
  for v_claim in
    select value from jsonb_array_elements(new.hir_provenance || new.cir_provenance) value
  loop
    begin
      v_source_id := (v_claim ->> 'sourceId')::uuid;
    exception when invalid_text_representation then
      raise exception 'compiler provenance source identifier is malformed'
        using errcode = 'invalid_parameter_value';
    end;
    if not coalesce((case v_claim ->> 'sourceKind'
      when 'fragment' then exists (
        select 1
          from content.compilation_basis_fragment basis_source
          join content.authored_fragment_revision source_revision
            on source_revision.id = basis_source.fragment_revision_id
         where basis_source.basis_id = new.basis_id
           and source_revision.id = v_source_id
           and source_revision.content_digest = v_claim ->> 'sourceDigest'
      )
      when 'composition' then exists (
        select 1
          from content.compilation_basis_composition basis_source
          join content.composition_revision source_revision
            on source_revision.id = basis_source.composition_revision_id
         where basis_source.basis_id = new.basis_id
           and source_revision.id = v_source_id
           and source_revision.revision_digest = v_claim ->> 'sourceDigest'
      )
      when 'binding' then exists (
        select 1
          from content.compilation_basis_binding basis_source
          join content.typed_binding source_binding on source_binding.id = basis_source.binding_id
         where basis_source.basis_id = new.basis_id
           and source_binding.id = v_source_id
           and source_binding.binding_digest = v_claim ->> 'sourceDigest'
      )
      when 'resource' then exists (
        select 1
          from content.compilation_basis_composition basis_source
          join content.composition_input source_input
            on source_input.composition_revision_id = basis_source.composition_revision_id
         where basis_source.basis_id = new.basis_id
           and source_input.input_role = 'resource'
           and source_input.resource_version_id = v_source_id
           and source_input.content_digest = v_claim ->> 'sourceDigest'
      )
      when 'compiled_view' then exists (
        select 1
          from content.compilation_basis_composition basis_source
          join content.composition_input source_input
            on source_input.composition_revision_id = basis_source.composition_revision_id
         where basis_source.basis_id = new.basis_id
           and source_input.input_role = 'generated_view'
           and source_input.compiled_view_id = v_source_id
           and source_input.content_digest = v_claim ->> 'sourceDigest'
      )
      else false
    end), false) then
      raise exception 'compiler provenance source is not pinned by exact Basis digest'
        using errcode = 'integrity_constraint_violation';
    end if;
  end loop;
  return new;
end
$$;

revoke all on function content.enforce_compilation_provenance_basis() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
create trigger compilation_run_guard_3_provenance_basis
  before insert on content.compilation_run
  for each row execute function content.enforce_compilation_provenance_basis();

-- Migration 001 could not inspect evidence columns introduced by v004. Publication remains
-- fail-closed even if an application-side precondition is bypassed or becomes stale.
create function content.enforce_compilation_publication_completeness() returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
      from content.compiled_view view
      join content.compilation_run run on run.id = view.compilation_run_id
     where view.id = new.compiled_view_id
       and run.run_status = 'succeeded'
       and not run.draft_only
       and jsonb_array_length(run.hir_provenance) > 0
       and jsonb_array_length(run.cir_provenance) > 0
       and run.unresolved_references = '[]'::jsonb
       and run.omitted_subgraphs = '[]'::jsonb
       and run.conversion_loss = '[]'::jsonb
  ) then
    raise exception
      'publication requires complete resolved provenance-covered lossless compiler evidence'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger document_publication_compilation_complete
  before insert on content.document_publication
  for each row execute function content.enforce_compilation_publication_completeness();

-- Backup authority sees complete promotion and physical-preservation evidence through explicit
-- SELECT-only grants. FORCE RLS promotion tables require dedicated cross-organization policies.
create policy promotion_receipt_backup on ml.promotion_receipt
  for select to kf_backup using (true);
create policy promotion_receipt_evidence_backup on ml.promotion_receipt_evidence
  for select to kf_backup using (true);
create policy promotion_revocation_backup on ml.promotion_revocation
  for select to kf_backup using (true);
grant select on ops.physical_failure_domain_evidence, ops.encrypted_backup_evidence to kf_backup;

comment on column content.document_compiler_registration.runtime_closure_digest is
  'RFC 8785 digest of ordered sandbox path and exact runtime-file content-digest records; NULL marks a preserved pre-v005 registration that is disabled until explicit owner migration.';

-- migrate:down

revoke select on ops.physical_failure_domain_evidence, ops.encrypted_backup_evidence from kf_backup;
drop policy if exists promotion_revocation_backup on ml.promotion_revocation;
drop policy if exists promotion_receipt_evidence_backup on ml.promotion_receipt_evidence;
drop policy if exists promotion_receipt_backup on ml.promotion_receipt;
drop trigger if exists document_publication_compilation_complete on content.document_publication;
drop function if exists content.enforce_compilation_publication_completeness();
drop trigger if exists compilation_run_guard_3_provenance_basis on content.compilation_run;
drop function if exists content.enforce_compilation_provenance_basis();

drop function if exists content.compiler_runtime_request(uuid);
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

revoke all on function content.compiler_runtime_request(uuid) from public;
grant execute on function content.compiler_runtime_request(uuid) to kf_worker;

create or replace function content.bind_compilation_basis_compiler() returns trigger
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

create or replace function content.refuse_duplicate_enabled_compiler() returns trigger
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

drop index content.document_compiler_registration_identity;
alter table content.compilation_basis drop column runtime_closure_digest;
alter table content.document_compiler_registration drop column runtime_closure_digest;
create unique index document_compiler_registration_identity
  on content.document_compiler_registration (
    compiler_name, compiler_version, protocol, liminal_commit_sha,
    cargo_lock_digest, executable_digest, qualification_state,
    coalesce(qualification_receipt_digest, ''), qualification_ratified
  );
