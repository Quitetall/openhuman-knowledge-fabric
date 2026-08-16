-- migrate:up

-- Keep exact rollback semantics without rewriting migration 007: retain its function under
-- an explicit historical name, then install the compiler-contract identity at the public name.
alter function content.compilation_provenance_covers_basis(uuid, jsonb)
  rename to compilation_provenance_covers_basis_v1;

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
           value ->> 'nodeId' as node_id,
           value ->> 'sourceKind' as kind,
           value ->> 'sourceId' as id,
           value -> 'sourcePath' as source_path_json,
           value ->> 'sourcePath' as source_path,
           value ->> 'sourceDigest' as content_digest
      from jsonb_array_elements(
        case when jsonb_typeof(p_provenance) = 'array' then p_provenance else '[]'::jsonb end
      )
  )
  select jsonb_typeof(p_provenance) = 'array'
     and not exists (
       select 1 from claim
        where jsonb_typeof(value) <> 'object'
           or not value ?& array[
             'nodeId', 'sourceKind', 'sourceId', 'sourcePath', 'sourceDigest'
           ]
           or case when jsonb_typeof(value) = 'object' then
                value - array[
                  'nodeId', 'sourceKind', 'sourceId', 'sourcePath', 'sourceDigest'
                ] <> '{}'::jsonb
              else true end
           or node_id is null or node_id = ''
           or kind is null or kind = ''
           or id is null or id = ''
           or content_digest !~ '^[0-9a-f]{64}$'
           or (
             jsonb_typeof(source_path_json) not in ('null', 'string')
             or (jsonb_typeof(source_path_json) = 'string' and source_path = '')
           )
     )
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
        group by node_id, kind, id, source_path_json
        having count(*) > 1
     )
$$;

revoke all on function content.compilation_provenance_covers_basis(uuid, jsonb) from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

comment on function content.compilation_provenance_covers_basis(uuid, jsonb) is
  'Validates exact Basis digest coverage; duplicate identity is nodeId/sourceKind/sourceId/sourcePath, matching kf-document-v1.';

-- migrate:down

drop function content.compilation_provenance_covers_basis(uuid, jsonb);
alter function content.compilation_provenance_covers_basis_v1(uuid, jsonb)
  rename to compilation_provenance_covers_basis;
