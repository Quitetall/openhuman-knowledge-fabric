-- migrate:up

-- Parser receipts retain exact hash preimages. Historical rows remain readable with NULL
-- preimages; every new row must pass trigger verification and deferred atom reconciliation.
alter table content.document_parse
  add column source_digest text check (source_digest ~ '^[0-9a-f]{64}$'),
  add column loss_digest text check (loss_digest ~ '^[0-9a-f]{64}$'),
  add column loss_preimage text,
  add column projection_preimage text;

alter table content.document_parse
  add constraint document_parse_source_digest
  foreign key (artifact_version_id, source_digest)
  references content.artifact_version (id, sha256) on delete restrict;

alter table content.document_atom add column atom_preimage text;

create function content.provenance_exact_keys(p_value jsonb, p_keys text[]) returns boolean
language sql
immutable
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

revoke all on function content.provenance_exact_keys(jsonb, text[]) from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create function content.verify_document_parse_preimage() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
declare
  v_loss jsonb;
  v_projection jsonb;
  v_artifact_digest text;
begin
  if new.source_digest is null
     or new.loss_digest is null
     or new.loss_preimage is null
     or new.projection_preimage is null then
    raise exception 'new document parses require complete source, loss, and projection preimages'
      using errcode = 'not_null_violation';
  end if;
  if octet_length(new.loss_preimage) > 67108864
     or octet_length(new.projection_preimage) > 67108864 then
    raise exception 'document parse preimage exceeds 64 MiB safety limit'
      using errcode = 'program_limit_exceeded';
  end if;
  select sha256 into v_artifact_digest
    from content.artifact_version where id = new.artifact_version_id;
  if not found or v_artifact_digest is distinct from new.source_digest then
    raise exception 'document parse source digest differs from exact artifact version'
      using errcode = 'integrity_constraint_violation';
  end if;
  begin
    v_loss := new.loss_preimage::jsonb;
    v_projection := new.projection_preimage::jsonb;
  exception when others then
    raise exception 'document parse preimage is not valid JSON'
      using errcode = 'invalid_parameter_value';
  end;
  if encode(public.digest(convert_to(new.loss_preimage, 'UTF8'), 'sha256'), 'hex')
       is distinct from new.loss_digest
     or v_loss is distinct from new.conversion_loss then
    raise exception 'document parse loss digest or preimage differs from conversion-loss rows'
      using errcode = 'integrity_constraint_violation';
  end if;
  if encode(public.digest(convert_to(new.projection_preimage, 'UTF8'), 'sha256'), 'hex')
       is distinct from new.content_digest
     or not content.provenance_exact_keys(
       v_projection, array['projectionContract', 'atoms', 'conversionLoss']
     )
     or v_projection ->> 'projectionContract' is distinct from new.projection_contract
     or jsonb_typeof(v_projection -> 'atoms') <> 'array'
     or v_projection -> 'conversionLoss' is distinct from new.conversion_loss then
    raise exception 'document projection digest or preimage differs from parse receipt'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

revoke all on function content.verify_document_parse_preimage() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create trigger document_parse_guard_0_preimage
  before insert on content.document_parse
  for each row execute function content.verify_document_parse_preimage();

create function content.verify_document_atom_preimage() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
declare
  v_claim jsonb;
begin
  if new.atom_preimage is null then
    raise exception 'new document atoms require an exact canonical claim preimage'
      using errcode = 'not_null_violation';
  end if;
  begin
    v_claim := new.atom_preimage::jsonb;
  exception when others then
    raise exception 'document atom preimage is not valid JSON'
      using errcode = 'invalid_parameter_value';
  end;
  if encode(public.digest(convert_to(new.atom_preimage, 'UTF8'), 'sha256'), 'hex')
       is distinct from new.atom_digest
     or not content.provenance_exact_keys(
       v_claim, array['ordinal', 'kind', 'level', 'text', 'attributes']
     )
     or (v_claim ->> 'ordinal')::integer is distinct from new.ordinal
     or v_claim ->> 'kind' is distinct from new.atom_kind
     or (case when jsonb_typeof(v_claim -> 'level') = 'null'
           then new.heading_level is not null
           else (v_claim ->> 'level')::integer is distinct from new.heading_level
         end)
     or v_claim ->> 'text' is distinct from new.text_content
     or v_claim -> 'attributes' is distinct from new.attributes then
    raise exception 'document atom digest or preimage differs from atom fields'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'document atom preimage contains malformed numeric fields'
      using errcode = 'invalid_parameter_value';
end;
$$;

revoke all on function content.verify_document_atom_preimage() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create trigger document_atom_guard_0_preimage
  before insert on content.document_atom
  for each row execute function content.verify_document_atom_preimage();

create function content.assert_document_parse_preimage_complete() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
declare
  v_parse_id uuid;
  v_expected jsonb;
  v_actual jsonb;
begin
  v_parse_id := coalesce(
    nullif(to_jsonb(new) ->> 'parse_id', '')::uuid,
    nullif(to_jsonb(new) ->> 'id', '')::uuid
  );
  select projection_preimage::jsonb -> 'atoms' into v_expected
    from content.document_parse where id = v_parse_id;
  select coalesce(jsonb_agg(atom_preimage::jsonb order by ordinal), '[]'::jsonb)
    into v_actual from content.document_atom where parse_id = v_parse_id;
  if v_expected is null or v_expected is distinct from v_actual then
    raise exception 'persisted document atoms differ from exact projection preimage'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

revoke all on function content.assert_document_parse_preimage_complete() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create constraint trigger document_parse_preimage_complete
  after insert on content.document_parse
  deferrable initially deferred
  for each row execute function content.assert_document_parse_preimage_complete();
create constraint trigger document_atom_parse_preimage_complete
  after insert on content.document_atom
  deferrable initially deferred
  for each row execute function content.assert_document_parse_preimage_complete();

comment on column content.document_parse.source_digest is
  'Server-recomputed SHA-256 over exact parser input bytes; NULL marks a legacy unverified parse.';
comment on column content.document_parse.projection_preimage is
  'Exact RFC 8785 receipt bytes whose SHA-256 is content_digest; NULL marks legacy evidence.';
comment on column content.document_atom.atom_preimage is
  'Exact RFC 8785 atom-claim bytes whose SHA-256 is atom_digest; NULL marks legacy evidence.';

-- Compiler run digests commit to one retained semantic graph and complete receipt preimage.
-- Separate append-only table preserves old runs without pretending missing preimages existed.
create table content.compilation_run_preimage (
  run_id               uuid primary key
                         references content.compilation_run (id) on delete restrict,
  semantic_graph       jsonb,
  semantic_preimage    text,
  canonical_preimage   text not null,
  recorded_at          timestamptz not null default now(),
  recorded_by          uuid not null
);

create trigger compilation_run_preimage_append_only
  before update or delete or truncate on content.compilation_run_preimage
  for each statement execute function core.refuse_mutation();

alter table content.compilation_run_preimage enable row level security;
alter table content.compilation_run_preimage force row level security;
create policy compilation_run_preimage_scope on content.compilation_run_preimage
  for select using (
    exists (select 1 from content.compilation_run r where r.id = run_id)
  );
create policy compilation_run_preimage_compiler_runtime on content.compilation_run_preimage
  for select using (content.compiler_runtime_active());

grant select on content.compilation_run_preimage
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
revoke insert, update, delete, truncate on content.compilation_run_preimage
  from public, kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create function content.record_compilation_preimage(
  p_run_id uuid,
  p_canonical_preimage text,
  p_semantic_preimage text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_run content.compilation_run%rowtype;
  v_claim jsonb;
  v_semantic_graph jsonb;
  v_views jsonb;
  v_expected jsonb;
  v_existing content.compilation_run_preimage%rowtype;
begin
  perform pg_advisory_xact_lock(
    hashtextextended('kf-document-compilation-preimage:' || p_run_id::text, 0)
  );
  select * into v_run from content.compilation_run where id = p_run_id;
  if not found
     or core.current_action_id() is distinct from v_run.requested_by_action
     or core.current_actor() is distinct from v_run.recorded_by then
    raise exception 'compiler preimage context does not match recorded run authority'
      using errcode = 'insufficient_privilege';
  end if;
  if p_canonical_preimage is null
     or octet_length(p_canonical_preimage) > 67108864
     or (p_semantic_preimage is not null and octet_length(p_semantic_preimage) > 67108864) then
    raise exception 'compiler preimage is missing or exceeds 64 MiB safety limit'
      using errcode = 'program_limit_exceeded';
  end if;
  begin
    v_claim := p_canonical_preimage::jsonb;
    v_semantic_graph := case
      when p_semantic_preimage is null then null
      else p_semantic_preimage::jsonb
    end;
  exception when others then
    raise exception 'compiler preimage is not valid JSON'
      using errcode = 'invalid_parameter_value';
  end;
  if encode(public.digest(convert_to(p_canonical_preimage, 'UTF8'), 'sha256'), 'hex')
       is distinct from v_run.run_digest
     or not content.provenance_exact_keys(
       v_claim,
       array[
         'format', 'id', 'basisDigest', 'compilerDigest', 'dependencyDigest', 'status',
         'draftOnly', 'effectiveClassification', 'semanticGraph', 'semanticDigest',
         'hirProvenance', 'cirProvenance', 'unresolvedReferences', 'omittedSubgraphs',
         'projectionCapabilities', 'failureCode', 'failureMessage', 'diagnostics',
         'conversionLoss', 'views'
       ]
     ) then
    raise exception 'compiler run digest does not match complete receipt preimage'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_run.run_status = 'succeeded' then
    if p_semantic_preimage is null
       or encode(public.digest(convert_to(p_semantic_preimage, 'UTF8'), 'sha256'), 'hex')
            is distinct from v_run.semantic_digest
       or v_semantic_graph is distinct from v_claim -> 'semanticGraph' then
      raise exception 'compiler semantic graph does not match retained semantic preimage'
        using errcode = 'integrity_constraint_violation';
    end if;
  elsif p_semantic_preimage is not null
        or v_claim -> 'semanticGraph' is distinct from 'null'::jsonb then
    raise exception 'failed compiler run cannot retain semantic output'
      using errcode = 'integrity_constraint_violation';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'target', target,
               'mediaType', media_type,
               'contentDigest', content_digest,
               'effectiveClassification', effective_classification
             ) order by target
           ),
           '[]'::jsonb
         )
    into v_views from content.compiled_view where compilation_run_id = p_run_id;
  v_expected := jsonb_build_object(
    'format', 'kf-document-compilation-run-v2',
    'id', v_run.id::text,
    'basisDigest', (select basis_digest from content.compilation_basis where id = v_run.basis_id),
    'compilerDigest', v_run.compiler_digest,
    'dependencyDigest', v_run.dependency_digest,
    'status', v_run.run_status,
    'draftOnly', v_run.draft_only,
    'effectiveClassification', v_run.effective_classification,
    'semanticGraph', v_semantic_graph,
    'semanticDigest', v_run.semantic_digest,
    'hirProvenance', v_run.hir_provenance,
    'cirProvenance', v_run.cir_provenance,
    'unresolvedReferences', v_run.unresolved_references,
    'omittedSubgraphs', v_run.omitted_subgraphs,
    'projectionCapabilities', v_run.projection_capabilities,
    'failureCode', v_run.failure_code,
    'failureMessage', v_run.failure_message,
    'diagnostics', v_run.diagnostics,
    'conversionLoss', v_run.conversion_loss,
    'views', v_views
  );
  if v_claim is distinct from v_expected then
    raise exception 'compiler receipt preimage differs from authoritative run and view rows'
      using errcode = 'integrity_constraint_violation';
  end if;

  select * into v_existing from content.compilation_run_preimage where run_id = p_run_id;
  if found then
    if v_existing.semantic_graph is distinct from v_semantic_graph
       or v_existing.semantic_preimage is distinct from p_semantic_preimage
       or v_existing.canonical_preimage is distinct from p_canonical_preimage then
      raise exception 'idempotent compiler preimage replay differs from recorded receipt'
        using errcode = 'integrity_constraint_violation';
    end if;
    return;
  end if;
  insert into content.compilation_run_preimage
    (run_id, semantic_graph, semantic_preimage, canonical_preimage, recorded_by)
  values
    (p_run_id, v_semantic_graph, p_semantic_preimage, p_canonical_preimage, v_run.recorded_by);
end;
$$;

revoke all on function content.record_compilation_preimage(uuid, text, text) from public,
  kf_app, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
grant execute on function content.record_compilation_preimage(uuid, text, text) to kf_worker;

comment on table content.compilation_run_preimage is
  'Append-only canonical digest preimage; absence makes a legacy run ineligible for acceptance.';
comment on function content.record_compilation_preimage(uuid, text, text) is
  'Worker-only reconciliation of canonical run/semantic preimages with authoritative rows.';

-- migrate:down

drop function content.record_compilation_preimage(uuid, text, text);
drop table content.compilation_run_preimage;

drop trigger document_atom_parse_preimage_complete on content.document_atom;
drop trigger document_parse_preimage_complete on content.document_parse;
drop function content.assert_document_parse_preimage_complete();
drop trigger document_atom_guard_0_preimage on content.document_atom;
drop function content.verify_document_atom_preimage();
drop trigger document_parse_guard_0_preimage on content.document_parse;
drop function content.verify_document_parse_preimage();
drop function content.provenance_exact_keys(jsonb, text[]);

alter table content.document_atom drop column atom_preimage;
alter table content.document_parse
  drop constraint document_parse_source_digest,
  drop column projection_preimage,
  drop column loss_preimage,
  drop column loss_digest,
  drop column source_digest;
