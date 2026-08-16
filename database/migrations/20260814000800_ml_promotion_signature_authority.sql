-- migrate:up

-- ML promotion signatures are verified inside PostgreSQL. Promotion is a low-frequency
-- governance operation, so this deliberately favors a small auditable PL/pgSQL Ed25519
-- implementation over adding a host crypto daemon or a database extension whose presence
-- would make restore and fresh-install behavior environment-dependent.

create function ml.ed25519_pow_mod(
  p_base numeric,
  p_exponent numeric,
  p_modulus numeric
) returns numeric
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  v_result numeric := 1;
  v_base numeric := mod(mod(p_base, p_modulus) + p_modulus, p_modulus);
  v_exponent numeric := trunc(p_exponent);
begin
  if p_modulus <= 0 or v_exponent < 0 then
    raise exception 'invalid modular exponentiation input'
      using errcode = 'invalid_parameter_value';
  end if;
  while v_exponent > 0 loop
    if mod(v_exponent, 2) = 1 then
      v_result := mod(v_result * v_base, p_modulus);
    end if;
    v_base := mod(v_base * v_base, p_modulus);
    v_exponent := div(v_exponent, 2);
  end loop;
  return v_result;
end
$$;

create function ml.ed25519_le_to_numeric(p_bytes bytea) returns numeric
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  v_value numeric := 0;
  v_factor numeric := 1;
  v_index integer;
begin
  if octet_length(p_bytes) = 0 then
    return 0;
  end if;
  for v_index in 0..octet_length(p_bytes) - 1 loop
    v_value := v_value + get_byte(p_bytes, v_index) * v_factor;
    v_factor := v_factor * 256;
  end loop;
  return v_value;
end
$$;

-- Extended Edwards coordinates [X,Y,Z,T], with x=X/Z, y=Y/Z and XY=ZT.
create function ml.ed25519_point_add(p_left numeric[], p_right numeric[]) returns numeric[]
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  v_p constant numeric :=
    57896044618658097711785492504343953926634992332820282019728792003956564819949;
  v_d constant numeric :=
    37095705934669439343138083508754565189542113879843219016388785533085940283555;
  v_a numeric;
  v_b numeric;
  v_c numeric;
  v_doubled_z numeric;
  v_e numeric;
  v_f numeric;
  v_g numeric;
  v_h numeric;
begin
  if cardinality(p_left) <> 4 or cardinality(p_right) <> 4 then
    raise exception 'Ed25519 point must have four extended coordinates'
      using errcode = 'invalid_parameter_value';
  end if;
  v_a := mod((p_left[2] - p_left[1]) * (p_right[2] - p_right[1]), v_p);
  v_b := mod((p_left[2] + p_left[1]) * (p_right[2] + p_right[1]), v_p);
  v_c := mod(2 * v_d * p_left[4] * p_right[4], v_p);
  v_doubled_z := mod(2 * p_left[3] * p_right[3], v_p);
  v_e := mod(v_b - v_a + v_p, v_p);
  v_f := mod(v_doubled_z - v_c + v_p, v_p);
  v_g := mod(v_doubled_z + v_c, v_p);
  v_h := mod(v_b + v_a, v_p);
  return array[
    mod(v_e * v_f, v_p),
    mod(v_g * v_h, v_p),
    mod(v_f * v_g, v_p),
    mod(v_e * v_h, v_p)
  ];
end
$$;

create function ml.ed25519_point_multiply(p_scalar numeric, p_point numeric[])
returns numeric[]
language plpgsql
immutable
strict
set search_path = pg_catalog, ml
as $$
declare
  v_scalar numeric := trunc(p_scalar);
  v_result numeric[] := array[0::numeric, 1::numeric, 1::numeric, 0::numeric];
  v_addend numeric[] := p_point;
begin
  if v_scalar < 0 or cardinality(p_point) <> 4 then
    raise exception 'invalid Ed25519 scalar multiplication input'
      using errcode = 'invalid_parameter_value';
  end if;
  while v_scalar > 0 loop
    if mod(v_scalar, 2) = 1 then
      v_result := ml.ed25519_point_add(v_result, v_addend);
    end if;
    v_addend := ml.ed25519_point_add(v_addend, v_addend);
    v_scalar := div(v_scalar, 2);
  end loop;
  return v_result;
end
$$;

create function ml.ed25519_decode_point(p_encoded bytea) returns numeric[]
language plpgsql
immutable
strict
set search_path = pg_catalog, ml
as $$
declare
  v_p constant numeric :=
    57896044618658097711785492504343953926634992332820282019728792003956564819949;
  v_d constant numeric :=
    37095705934669439343138083508754565189542113879843219016388785533085940283555;
  v_sqrt_minus_one constant numeric :=
    19681161376707505956807079304988542015446066515923890162744021073123829784752;
  v_encoded_number numeric;
  v_sign numeric;
  v_y numeric;
  v_y_squared numeric;
  v_x_squared numeric;
  v_x numeric;
begin
  if octet_length(p_encoded) <> 32 then
    return null;
  end if;
  v_encoded_number := ml.ed25519_le_to_numeric(p_encoded);
  v_sign := trunc(v_encoded_number /
    57896044618658097711785492504343953926634992332820282019728792003956564819968);
  v_y := mod(v_encoded_number,
    57896044618658097711785492504343953926634992332820282019728792003956564819968);
  if v_sign not in (0, 1) or v_y >= v_p then
    return null;
  end if;

  v_y_squared := mod(v_y * v_y, v_p);
  v_x_squared := mod(
    mod(v_y_squared - 1 + v_p, v_p)
      * ml.ed25519_pow_mod(mod(v_d * v_y_squared + 1, v_p), v_p - 2, v_p),
    v_p
  );
  v_x := ml.ed25519_pow_mod(v_x_squared, (v_p + 3) / 8, v_p);
  if mod(v_x * v_x, v_p) <> v_x_squared then
    v_x := mod(v_x * v_sqrt_minus_one, v_p);
  end if;
  if mod(v_x * v_x, v_p) <> v_x_squared then
    return null;
  end if;
  if mod(v_x, 2) <> v_sign then
    v_x := v_p - v_x;
  end if;
  -- RFC 8032 requires the unused sign bit to be zero when x is zero.
  if v_x = 0 and v_sign = 1 then
    return null;
  end if;
  return array[v_x, v_y, 1::numeric, mod(v_x * v_y, v_p)];
end
$$;

create function ml.ed25519_points_equal(p_left numeric[], p_right numeric[]) returns boolean
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select cardinality(p_left) = 4
     and cardinality(p_right) = 4
     and mod(
           p_left[1] * p_right[3] - p_right[1] * p_left[3],
           57896044618658097711785492504343953926634992332820282019728792003956564819949
         ) = 0
     and mod(
           p_left[2] * p_right[3] - p_right[2] * p_left[3],
           57896044618658097711785492504343953926634992332820282019728792003956564819949
         ) = 0
$$;

create function ml.verify_ed25519(
  p_public_key_raw bytea,
  p_message bytea,
  p_signature bytea
) returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog, ml, public
as $$
declare
  v_l constant numeric :=
    7237005577332262213973186563042994240857116359379907606001950938285454250989;
  v_base constant numeric[] := array[
    15112221349535400772501151409588531511454012693041857206046113283949847762202::numeric,
    46316835694926478169428394003475163141307993866256225615783033603165251855960::numeric,
    1::numeric,
    46827403850823179245072216630277197565144205554125654976674165829533817101731::numeric
  ];
  v_identity constant numeric[] := array[0::numeric, 1::numeric, 1::numeric, 0::numeric];
  v_r_encoded bytea;
  v_s numeric;
  v_challenge numeric;
  v_public_point numeric[];
  v_r_point numeric[];
  v_left numeric[];
  v_right numeric[];
begin
  if octet_length(p_public_key_raw) <> 32 or octet_length(p_signature) <> 64 then
    return false;
  end if;
  v_r_encoded := substring(p_signature from 1 for 32);
  v_s := ml.ed25519_le_to_numeric(substring(p_signature from 33 for 32));
  if v_s >= v_l then
    return false;
  end if;
  v_public_point := ml.ed25519_decode_point(p_public_key_raw);
  v_r_point := ml.ed25519_decode_point(v_r_encoded);
  if v_public_point is null or v_r_point is null then
    return false;
  end if;
  -- Decoding alone admits torsion points. Require both encoded points to be non-identity
  -- members of the prime-order subgroup before evaluating the uncofactored RFC 8032 equation.
  -- This rejects identity/small-order forgeries instead of inheriting permissive ZIP-215-style
  -- verification behavior.
  if ml.ed25519_points_equal(v_public_point, v_identity)
     or ml.ed25519_points_equal(v_r_point, v_identity)
     or not ml.ed25519_points_equal(
       ml.ed25519_point_multiply(v_l, v_public_point),
       v_identity
     )
     or not ml.ed25519_points_equal(
       ml.ed25519_point_multiply(v_l, v_r_point),
       v_identity
     ) then
    return false;
  end if;
  v_challenge := mod(
    ml.ed25519_le_to_numeric(public.digest(v_r_encoded || p_public_key_raw || p_message, 'sha512')),
    v_l
  );
  v_left := ml.ed25519_point_multiply(v_s, v_base);
  v_right := ml.ed25519_point_add(
    v_r_point,
    ml.ed25519_point_multiply(v_challenge, v_public_point)
  );
  return ml.ed25519_points_equal(v_left, v_right);
exception
  when others then
    return false;
end
$$;

revoke execute on function ml.ed25519_pow_mod(numeric, numeric, numeric) from public;
revoke execute on function ml.ed25519_le_to_numeric(bytea) from public;
revoke execute on function ml.ed25519_point_add(numeric[], numeric[]) from public;
revoke execute on function ml.ed25519_point_multiply(numeric, numeric[]) from public;
revoke execute on function ml.ed25519_decode_point(bytea) from public;
revoke execute on function ml.ed25519_points_equal(numeric[], numeric[]) from public;
revoke execute on function ml.verify_ed25519(bytea, bytea, bytea) from public;

-- Only database ownership/migration authority registers promotion verification keys. Private
-- material has no representation here. Rotation preserves old verification material; a
-- revocation blocks every later append attempt without rewriting historical receipts.
create table ml.promotion_signing_key (
  id                         uuid primary key default uuidv7(),
  organization_id            uuid not null references org.organization (id) on delete restrict,
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
  constraint promotion_signing_key_window
    check (valid_until is null or valid_until > valid_from),
  constraint promotion_signing_key_material_digest check (
    public_key_sha256 = encode(
      public.digest(decode(public_key_spki_der_base64, 'base64'), 'sha256'),
      'hex'
    )
  ),
  constraint promotion_signing_key_ed25519_spki check (
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
  unique (id, organization_id),
  constraint promotion_signing_key_not_self_rotation
    check (rotates_key_registry_id is null or rotates_key_registry_id <> id),
  constraint promotion_signing_key_rotation_same_organization
    foreign key (rotates_key_registry_id, organization_id)
    references ml.promotion_signing_key (id, organization_id) on delete restrict
);

create table ml.promotion_signing_key_revocation (
  signing_key_registry_id uuid primary key
    references ml.promotion_signing_key (id) on delete restrict,
  reason_code             text not null check (reason_code in (
    'key_rotation', 'key_compromise', 'authority_retirement', 'administrative'
  )),
  revoked_at              timestamptz not null
);

create function ml.enforce_promotion_signing_key_revocation() returns trigger
language plpgsql
set search_path = pg_catalog, ml
as $$
declare v_valid_from timestamptz;
begin
  -- Serialize withdrawal against receipt/revocation verification for this exact key. The
  -- verifier takes the same transaction lock before its fresh revocation-state read.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'kf:ml:promotion-signing-key:' || new.signing_key_registry_id::text,
      0
    )
  );
  select valid_from into strict v_valid_from
    from ml.promotion_signing_key where id = new.signing_key_registry_id;
  if new.revoked_at < v_valid_from then
    raise exception 'promotion signing key revocation predates key validity'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger promotion_signing_key_append_only
  before update or delete or truncate on ml.promotion_signing_key
  for each statement execute function ml.refuse_mutation();
create trigger promotion_signing_key_revocation_append_only
  before update or delete or truncate on ml.promotion_signing_key_revocation
  for each statement execute function ml.refuse_mutation();
create trigger promotion_signing_key_revocation_validate
  before insert on ml.promotion_signing_key_revocation
  for each row execute function ml.enforce_promotion_signing_key_revocation();

alter table ml.promotion_signing_key enable row level security;
alter table ml.promotion_signing_key force row level security;
alter table ml.promotion_signing_key_revocation enable row level security;
alter table ml.promotion_signing_key_revocation force row level security;
create policy promotion_signing_key_preservation on ml.promotion_signing_key
  for select to kf_auditor, kf_backup using (true);
create policy promotion_signing_key_organization_read on ml.promotion_signing_key
  for select to kf_app, kf_worker, kf_ml_promoter, kf_readonly using (
    organization_id = core.current_organization()
  );
create policy promotion_signing_key_owner_insert on ml.promotion_signing_key
  for insert to kf_migrator with check (true);
create policy promotion_signing_key_revocation_preservation
  on ml.promotion_signing_key_revocation
  for select to kf_auditor, kf_backup using (true);
create policy promotion_signing_key_revocation_organization_read
  on ml.promotion_signing_key_revocation
  for select to kf_app, kf_worker, kf_ml_promoter, kf_readonly using (
    exists (
      select 1 from ml.promotion_signing_key key
       where key.id = signing_key_registry_id
         and key.organization_id = core.current_organization()
    )
  );
create policy promotion_signing_key_revocation_owner_insert
  on ml.promotion_signing_key_revocation
  for insert to kf_migrator with check (true);

revoke all on ml.promotion_signing_key, ml.promotion_signing_key_revocation
  from public, kf_app, kf_worker, kf_ml_promoter, kf_readonly;
grant select on ml.promotion_signing_key, ml.promotion_signing_key_revocation
  to kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;
grant select, insert on ml.promotion_signing_key, ml.promotion_signing_key_revocation
  to kf_migrator;

create view ml.promotion_verification_key
with (security_barrier = true, security_invoker = true) as
select key.organization_id,
       key.id as key_registry_id,
       key.key_id,
       key.algorithm,
       key.public_key_spki_der_base64,
       key.public_key_sha256,
       key.rotates_key_registry_id,
       key.valid_from,
       key.valid_until,
       key.registered_at,
       revocation.reason_code as revocation_reason_code,
       revocation.revoked_at
  from ml.promotion_signing_key key
  left join ml.promotion_signing_key_revocation revocation
    on revocation.signing_key_registry_id = key.id;

grant select on ml.promotion_verification_key
  to kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;

-- Rank receipts before applying authority state. If the latest receipt loses authority,
-- an older receipt must not silently become current. Key expiry is prospective: a receipt
-- remains valid after ordinary expiry when the key was valid at promoted_at; explicit key
-- revocation is the append-only event that withdraws already-issued receipts.
create or replace view ml.governed_alias
with (security_barrier = true, security_invoker = true) as
with latest as (
  select distinct on (organization_id, alias_id)
    id, organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
    evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
    quality_authority_decision_ref_id, promoted_at, signing_key_id, receipt_sha256, signature
    from ml.promotion_receipt
   order by organization_id, alias_id, promoted_at desc, receipt_sha256 desc
)
select latest.organization_id, latest.alias_id, latest.candidate_ref_id,
       latest.run_seal_id, latest.policy_ref_id, latest.evidence_manifest_sha256,
       latest.risk_tier, latest.technical_authority_decision_ref_id,
       latest.quality_authority_decision_ref_id, latest.promoted_at,
       latest.signing_key_id, latest.receipt_sha256, latest.signature
  from latest
  join ml.promotion_signing_key signing_key
    on signing_key.organization_id = latest.organization_id
   and signing_key.key_id = latest.signing_key_id
   and signing_key.algorithm = 'Ed25519'
   and signing_key.valid_from <= latest.promoted_at
   and (signing_key.valid_until is null or signing_key.valid_until > latest.promoted_at)
  left join ml.promotion_revocation receipt_revocation
    on receipt_revocation.receipt_id = latest.id
  left join ml.promotion_signing_key_revocation key_revocation
    on key_revocation.signing_key_registry_id = signing_key.id
 where receipt_revocation.id is null
   and key_revocation.signing_key_registry_id is null;

create function ml.canonical_aggregate_reference(p_reference_id uuid) returns text
language plpgsql
stable
strict
set search_path = pg_catalog, ml
as $$
declare v_reference ml.aggregate_reference%rowtype;
begin
  select reference.* into strict v_reference
    from ml.aggregate_reference reference where reference.id = p_reference_id;
  return '{'
    || '"authorityId":' || to_jsonb(v_reference.authority_id)::text
    || ',"classificationId":' || to_jsonb(v_reference.classification_id)::text
    || ',"kind":' || to_jsonb(v_reference.aggregate_kind)::text
    || ',"organizationId":' || to_jsonb(v_reference.organization_id::text)::text
    || ',"policyId":' || to_jsonb(v_reference.policy_id)::text
    || ',"revisionId":' || to_jsonb(v_reference.revision_id)::text
    || ',"sha256":' || to_jsonb(v_reference.sha256)::text
    || '}';
end
$$;

create function ml.active_promotion_signing_public_key(
  p_organization_id uuid,
  p_signing_key_id text,
  p_effective_at timestamptz
) returns bytea
language plpgsql
security definer
set search_path = pg_catalog, ml
as $$
declare
  v_key_registry_id uuid;
  v_public_key_spki_der bytea;
begin
  select key.id into v_key_registry_id
    from ml.promotion_signing_key key
   where key.organization_id = p_organization_id
     and key.key_id = p_signing_key_id;
  if not found then
    raise exception 'governed promotion requires an active owner-registered signing key'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- A revocation INSERT takes this same lock before it becomes visible. Keeping the active
  -- state read in a later PL/pgSQL statement gives READ COMMITTED a fresh post-wait snapshot.
  perform pg_advisory_xact_lock(
    hashtextextended('kf:ml:promotion-signing-key:' || v_key_registry_id::text, 0)
  );
  select decode(key.public_key_spki_der_base64, 'base64')
    into v_public_key_spki_der
    from ml.promotion_signing_key key
   where key.id = v_key_registry_id
     and key.valid_from <= p_effective_at
     and (key.valid_until is null or key.valid_until > p_effective_at)
     and key.valid_from <= clock_timestamp()
     and (key.valid_until is null or key.valid_until > clock_timestamp())
     and not exists (
       select 1 from ml.promotion_signing_key_revocation revoked
        where revoked.signing_key_registry_id = key.id
     );
  if not found then
    raise exception 'governed promotion requires an active owner-registered signing key'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return v_public_key_spki_der;
end
$$;

create function ml.verify_promotion_signature(
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

create function ml.append_signed_promotion_receipt(
  p_organization_id uuid,
  p_alias_id text,
  p_candidate_ref_id uuid,
  p_run_seal_id uuid,
  p_policy_ref_id uuid,
  p_evidence_ref_ids uuid[],
  p_risk_tier text,
  p_technical_authority_decision_ref_id uuid,
  p_quality_authority_decision_ref_id uuid,
  p_promoted_at timestamptz,
  p_signing_key_id text,
  p_receipt_sha256 text,
  p_signature text
) returns table (
  id uuid,
  receipt_sha256 text,
  evidence_manifest_sha256 text
)
language plpgsql
security definer
set search_path = pg_catalog, ml, public
as $$
declare
  v_input_count integer;
  v_distinct_count integer;
  v_reference_count integer;
  v_evidence_ref_ids uuid[];
  v_evidence_json text;
  v_evidence_manifest_sha256 text;
  v_candidate_json text;
  v_policy_json text;
  v_technical_json text;
  v_quality_json text;
  v_run_seal_sha256 text;
  v_promoted_at text;
  v_unsigned_receipt text;
  v_recomputed_receipt_sha256 text;
  v_public_key_spki_der bytea;
  v_receipt ml.promotion_receipt%rowtype;
begin
  if core.current_organization() is distinct from p_organization_id then
    raise exception 'promotion organization is outside current access context'
      using errcode = 'insufficient_privilege';
  end if;
  if p_alias_id !~ '^[a-z][a-z0-9._:-]{0,127}$'
     or p_signing_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'
     or p_receipt_sha256 !~ '^[0-9a-f]{64}$'
     or p_risk_tier not in ('research', 'regulated', 'high_risk') then
    raise exception 'promotion receipt contains an unsafe identifier, digest, or risk tier'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_promoted_at is distinct from date_trunc('milliseconds', p_promoted_at) then
    raise exception 'promotion timestamp must have canonical millisecond precision'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_evidence_ref_ids is null then
    raise exception 'promotion receipt requires evidence references'
      using errcode = 'check_violation';
  end if;
  select count(*), count(distinct evidence_id)
    into v_input_count, v_distinct_count
    from unnest(p_evidence_ref_ids) evidence_id;
  if v_input_count = 0 or v_input_count <> v_distinct_count then
    raise exception 'promotion receipt evidence references must be nonempty and unique'
      using errcode = 'check_violation';
  end if;
  select count(*) into v_reference_count
    from ml.aggregate_reference reference
    join unnest(p_evidence_ref_ids) evidence_id on evidence_id = reference.id
   where reference.organization_id = p_organization_id
     and reference.aggregate_kind = 'evidence';
  if v_reference_count <> v_input_count then
    raise exception 'promotion receipt evidence must be same-organization evidence references'
      using errcode = 'check_violation';
  end if;
  if not p_technical_authority_decision_ref_id = any(p_evidence_ref_ids)
     or (
       p_quality_authority_decision_ref_id is not null
       and not p_quality_authority_decision_ref_id = any(p_evidence_ref_ids)
     ) then
    raise exception 'promotion evidence set omits an authority decision'
      using errcode = 'check_violation';
  end if;
  if p_risk_tier <> 'research' and p_quality_authority_decision_ref_id is null then
    raise exception '% promotion requires a Quality Authority decision reference', p_risk_tier
      using errcode = 'check_violation';
  end if;

  select
    array_agg(evidence.id order by decode(evidence.reference_sha256, 'hex'), evidence.id),
    '[' || string_agg(evidence.canonical_reference, ','
      order by decode(evidence.reference_sha256, 'hex'), evidence.id) || ']'
    into v_evidence_ref_ids, v_evidence_json
    from (
      select reference.id,
             ml.canonical_aggregate_reference(reference.id) as canonical_reference,
             encode(
               public.digest(
                 convert_to(ml.canonical_aggregate_reference(reference.id), 'UTF8'),
                 'sha256'
               ),
               'hex'
             ) as reference_sha256
        from ml.aggregate_reference reference
        join unnest(p_evidence_ref_ids) evidence_id on evidence_id = reference.id
    ) evidence;
  v_evidence_manifest_sha256 := encode(
    public.digest(convert_to(v_evidence_json, 'UTF8'), 'sha256'),
    'hex'
  );
  v_candidate_json := ml.canonical_aggregate_reference(p_candidate_ref_id);
  v_policy_json := ml.canonical_aggregate_reference(p_policy_ref_id);
  v_technical_json := ml.canonical_aggregate_reference(
    p_technical_authority_decision_ref_id
  );
  v_quality_json := case
    when p_quality_authority_decision_ref_id is null then 'null'
    else ml.canonical_aggregate_reference(p_quality_authority_decision_ref_id)
  end;
  select seal.seal_sha256 into strict v_run_seal_sha256
    from ml.run_seal seal where seal.id = p_run_seal_id;
  v_promoted_at := to_char(
    p_promoted_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_unsigned_receipt := '{'
    || '"aliasId":' || to_jsonb(p_alias_id)::text
    || ',"candidate":' || v_candidate_json
    || ',"evidence":' || v_evidence_json
    || ',"evidenceSetDigest":' || to_jsonb(v_evidence_manifest_sha256)::text
    || ',"issuer":"knowledge-fabric"'
    || ',"organizationId":' || to_jsonb(p_organization_id::text)::text
    || ',"policy":' || v_policy_json
    || ',"promotedAt":' || to_jsonb(v_promoted_at)::text
    || ',"qualityAuthorityDecision":' || v_quality_json
    || ',"riskTier":' || to_jsonb(p_risk_tier)::text
    || ',"runSealDigest":' || to_jsonb(v_run_seal_sha256)::text
    || ',"schemaVersion":"kf.ml.promotion-receipt.v1"'
    || ',"signingKeyId":' || to_jsonb(p_signing_key_id)::text
    || ',"technicalAuthorityDecision":' || v_technical_json
    || '}';
  v_recomputed_receipt_sha256 := encode(
    public.digest(convert_to(v_unsigned_receipt, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_recomputed_receipt_sha256 <> p_receipt_sha256 then
    raise exception 'promotion receipt digest does not match canonical stored evidence'
      using errcode = 'integrity_constraint_violation';
  end if;

  v_public_key_spki_der := ml.active_promotion_signing_public_key(
    p_organization_id,
    p_signing_key_id,
    p_promoted_at
  );
  if not ml.verify_promotion_signature(
    v_public_key_spki_der,
    v_unsigned_receipt,
    p_signature
  ) then
    raise exception 'promotion receipt Ed25519 signature verification failed'
      using errcode = 'integrity_constraint_violation';
  end if;

  insert into ml.promotion_receipt (
    organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
    evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
    quality_authority_decision_ref_id, promoted_at, signing_key_id,
    receipt_sha256, signature
  ) values (
    p_organization_id, p_alias_id, p_candidate_ref_id, p_run_seal_id, p_policy_ref_id,
    v_evidence_manifest_sha256, p_risk_tier, p_technical_authority_decision_ref_id,
    p_quality_authority_decision_ref_id, p_promoted_at, p_signing_key_id,
    p_receipt_sha256, p_signature
  ) returning ml.promotion_receipt.* into v_receipt;

  insert into ml.promotion_receipt_evidence (
    promotion_receipt_id, ordinal, evidence_ref_id
  )
  select v_receipt.id, evidence.ordinality::integer, evidence.evidence_ref_id
    from unnest(v_evidence_ref_ids) with ordinality
      as evidence(evidence_ref_id, ordinality);

  return query select v_receipt.id, v_receipt.receipt_sha256,
                      v_receipt.evidence_manifest_sha256;
end
$$;

create function ml.append_signed_promotion_revocation(
  p_organization_id uuid,
  p_receipt_id uuid,
  p_reason_code text,
  p_revoked_at timestamptz,
  p_signing_key_id text,
  p_revocation_sha256 text,
  p_signature text
) returns table (
  id uuid,
  revocation_sha256 text
)
language plpgsql
security definer
set search_path = pg_catalog, ml, public
as $$
declare
  v_receipt ml.promotion_receipt%rowtype;
  v_revoked_at text;
  v_unsigned_revocation text;
  v_recomputed_revocation_sha256 text;
  v_public_key_spki_der bytea;
  v_revocation ml.promotion_revocation%rowtype;
begin
  if core.current_organization() is distinct from p_organization_id then
    raise exception 'promotion revocation organization is outside current access context'
      using errcode = 'insufficient_privilege';
  end if;
  if p_reason_code not in (
       'evidence_invalid', 'policy_violation', 'key_compromise', 'operator_withdrawal'
     )
     or p_signing_key_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$'
     or p_revocation_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'promotion revocation contains an unsafe reason, key, or digest'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_revoked_at is distinct from date_trunc('milliseconds', p_revoked_at) then
    raise exception 'promotion revocation timestamp must have canonical millisecond precision'
      using errcode = 'invalid_parameter_value';
  end if;
  select receipt.* into strict v_receipt
    from ml.promotion_receipt receipt where receipt.id = p_receipt_id;
  if v_receipt.organization_id is distinct from p_organization_id then
    raise exception 'promotion receipt belongs to another organization'
      using errcode = 'insufficient_privilege';
  end if;
  if p_revoked_at < v_receipt.promoted_at then
    raise exception 'promotion revocation predates its receipt'
      using errcode = 'check_violation';
  end if;

  v_revoked_at := to_char(
    p_revoked_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_unsigned_revocation := '{'
    || '"aliasId":' || to_jsonb(v_receipt.alias_id)::text
    || ',"issuer":"knowledge-fabric"'
    || ',"organizationId":' || to_jsonb(p_organization_id::text)::text
    || ',"reasonCode":' || to_jsonb(p_reason_code)::text
    || ',"receiptDigest":' || to_jsonb(v_receipt.receipt_sha256)::text
    || ',"revokedAt":' || to_jsonb(v_revoked_at)::text
    || ',"schemaVersion":"kf.ml.promotion-revocation.v1"'
    || ',"signingKeyId":' || to_jsonb(p_signing_key_id)::text
    || '}';
  v_recomputed_revocation_sha256 := encode(
    public.digest(convert_to(v_unsigned_revocation, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_recomputed_revocation_sha256 <> p_revocation_sha256 then
    raise exception 'promotion revocation digest does not match canonical stored receipt'
      using errcode = 'integrity_constraint_violation';
  end if;

  v_public_key_spki_der := ml.active_promotion_signing_public_key(
    p_organization_id,
    p_signing_key_id,
    p_revoked_at
  );
  if not ml.verify_promotion_signature(
    v_public_key_spki_der,
    v_unsigned_revocation,
    p_signature
  ) then
    raise exception 'promotion revocation Ed25519 signature verification failed'
      using errcode = 'integrity_constraint_violation';
  end if;

  insert into ml.promotion_revocation (
    organization_id, receipt_id, alias_id, reason_code, revoked_at,
    signing_key_id, revocation_sha256, signature
  ) values (
    p_organization_id, p_receipt_id, v_receipt.alias_id, p_reason_code, p_revoked_at,
    p_signing_key_id, p_revocation_sha256, p_signature
  ) returning ml.promotion_revocation.* into v_revocation;

  return query select v_revocation.id, v_revocation.revocation_sha256;
end
$$;

revoke execute on function ml.enforce_promotion_signing_key_revocation() from public;
revoke execute on function ml.canonical_aggregate_reference(uuid) from public;
revoke execute on function ml.active_promotion_signing_public_key(uuid, text, timestamptz)
  from public;
revoke execute on function ml.verify_promotion_signature(bytea, text, text) from public;
revoke execute on function ml.append_signed_promotion_receipt(
  uuid, text, uuid, uuid, uuid, uuid[], text, uuid, uuid, timestamptz, text, text, text
) from public, kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
revoke execute on function ml.append_signed_promotion_revocation(
  uuid, uuid, text, timestamptz, text, text, text
) from public, kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant execute on function ml.append_signed_promotion_receipt(
  uuid, text, uuid, uuid, uuid, uuid[], text, uuid, uuid, timestamptz, text, text, text
) to kf_ml_promoter;
grant execute on function ml.append_signed_promotion_revocation(
  uuid, uuid, text, timestamptz, text, text, text
) to kf_ml_promoter;

-- Raw two-table insertion previously let a promoter supply any shape-correct signature.
-- Promotion now has one atomic authority seam that verifies exact canonical bytes first.
revoke insert on ml.promotion_receipt, ml.promotion_receipt_evidence,
                 ml.promotion_revocation
  from kf_ml_promoter;

comment on table ml.promotion_signing_key is
  'Owner-controlled Ed25519 public-key registry for KF governed-promotion receipts.';
comment on view ml.promotion_verification_key is
  'Organization-scoped public Ed25519 verification material, validity, rotation, and revocation state. No private key material.';
comment on view ml.governed_alias is
  'Latest governed receipt per alias, suppressed without fallback by receipt or signing-key revocation. Key expiry blocks new signing but does not retroactively withdraw a receipt valid at promoted_at.';
comment on role kf_ml_promoter is
  'Offline KF ML controller. Writes metric authorizations and run seals; appends governed promotion receipts and revocations only through database-verified authority functions.';
comment on function ml.append_signed_promotion_receipt(
  uuid, text, uuid, uuid, uuid, uuid[], text, uuid, uuid, timestamptz, text, text, text
) is
  'Only governed-promotion append seam. Rebuilds JCS evidence/receipt bytes and verifies an active owner-registered Ed25519 key.';
comment on function ml.append_signed_promotion_revocation(
  uuid, uuid, text, timestamptz, text, text, text
) is
  'Only governed-promotion revocation seam. Rebuilds canonical bytes from the stored receipt and verifies an active owner-registered Ed25519 key.';

-- migrate:down

grant insert on ml.promotion_receipt, ml.promotion_receipt_evidence,
                ml.promotion_revocation
  to kf_ml_promoter;
create or replace view ml.governed_alias
with (security_barrier = true, security_invoker = true) as
with latest as (
  select distinct on (organization_id, alias_id)
    id, organization_id, alias_id, candidate_ref_id, run_seal_id, policy_ref_id,
    evidence_manifest_sha256, risk_tier, technical_authority_decision_ref_id,
    quality_authority_decision_ref_id, promoted_at, signing_key_id, receipt_sha256, signature
    from ml.promotion_receipt
   order by organization_id, alias_id, promoted_at desc, receipt_sha256 desc
)
select latest.organization_id, latest.alias_id, latest.candidate_ref_id,
       latest.run_seal_id, latest.policy_ref_id, latest.evidence_manifest_sha256,
       latest.risk_tier, latest.technical_authority_decision_ref_id,
       latest.quality_authority_decision_ref_id, latest.promoted_at,
       latest.signing_key_id, latest.receipt_sha256, latest.signature
  from latest
  left join ml.promotion_revocation revocation on revocation.receipt_id = latest.id
 where revocation.id is null;
comment on view ml.governed_alias is
  'Current ML alias resolution. Latest receipt wins; a revocation suppresses it without fallback.';
comment on role kf_ml_promoter is
  'Offline KF ML controller. Writes metric authorizations, run seals, promotion receipts, and revocations only.';
drop function if exists ml.append_signed_promotion_revocation(
  uuid, uuid, text, timestamptz, text, text, text
);
drop function if exists ml.append_signed_promotion_receipt(
  uuid, text, uuid, uuid, uuid, uuid[], text, uuid, uuid, timestamptz, text, text, text
);
drop function if exists ml.verify_promotion_signature(bytea, text, text);
drop function if exists ml.active_promotion_signing_public_key(uuid, text, timestamptz);
drop function if exists ml.canonical_aggregate_reference(uuid);
drop view if exists ml.promotion_verification_key;
drop table if exists ml.promotion_signing_key_revocation;
drop table if exists ml.promotion_signing_key;
drop function if exists ml.enforce_promotion_signing_key_revocation();
drop function if exists ml.verify_ed25519(bytea, bytea, bytea);
drop function if exists ml.ed25519_points_equal(numeric[], numeric[]);
drop function if exists ml.ed25519_decode_point(bytea);
drop function if exists ml.ed25519_point_multiply(numeric, numeric[]);
drop function if exists ml.ed25519_point_add(numeric[], numeric[]);
drop function if exists ml.ed25519_le_to_numeric(bytea);
drop function if exists ml.ed25519_pow_mod(numeric, numeric, numeric);
