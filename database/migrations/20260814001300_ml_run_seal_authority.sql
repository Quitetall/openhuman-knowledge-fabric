-- migrate:up

-- A run seal is an external Ed25519 claim over the exact TypeScript/JCS contract in
-- packages/ml-registry. The original table accepted any shape-correct signature from the
-- promoter role. There is no safe way to infer the signing authority for such historical
-- rows, so refuse an in-place upgrade instead of silently blessing them with a new key.
-- ml.run_seal already has FORCE RLS. The migration login is intentionally allowed to be a
-- non-BYPASSRLS owner, so take an exclusive lock and temporarily restore the normal owner
-- bypass before checking. These statements are in the migration transaction: a failure
-- rolls the FORCE setting back, and no concurrent session can observe the brief change.
lock table ml.run_seal in access exclusive mode;
alter table ml.run_seal no force row level security;
do $$
begin
  if exists (select 1 from ml.run_seal) then
    raise exception 'ML run-seal authority migration requires an empty ml.run_seal table'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'Export and independently verify existing seals before defining an explicit migration policy.';
  end if;
end
$$;
alter table ml.run_seal force row level security;

-- Public verification material is owner-controlled. Private keys remain with the exact BLUT
-- workload named here; neither private material nor a bearer secret has a database shape.
create table ml.run_seal_signing_key (
  id                         uuid primary key default uuidv7(),
  organization_id            uuid not null references org.organization (id) on delete restrict,
  workload_identity_ref      text not null
    check (workload_identity_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'),
  key_id                     text not null
    check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'),
  algorithm                  text not null check (algorithm = 'Ed25519'),
  public_key_spki_der_base64 text not null
    check (public_key_spki_der_base64 ~ '^[A-Za-z0-9+/]{59}=$'),
  public_key_sha256          text not null check (public_key_sha256 ~ '^[0-9a-f]{64}$'),
  rotates_key_registry_id    uuid,
  valid_from                 timestamptz not null,
  valid_until                timestamptz,
  registered_at              timestamptz not null,
  constraint run_seal_signing_key_window
    check (valid_until is null or valid_until > valid_from),
  constraint run_seal_signing_key_material_digest check (
    public_key_sha256 = encode(
      public.digest(decode(public_key_spki_der_base64, 'base64'), 'sha256'),
      'hex'
    )
  ),
  constraint run_seal_signing_key_ed25519_spki check (
    octet_length(decode(public_key_spki_der_base64, 'base64')) = 44
    and replace(
      encode(decode(public_key_spki_der_base64, 'base64'), 'base64'),
      E'\n',
      ''
    ) = public_key_spki_der_base64
    and encode(substring(decode(public_key_spki_der_base64, 'base64') from 1 for 12), 'hex')
      = '302a300506032b6570032100'
  ),
  unique (organization_id, key_id),
  unique (organization_id, public_key_sha256),
  unique (id, key_id),
  unique (id, organization_id, workload_identity_ref),
  constraint run_seal_signing_key_not_self_rotation
    check (rotates_key_registry_id is null or rotates_key_registry_id <> id),
  constraint run_seal_signing_key_rotation_same_workload
    foreign key (rotates_key_registry_id, organization_id, workload_identity_ref)
    references ml.run_seal_signing_key (id, organization_id, workload_identity_ref)
    on delete restrict
);

create table ml.run_seal_signing_key_revocation (
  signing_key_registry_id uuid primary key
    references ml.run_seal_signing_key (id) on delete restrict,
  reason_code             text not null check (reason_code in (
    'key_rotation', 'key_compromise', 'workload_retirement', 'administrative'
  )),
  revoked_at              timestamptz not null
);

create function ml.enforce_run_seal_signing_key_revocation() returns trigger
language plpgsql
set search_path = pg_catalog, ml
as $$
declare v_valid_from timestamptz;
begin
  -- Append and revoke share this exact lock. The key read happens after the wait so READ
  -- COMMITTED observes a revocation that won the race rather than an earlier snapshot.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'kf:ml:run-seal-signing-key:' || new.signing_key_registry_id::text,
      0
    )
  );
  select key.valid_from into strict v_valid_from
    from ml.run_seal_signing_key key
   where key.id = new.signing_key_registry_id;
  if new.revoked_at < v_valid_from then
    raise exception 'run-seal signing key revocation predates key validity'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger run_seal_signing_key_append_only
  before update or delete or truncate on ml.run_seal_signing_key
  for each statement execute function ml.refuse_mutation();
create trigger run_seal_signing_key_revocation_append_only
  before update or delete or truncate on ml.run_seal_signing_key_revocation
  for each statement execute function ml.refuse_mutation();
create trigger run_seal_signing_key_revocation_validate
  before insert on ml.run_seal_signing_key_revocation
  for each row execute function ml.enforce_run_seal_signing_key_revocation();

alter table ml.run_seal_signing_key enable row level security;
alter table ml.run_seal_signing_key force row level security;
alter table ml.run_seal_signing_key_revocation enable row level security;
alter table ml.run_seal_signing_key_revocation force row level security;

create policy run_seal_signing_key_preservation on ml.run_seal_signing_key
  for select to kf_auditor, kf_backup using (true);
create policy run_seal_signing_key_owner_read on ml.run_seal_signing_key
  for select to kf_migrator using (true);
create policy run_seal_signing_key_organization_read on ml.run_seal_signing_key
  for select to kf_app, kf_worker, kf_ml_promoter, kf_readonly using (
    organization_id = core.current_organization()
  );
create policy run_seal_signing_key_owner_insert on ml.run_seal_signing_key
  for insert to kf_migrator with check (true);

create policy run_seal_signing_key_revocation_preservation
  on ml.run_seal_signing_key_revocation
  for select to kf_auditor, kf_backup using (true);
create policy run_seal_signing_key_revocation_owner_read
  on ml.run_seal_signing_key_revocation
  for select to kf_migrator using (true);
create policy run_seal_signing_key_revocation_organization_read
  on ml.run_seal_signing_key_revocation
  for select to kf_app, kf_worker, kf_ml_promoter, kf_readonly using (
    exists (
      select 1 from ml.run_seal_signing_key key
       where key.id = signing_key_registry_id
         and key.organization_id = core.current_organization()
    )
  );
create policy run_seal_signing_key_revocation_owner_insert
  on ml.run_seal_signing_key_revocation
  for insert to kf_migrator with check (true);

revoke all on ml.run_seal_signing_key, ml.run_seal_signing_key_revocation
  from public, kf_app, kf_worker, kf_ml_promoter, kf_readonly;
grant select on ml.run_seal_signing_key, ml.run_seal_signing_key_revocation
  to kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;
grant select, insert on ml.run_seal_signing_key, ml.run_seal_signing_key_revocation
  to kf_migrator;

alter table ml.run_seal
  add column signing_key_registry_id uuid not null;
alter table ml.run_seal
  add constraint run_seal_registered_signing_key
  foreign key (signing_key_registry_id, signing_key_id)
  references ml.run_seal_signing_key (id, key_id) on delete restrict;

-- Resolve one exact organization/workload/key tuple, linearize against its revocation, then
-- reread validity and revocation state. Ordinary expiry blocks a new append both at the seal's
-- effective time and at verification time; explicit revocation blocks it immediately.
create function ml.active_run_seal_signing_public_key(
  p_organization_id uuid,
  p_workload_identity_ref text,
  p_signing_key_id text,
  p_effective_at timestamptz
) returns table (
  signing_key_registry_id uuid,
  public_key_spki_der bytea
)
language plpgsql
security definer
set search_path = pg_catalog, ml
as $$
declare
  v_key_registry_id uuid;
  v_public_key_spki_der bytea;
begin
  select key.id into v_key_registry_id
    from ml.run_seal_signing_key key
   where key.organization_id = p_organization_id
     and key.workload_identity_ref = p_workload_identity_ref
     and key.key_id = p_signing_key_id;
  if not found then
    raise exception 'run seal requires an active owner-registered key for the exact workload'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('kf:ml:run-seal-signing-key:' || v_key_registry_id::text, 0)
  );
  select decode(key.public_key_spki_der_base64, 'base64')
    into v_public_key_spki_der
    from ml.run_seal_signing_key key
   where key.id = v_key_registry_id
     and key.organization_id = p_organization_id
     and key.workload_identity_ref = p_workload_identity_ref
     and key.key_id = p_signing_key_id
     and key.algorithm = 'Ed25519'
     and key.valid_from <= p_effective_at
     and (key.valid_until is null or key.valid_until > p_effective_at)
     and key.valid_from <= clock_timestamp()
     and (key.valid_until is null or key.valid_until > clock_timestamp())
     and not exists (
       select 1 from ml.run_seal_signing_key_revocation revoked
        where revoked.signing_key_registry_id = key.id
     );
  if not found then
    raise exception 'run seal requires an active owner-registered key for the exact workload'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  return query select v_key_registry_id, v_public_key_spki_der;
end
$$;

create function ml.verify_run_seal_signature(
  p_public_key_spki_der bytea,
  p_unsigned_record text,
  p_signature text
) returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, ml
as $$
declare v_signature bytea;
begin
  if octet_length(p_public_key_spki_der) <> 44
     or encode(substring(p_public_key_spki_der from 1 for 12), 'hex')
       <> '302a300506032b6570032100'
     or p_signature !~ '^[A-Za-z0-9+/]{86}==$' then
    return false;
  end if;
  v_signature := decode(p_signature, 'base64');
  return octet_length(v_signature) = 64
     and replace(encode(v_signature, 'base64'), E'\n', '') = p_signature
     and ml.verify_ed25519(
       substring(p_public_key_spki_der from 13 for 32),
       convert_to(p_unsigned_record, 'UTF8'),
       v_signature
     );
exception
  when others then
    return false;
end
$$;

-- The only promoter-facing seal append. It reconstructs the unchanged TypeScript
-- kf.ml.run-lineage.v1, kf.ml.metric-segment.v1 and unsigned kf.ml.run-seal.v1 JCS bytes.
create function ml.append_signed_run_seal(
  p_organization_id uuid,
  p_run_lineage_id uuid,
  p_workload_identity_ref text,
  p_sealed_at timestamptz,
  p_signing_key_id text,
  p_seal_sha256 text,
  p_signature text
) returns table (
  id uuid,
  seal_sha256 text,
  signing_key_registry_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, ml
as $$
declare
  v_lineage ml.run_lineage%rowtype;
  v_run_ref ml.aggregate_reference%rowtype;
  v_code_ref ml.aggregate_reference%rowtype;
  v_recipe_ref ml.aggregate_reference%rowtype;
  v_environment_ref ml.aggregate_reference%rowtype;
  v_policy_ref ml.aggregate_reference%rowtype;
  v_run_json text;
  v_code_json text;
  v_recipe_json text;
  v_environment_json text;
  v_policy_json text;
  v_inputs_json text;
  v_outputs_json text;
  v_parent_models_json text;
  v_lineage_json text;
  v_recomputed_lineage_sha256 text;
  v_input_count bigint;
  v_output_count bigint;
  v_parent_model_count bigint;
  v_input_min integer;
  v_input_max integer;
  v_output_min integer;
  v_output_max integer;
  v_parent_model_min integer;
  v_parent_model_max integer;
  v_inputs_valid boolean;
  v_outputs_valid boolean;
  v_parent_models_valid boolean;
  v_segment record;
  v_segment_json text;
  v_recomputed_segment_sha256 text;
  v_segment_manifest text[] := '{}'::text[];
  v_segment_manifest_json text := '[';
  v_segment_count bigint := 0;
  v_expected_ordinal integer := 1;
  v_expected_sequence bigint := 1;
  v_event_count bigint := 0;
  v_stored_event_count bigint;
  v_first_event_sequence bigint;
  v_last_event_sequence bigint;
  v_segment_manifest_sha256 text;
  v_sealed_at text;
  v_unsigned_seal text;
  v_recomputed_seal_sha256 text;
  v_signing_key_registry_id uuid;
  v_public_key_spki_der bytea;
  v_seal ml.run_seal%rowtype;
begin
  -- PostgreSQL takes a fresh statement snapshot after the advisory-lock wait only at READ
  -- COMMITTED. A REPEATABLE READ/SERIALIZABLE caller could otherwise retain a pre-revocation
  -- snapshot and admit a seal after the revocation transaction commits.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'run-seal append requires READ COMMITTED for a fresh post-lock authority read'
      using errcode = 'feature_not_supported';
  end if;
  if core.current_organization() is distinct from p_organization_id then
    raise exception 'run seal organization is outside current access context'
      using errcode = 'insufficient_privilege';
  end if;
  if p_workload_identity_ref is null
     or p_workload_identity_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'
     or p_signing_key_id is null
     or p_signing_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'
     or p_seal_sha256 is null
     or p_seal_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'run seal contains an unsafe workload, key, or digest'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_sealed_at is null
     or not isfinite(p_sealed_at)
     or p_sealed_at < timestamptz '0001-01-01 00:00:00+00'
     or p_sealed_at >= timestamptz '10000-01-01 00:00:00+00'
     or p_sealed_at is distinct from date_trunc('milliseconds', p_sealed_at) then
    raise exception 'run seal timestamp must be a finite four-digit-year canonical millisecond instant'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Lineage members, metric events and metric segments all take this same row lock before an
  -- append. Once acquired, the complete basis rebuilt below cannot change underneath us.
  select lineage.* into strict v_lineage
    from ml.run_lineage lineage
   where lineage.id = p_run_lineage_id
   for update;
  select reference.* into strict v_run_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.run_ref_id;
  select reference.* into strict v_code_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.code_ref_id;
  select reference.* into strict v_recipe_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.recipe_ref_id;
  select reference.* into strict v_environment_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.environment_ref_id;
  select reference.* into strict v_policy_ref
    from ml.aggregate_reference reference where reference.id = v_lineage.metric_policy_ref_id;

  if v_run_ref.organization_id is distinct from p_organization_id
     or v_code_ref.organization_id is distinct from p_organization_id
     or v_recipe_ref.organization_id is distinct from p_organization_id
     or v_environment_ref.organization_id is distinct from p_organization_id
     or v_policy_ref.organization_id is distinct from p_organization_id
     or v_run_ref.aggregate_kind <> 'run'
     or v_code_ref.aggregate_kind <> 'code'
     or v_recipe_ref.aggregate_kind <> 'recipe'
     or v_environment_ref.aggregate_kind <> 'environment'
     or v_policy_ref.aggregate_kind <> 'metric_policy' then
    raise exception 'run seal lineage contains a cross-organization or incorrectly typed reference'
      using errcode = 'check_violation';
  end if;

  select count(*), min(member.ordinal), max(member.ordinal),
         coalesce(
           '[' || string_agg(ml.canonical_aggregate_reference(member.aggregate_ref_id), ','
                             order by member.ordinal) || ']',
           '[]'
         ),
         bool_and(reference.organization_id = p_organization_id
                  and reference.aggregate_kind = 'input')
    into v_input_count, v_input_min, v_input_max, v_inputs_json, v_inputs_valid
    from ml.run_lineage_input member
    join ml.aggregate_reference reference on reference.id = member.aggregate_ref_id
   where member.run_lineage_id = p_run_lineage_id;
  select count(*), min(member.ordinal), max(member.ordinal),
         coalesce(
           '[' || string_agg(ml.canonical_aggregate_reference(member.aggregate_ref_id), ','
                             order by member.ordinal) || ']',
           '[]'
         ),
         bool_and(reference.organization_id = p_organization_id
                  and reference.aggregate_kind in ('output', 'candidate'))
    into v_output_count, v_output_min, v_output_max, v_outputs_json, v_outputs_valid
    from ml.run_lineage_output member
    join ml.aggregate_reference reference on reference.id = member.aggregate_ref_id
   where member.run_lineage_id = p_run_lineage_id;
  select count(*), min(member.ordinal), max(member.ordinal),
         coalesce(
           '[' || string_agg(ml.canonical_aggregate_reference(member.aggregate_ref_id), ','
                             order by member.ordinal) || ']',
           '[]'
         ),
         bool_and(reference.organization_id = p_organization_id
                  and reference.aggregate_kind = 'parent_model')
    into v_parent_model_count, v_parent_model_min, v_parent_model_max,
         v_parent_models_json, v_parent_models_valid
    from ml.run_lineage_parent_model member
    join ml.aggregate_reference reference on reference.id = member.aggregate_ref_id
   where member.run_lineage_id = p_run_lineage_id;

  if v_input_count = 0 or v_input_min <> 1 or v_input_max::bigint <> v_input_count
     or v_inputs_valid is not true
     or v_output_count = 0 or v_output_min <> 1 or v_output_max::bigint <> v_output_count
     or v_outputs_valid is not true
     or (
       v_parent_model_count > 0
       and (
         v_parent_model_min <> 1
         or v_parent_model_max::bigint <> v_parent_model_count
         or v_parent_models_valid is not true
       )
     ) then
    raise exception 'run seal requires complete, contiguous, correctly typed lineage members'
      using errcode = 'check_violation';
  end if;

  v_run_json := ml.canonical_aggregate_reference(v_run_ref.id);
  v_code_json := ml.canonical_aggregate_reference(v_code_ref.id);
  v_recipe_json := ml.canonical_aggregate_reference(v_recipe_ref.id);
  v_environment_json := ml.canonical_aggregate_reference(v_environment_ref.id);
  v_policy_json := ml.canonical_aggregate_reference(v_policy_ref.id);
  v_lineage_json := '{'
    || '"code":' || v_code_json
    || ',"environment":' || v_environment_json
    || ',"inputs":' || v_inputs_json
    || ',"metricPolicy":' || v_policy_json
    || ',"outputs":' || v_outputs_json
    || ',"parentModels":' || v_parent_models_json
    || ',"recipe":' || v_recipe_json
    || ',"run":' || v_run_json
    || ',"schemaVersion":"kf.ml.run-lineage.v1"'
    || '}';
  v_recomputed_lineage_sha256 := encode(
    public.digest(convert_to(v_lineage_json, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_recomputed_lineage_sha256 is distinct from v_lineage.lineage_sha256 then
    raise exception 'stored run-lineage digest does not match canonical stored members'
      using errcode = 'integrity_constraint_violation';
  end if;

  for v_segment in
    select segment.ordinal,
           segment.first_sequence,
           segment.last_sequence,
           segment.event_count,
           segment.metadata_sha256,
           reference.organization_id as segment_organization_id,
           reference.aggregate_kind as segment_kind,
           ml.canonical_aggregate_reference(reference.id) as segment_json
      from ml.metric_segment segment
      join ml.aggregate_reference reference on reference.id = segment.segment_ref_id
     where segment.run_lineage_id = p_run_lineage_id
     order by segment.ordinal
  loop
    if v_segment.ordinal <> v_expected_ordinal
       or v_segment.first_sequence <> v_expected_sequence
       or v_segment.last_sequence < v_segment.first_sequence
       or v_segment.event_count <> v_segment.last_sequence - v_segment.first_sequence + 1
       or v_segment.segment_organization_id is distinct from p_organization_id
       or v_segment.segment_kind <> 'segment'
       or v_segment.ordinal > 9007199254740991
       or v_segment.first_sequence > 9007199254740991
       or v_segment.last_sequence > 9007199254740991
       or v_segment.event_count > 9007199254740991 then
      raise exception 'run seal metric segments are not exact TypeScript-safe contiguous records'
        using errcode = 'check_violation';
    end if;

    v_segment_json := '{'
      || '"eventCount":' || v_segment.event_count::text
      || ',"firstSequence":' || v_segment.first_sequence::text
      || ',"lastSequence":' || v_segment.last_sequence::text
      || ',"ordinal":' || v_segment.ordinal::text
      || ',"run":' || v_run_json
      || ',"schemaVersion":"kf.ml.metric-segment.v1"'
      || ',"segment":' || v_segment.segment_json
      || '}';
    v_recomputed_segment_sha256 := encode(
      public.digest(convert_to(v_segment_json, 'UTF8'), 'sha256'),
      'hex'
    );
    if v_recomputed_segment_sha256 is distinct from v_segment.metadata_sha256 then
      raise exception 'stored metric-segment digest does not match canonical stored fields'
        using errcode = 'integrity_constraint_violation';
    end if;

    if v_segment_count > 0 then
      v_segment_manifest_json := v_segment_manifest_json || ',';
    end if;
    v_segment_manifest_json :=
      v_segment_manifest_json || to_jsonb(v_segment.metadata_sha256)::text;
    v_segment_manifest := array_append(v_segment_manifest, v_segment.metadata_sha256);
    v_segment_count := v_segment_count + 1;
    v_event_count := v_event_count + v_segment.event_count;
    if v_event_count > 9007199254740991 then
      raise exception 'run seal event count exceeds the TypeScript safe-integer contract'
        using errcode = 'numeric_value_out_of_range';
    end if;
    v_expected_ordinal := v_expected_ordinal + 1;
    v_expected_sequence := v_segment.last_sequence + 1;
  end loop;
  v_segment_manifest_json := v_segment_manifest_json || ']';
  if v_segment_count = 0 then
    raise exception 'run seal requires at least one metric segment'
      using errcode = 'check_violation';
  end if;

  select count(*), min(event.sequence_no), max(event.sequence_no)
    into v_stored_event_count, v_first_event_sequence, v_last_event_sequence
    from ml.metric_event event
   where event.run_lineage_id = p_run_lineage_id;
  if v_stored_event_count <> v_event_count
     or v_first_event_sequence <> 1
     or v_last_event_sequence <> v_event_count then
    raise exception 'run seal metric segments do not exactly cover stored metric events without gaps'
      using errcode = 'check_violation';
  end if;

  v_segment_manifest_sha256 := encode(
    public.digest(convert_to(v_segment_manifest_json, 'UTF8'), 'sha256'),
    'hex'
  );
  v_sealed_at := to_char(
    p_sealed_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_unsigned_seal := '{'
    || '"eventCount":' || v_event_count::text
    || ',"lineageDigest":' || to_jsonb(v_recomputed_lineage_sha256)::text
    || ',"run":' || v_run_json
    || ',"schemaVersion":"kf.ml.run-seal.v1"'
    || ',"sealedAt":' || to_jsonb(v_sealed_at)::text
    || ',"segmentDigests":' || v_segment_manifest_json
    || ',"signingKeyId":' || to_jsonb(p_signing_key_id)::text
    || '}';
  v_recomputed_seal_sha256 := encode(
    public.digest(convert_to(v_unsigned_seal, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_recomputed_seal_sha256 is distinct from p_seal_sha256 then
    raise exception 'run seal digest does not match canonical stored lineage and segments'
      using errcode = 'integrity_constraint_violation';
  end if;

  select active.signing_key_registry_id, active.public_key_spki_der
    into strict v_signing_key_registry_id, v_public_key_spki_der
    from ml.active_run_seal_signing_public_key(
      p_organization_id,
      p_workload_identity_ref,
      p_signing_key_id,
      p_sealed_at
    ) active;
  if ml.verify_run_seal_signature(
    v_public_key_spki_der,
    v_unsigned_seal,
    p_signature
  ) is not true then
    raise exception 'run seal Ed25519 signature verification failed'
      using errcode = 'integrity_constraint_violation';
  end if;

  insert into ml.run_seal (
    run_lineage_id, lineage_sha256, segment_manifest, segment_manifest_sha256,
    event_count, sealed_at, signing_key_id, signing_key_registry_id, seal_sha256, signature
  ) values (
    p_run_lineage_id, v_recomputed_lineage_sha256, v_segment_manifest,
    v_segment_manifest_sha256, v_event_count, p_sealed_at, p_signing_key_id,
    v_signing_key_registry_id, p_seal_sha256, p_signature
  ) returning ml.run_seal.* into v_seal;

  return query select v_seal.id, v_seal.seal_sha256, v_seal.signing_key_registry_id;
end
$$;

revoke execute on function ml.enforce_run_seal_signing_key_revocation() from public;
revoke execute on function ml.active_run_seal_signing_public_key(uuid, text, text, timestamptz)
  from public;
revoke execute on function ml.verify_run_seal_signature(bytea, text, text) from public;
revoke execute on function ml.append_signed_run_seal(
  uuid, uuid, text, timestamptz, text, text, text
) from public, kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant execute on function ml.append_signed_run_seal(
  uuid, uuid, text, timestamptz, text, text, text
) to kf_ml_promoter;

-- Raw insertion is not an authority boundary. The promoter can append only through the
-- SECURITY DEFINER function above, after exact reconstruction and signature verification.
revoke insert on ml.run_seal
  from public, kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;

comment on table ml.run_seal_signing_key is
  'Owner-controlled Ed25519 public-key registry binding each run-seal key to one organization and BLUT workload identity.';
comment on table ml.run_seal_signing_key_revocation is
  'Append-only withdrawal of a registered run-seal signing key, serialized against seal append.';
comment on column ml.run_seal.signing_key_registry_id is
  'Exact owner-registered public key whose Ed25519 signature was verified before append.';
comment on function ml.append_signed_run_seal(
  uuid, uuid, text, timestamptz, text, text, text
) is
  'Only promoter run-seal append seam. Rebuilds exact TypeScript JCS lineage, segment and seal bytes, verifies stored digests and event coverage, and verifies Ed25519.';
comment on role kf_ml_promoter is
  'Offline KF ML controller. Writes metric authorizations; appends run seals and governed promotion records only through database-verified authority functions.';

-- migrate:down

comment on role kf_ml_promoter is
  'Offline KF ML controller. Writes metric authorizations and run seals; appends governed promotion receipts and revocations only through database-verified authority functions.';
grant insert on ml.run_seal to kf_ml_promoter;
drop function if exists ml.append_signed_run_seal(
  uuid, uuid, text, timestamptz, text, text, text
);
drop function if exists ml.verify_run_seal_signature(bytea, text, text);
drop function if exists ml.active_run_seal_signing_public_key(uuid, text, text, timestamptz);
alter table ml.run_seal drop constraint if exists run_seal_registered_signing_key;
alter table ml.run_seal drop column if exists signing_key_registry_id;
drop table if exists ml.run_seal_signing_key_revocation;
drop table if exists ml.run_seal_signing_key;
drop function if exists ml.enforce_run_seal_signing_key_revocation();
