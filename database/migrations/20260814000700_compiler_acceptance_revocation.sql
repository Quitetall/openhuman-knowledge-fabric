-- migrate:up

-- Acceptance is an application action, but publication is an authoritative database receipt.
-- Recheck the compiler registry at publication time so revocation between compilation and
-- acceptance cannot turn stale derived bytes into an institutional publication.
--
-- Early dogfood applied v005 before legacy compiler rows were made preservable. Converge those
-- databases without resetting them: historical NULL closures stay disabled, while every new
-- registration must carry measured closure identity.
alter table content.document_compiler_registration
  alter column runtime_closure_digest drop not null;
alter table content.compilation_basis
  alter column runtime_closure_digest drop not null;

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
    select 1 from content.document_compiler_registration registration
     where registration.compiler_name = new.compiler_name
       and registration.compiler_version = new.compiler_version
       and registration.protocol = new.protocol
       and registration.liminal_commit_sha = new.liminal_commit_sha
       and registration.cargo_lock_digest = new.cargo_lock_digest
       and registration.executable_digest = new.executable_digest
       and registration.runtime_closure_digest = new.runtime_closure_digest
       and not exists (
         select 1 from content.document_compiler_revocation revoked
          where revoked.registration_id = registration.id
       )
  ) then
    raise exception 'an enabled registration already exists for this compiler pin'
      using errcode = 'unique_violation';
  end if;
  return new;
end
$$;

create function content.lock_document_compiler_registration(
  p_registration_id uuid
) returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  if p_registration_id is null then
    return;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'kf-document-compiler-registration:' || p_registration_id::text,
      0
    )
  );
end
$$;

revoke all on function content.lock_document_compiler_registration(uuid) from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create function content.serialize_document_compiler_revocation() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
begin
  perform content.lock_document_compiler_registration(new.registration_id);
  return new;
end
$$;

revoke all on function content.serialize_document_compiler_revocation() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
create trigger document_compiler_revocation_serialized
  before insert on content.document_compiler_revocation
  for each row execute function content.serialize_document_compiler_revocation();

create function content.document_compiler_enabled(
  p_registration_id uuid,
  p_basis_id uuid
) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, content
as $$
declare
  v_enabled boolean;
begin
  perform content.lock_document_compiler_registration(p_registration_id);
  select exists (
    select 1
      from content.document_compiler_registration registration
      join content.compilation_basis basis
        on basis.id = p_basis_id
       and basis.compiler_registration_id = registration.id
     where registration.id = p_registration_id
       and registration.runtime_closure_digest is not null
       and registration.runtime_closure_digest = basis.runtime_closure_digest
       and not exists (
         select 1
           from content.document_compiler_revocation revoked
          where revoked.registration_id = registration.id
       )
  ) into v_enabled;
  return v_enabled;
end
$$;

revoke all on function content.document_compiler_enabled(uuid, uuid) from public,
  kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
grant execute on function content.document_compiler_enabled(uuid, uuid) to kf_app, kf_worker;

-- Keep v005 implementation available as one atom, but place a small forward-compatibility
-- gate in front of it. This also hardens dogfood databases that applied the pre-legacy v005
-- body before the source migration was corrected.
alter function content.compiler_runtime_request(uuid)
  rename to compiler_runtime_request_v005;
revoke all on function content.compiler_runtime_request_v005(uuid) from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create function content.compiler_runtime_request(p_request_action uuid) returns jsonb
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

create function content.compilation_provenance_covers_basis(
  p_basis_id uuid,
  p_provenance jsonb
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, content
as $$
  with expected_source(kind, id, content_digest) as (
    select 'fragment'::text, source_revision.id, source_revision.content_digest
      from content.compilation_basis_fragment basis_source
      join content.authored_fragment_revision source_revision
        on source_revision.id = basis_source.fragment_revision_id
     where basis_source.basis_id = p_basis_id
    union
    select case source_input.input_role
             when 'resource' then 'resource'::text
             else 'compiled_view'::text
           end,
           case source_input.input_role
             when 'resource' then source_input.resource_version_id
             else source_input.compiled_view_id
           end,
           source_input.content_digest
      from content.compilation_basis_composition basis_source
      join content.composition_input source_input
        on source_input.composition_revision_id = basis_source.composition_revision_id
     where basis_source.basis_id = p_basis_id
       and source_input.input_role in ('resource', 'generated_view')
  ), allowed_source(kind, id, content_digest) as (
    select 'fragment'::text, source_revision.id, source_revision.content_digest
      from content.compilation_basis_fragment basis_source
      join content.authored_fragment_revision source_revision
        on source_revision.id = basis_source.fragment_revision_id
     where basis_source.basis_id = p_basis_id
    union
    select 'composition'::text, source_revision.id, source_revision.revision_digest
      from content.compilation_basis_composition basis_source
      join content.composition_revision source_revision
        on source_revision.id = basis_source.composition_revision_id
     where basis_source.basis_id = p_basis_id
    union
    select 'binding'::text, source_binding.id, source_binding.binding_digest
      from content.compilation_basis_binding basis_source
      join content.typed_binding source_binding on source_binding.id = basis_source.binding_id
     where basis_source.basis_id = p_basis_id
    union
    select kind, id, content_digest from expected_source
  ), claim as (
    select value,
           value ->> 'sourceKind' as kind,
           value ->> 'sourceId' as id,
           value ->> 'sourceDigest' as content_digest
      from jsonb_array_elements(
        case when jsonb_typeof(p_provenance) = 'array' then p_provenance else '[]'::jsonb end
      )
  )
  select jsonb_typeof(p_provenance) = 'array'
     and not exists (
       select 1 from expected_source expected
        where not exists (
          select 1 from claim
           where claim.kind = expected.kind
             and claim.id = expected.id::text
             and claim.content_digest = expected.content_digest
        )
     )
     and not exists (
       select 1 from claim
        where not exists (
          select 1 from allowed_source allowed
           where claim.kind = allowed.kind
             and claim.id = allowed.id::text
             and claim.content_digest = allowed.content_digest
        )
     )
     and not exists (
       select 1 from claim
        group by kind, id, content_digest
        having count(*) > 1
     )
$$;

revoke all on function content.compilation_provenance_covers_basis(uuid, jsonb) from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

-- Acceptance must audit historical runs too, not only rows inserted after this migration.
-- Restrict the result to a run visible in caller's active organization/classification context
-- so this cannot become an oracle over hidden Basis membership.
create function content.compilation_run_provenance_complete(
  p_run_id uuid,
  p_representation text
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, content, core, registry
as $$
  select coalesce((
    select case p_representation
             when 'hir' then content.compilation_provenance_covers_basis(
               run.basis_id,
               run.hir_provenance
             )
             when 'cir' then content.compilation_provenance_covers_basis(
               run.basis_id,
               run.cir_provenance
             )
             else false
           end
      from content.compilation_run run
      join content.compilation_basis basis on basis.id = run.basis_id
      join content.composition_revision composition
        on composition.id = basis.root_composition_revision_id
      join content.document_subject subject on subject.id = composition.composition_id
      join core.object object on object.id = subject.object_id
     where run.id = p_run_id
       and object.organization_id = core.current_organization()
       and (select rank from registry.classification
             where id = basis.effective_classification)
           <= core.current_classification_rank()
  ), false)
$$;

revoke all on function content.compilation_run_provenance_complete(uuid, text) from public,
  kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
grant execute on function content.compilation_run_provenance_complete(uuid, text) to kf_app;

create function content.enforce_compilation_provenance_coverage() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
begin
  if new.run_status = 'succeeded'
     and not content.compilation_provenance_covers_basis(new.basis_id, new.hir_provenance) then
    raise exception 'HIR provenance omits one or more Basis compiler inputs'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.run_status = 'succeeded'
     and not content.compilation_provenance_covers_basis(new.basis_id, new.cir_provenance) then
    raise exception 'CIR provenance omits one or more Basis compiler inputs'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

revoke all on function content.enforce_compilation_provenance_coverage() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
create trigger compilation_run_guard_4_provenance_coverage
  before insert on content.compilation_run
  for each row execute function content.enforce_compilation_provenance_coverage();

create or replace function content.enforce_compilation_publication_completeness() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
begin
  if not exists (
    select 1
      from content.compiled_view view
      join content.compilation_run run on run.id = view.compilation_run_id
      join content.compilation_basis basis on basis.id = run.basis_id
     where view.id = new.compiled_view_id
       and run.run_status = 'succeeded'
       and not run.draft_only
       and content.document_compiler_enabled(run.compiler_registration_id, basis.id)
       and jsonb_array_length(run.hir_provenance) > 0
       and jsonb_array_length(run.cir_provenance) > 0
       and run.unresolved_references = '[]'::jsonb
       and run.omitted_subgraphs = '[]'::jsonb
       and run.conversion_loss = '[]'::jsonb
       and content.compilation_provenance_covers_basis(run.basis_id, run.hir_provenance)
       and content.compilation_provenance_covers_basis(run.basis_id, run.cir_provenance)
  ) then
    raise exception
      'publication requires complete resolved provenance-covered lossless evidence from an enabled compiler'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

-- migrate:down

-- Closure nullability and the new-registration guard are convergence to corrected v005
-- semantics. Reverting them would make a database restored through this migration disagree
-- with the source migration chain and could strand preserved historical registrations.
drop function if exists content.compiler_runtime_request(uuid);
alter function content.compiler_runtime_request_v005(uuid)
  rename to compiler_runtime_request;
grant execute on function content.compiler_runtime_request(uuid) to kf_worker;

create or replace function content.enforce_compilation_publication_completeness() returns trigger
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

drop trigger if exists compilation_run_guard_4_provenance_coverage on content.compilation_run;
drop function if exists content.enforce_compilation_provenance_coverage();
drop function if exists content.compilation_run_provenance_complete(uuid, text);
drop function if exists content.compilation_provenance_covers_basis(uuid, jsonb);
drop function if exists content.document_compiler_enabled(uuid, uuid);
drop trigger if exists document_compiler_revocation_serialized
  on content.document_compiler_revocation;
drop function if exists content.serialize_document_compiler_revocation();
drop function if exists content.lock_document_compiler_registration(uuid);
