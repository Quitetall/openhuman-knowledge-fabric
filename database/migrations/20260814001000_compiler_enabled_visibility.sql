-- migrate:up

-- The compiler runtime and publication trigger need an unscoped owner check, but exposing that
-- SECURITY DEFINER function to kf_app made known hidden Basis UUIDs an RLS oracle. Keep one
-- private atom for internal authority paths and place an explicit organization/classification
-- projection in front of application reads.
alter function content.document_compiler_enabled(uuid, uuid)
  rename to document_compiler_enabled_internal;
revoke all on function content.document_compiler_enabled_internal(uuid, uuid) from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create function content.document_compiler_enabled(
  p_registration_id uuid,
  p_basis_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, content, core, registry
as $$
declare
  v_visible boolean;
begin
  select exists (
    select 1
      from content.compilation_basis basis
      join content.composition_revision composition
        on composition.id = basis.root_composition_revision_id
      join content.document_subject subject on subject.id = composition.composition_id
      join core.object object on object.id = subject.object_id
     where basis.id = p_basis_id
       and basis.compiler_registration_id = p_registration_id
       and object.organization_id = core.current_organization()
       and (select rank from registry.classification
             where id = basis.effective_classification)
           <= core.current_classification_rank()
  ) into v_visible;
  if not v_visible then
    return false;
  end if;
  return content.document_compiler_enabled_internal(p_registration_id, p_basis_id);
end
$$;

revoke all on function content.document_compiler_enabled(uuid, uuid) from public,
  kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
grant execute on function content.document_compiler_enabled(uuid, uuid) to kf_app;

create or replace function content.compiler_runtime_request(p_request_action uuid) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_registration_id uuid;
  v_basis_id uuid;
begin
  begin
    select basis.compiler_registration_id, basis.id
      into v_registration_id, v_basis_id
      from core.action action
      join content.compilation_basis basis
        on basis.id = (action.parameters ->> 'basis_id')::uuid
     where action.id = p_request_action
       and action.action_type = 'request_document_compilation'
       and action.result_status = 'applied';
  exception when invalid_text_representation then
    raise exception 'compilation request has an invalid Basis identifier'
      using errcode = 'integrity_constraint_violation';
  end;
  if not found
     or not content.document_compiler_enabled_internal(v_registration_id, v_basis_id) then
    raise exception 'compilation request compiler registration is disabled or mismatched'
      using errcode = 'insufficient_privilege';
  end if;
  return content.compiler_runtime_request_v005(p_request_action);
end
$$;

revoke all on function content.compiler_runtime_request(uuid) from public;
grant execute on function content.compiler_runtime_request(uuid) to kf_worker;

-- migrate:down

drop function if exists content.document_compiler_enabled(uuid, uuid);
alter function content.document_compiler_enabled_internal(uuid, uuid)
  rename to document_compiler_enabled;
revoke all on function content.document_compiler_enabled(uuid, uuid) from public,
  kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
grant execute on function content.document_compiler_enabled(uuid, uuid) to kf_app, kf_worker;

create or replace function content.compiler_runtime_request(p_request_action uuid) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_registration_id uuid;
  v_basis_id uuid;
begin
  begin
    select basis.compiler_registration_id, basis.id
      into v_registration_id, v_basis_id
      from core.action action
      join content.compilation_basis basis
        on basis.id = (action.parameters ->> 'basis_id')::uuid
     where action.id = p_request_action
       and action.action_type = 'request_document_compilation'
       and action.result_status = 'applied';
  exception when invalid_text_representation then
    raise exception 'compilation request has an invalid Basis identifier'
      using errcode = 'integrity_constraint_violation';
  end;
  if not found
     or not content.document_compiler_enabled(v_registration_id, v_basis_id) then
    raise exception 'compilation request compiler registration is disabled or mismatched'
      using errcode = 'insufficient_privilege';
  end if;
  return content.compiler_runtime_request_v005(p_request_action);
end
$$;

revoke all on function content.compiler_runtime_request(uuid) from public;
grant execute on function content.compiler_runtime_request(uuid) to kf_worker;
