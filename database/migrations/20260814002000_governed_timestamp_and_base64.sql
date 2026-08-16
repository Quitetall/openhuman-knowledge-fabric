-- migrate:up

-- Signed authority records share one timestamp wire domain. PostgreSQL accepts infinity,
-- BC/extended years, and microseconds that Node Date / RFC 3339 four-digit-year payloads
-- cannot reproduce. It also permits a future-dated record to take effect immediately unless
-- every consumer remembers an ad-hoc predicate. Enforce this once at database authority.
create function core.require_governed_effective_timestamp(
  p_value timestamptz,
  p_field text
) returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $$
begin
  if p_value is null
     or not isfinite(p_value)
     or p_value < timestamptz '0001-01-01 00:00:00+00'
     or p_value >= timestamptz '10000-01-01 00:00:00+00'
     or p_value is distinct from date_trunc('milliseconds', p_value)
     or p_value > clock_timestamp() then
    raise exception
      '% must be a finite four-digit-year millisecond instant and must not be in the future',
      p_field
      using errcode = 'invalid_parameter_value';
  end if;
end
$$;

revoke execute on function core.require_governed_effective_timestamp(timestamptz, text)
  from public;

create function core.enforce_governed_effective_timestamp() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare v_value timestamptz;
begin
  if tg_nargs <> 1 then
    raise exception 'governed timestamp trigger requires exactly one column argument'
      using errcode = 'invalid_parameter_value';
  end if;
  v_value := (to_jsonb(new) ->> tg_argv[0])::timestamptz;
  perform core.require_governed_effective_timestamp(
    v_value,
    format('%I.%I.%I', tg_table_schema, tg_table_name, tg_argv[0])
  );
  return new;
end
$$;

revoke execute on function core.enforce_governed_effective_timestamp() from public;

-- Validate all pre-migration authority rows before installing write-time guards. Refuse an
-- upgrade that would leave an already-effective record outside the new canonical domain.
do $$
begin
  perform core.require_governed_effective_timestamp(
    receipt.promoted_at, 'ml.promotion_receipt.promoted_at'
  ) from ml.promotion_receipt receipt;
  perform core.require_governed_effective_timestamp(
    revocation.revoked_at, 'ml.promotion_revocation.revoked_at'
  ) from ml.promotion_revocation revocation;
  perform core.require_governed_effective_timestamp(
    revocation.revoked_at, 'ml.promotion_signing_key_revocation.revoked_at'
  ) from ml.promotion_signing_key_revocation revocation;
  perform core.require_governed_effective_timestamp(
    seal.sealed_at, 'ml.run_seal.sealed_at'
  ) from ml.run_seal seal;
  perform core.require_governed_effective_timestamp(
    revocation.revoked_at, 'ml.run_seal_signing_key_revocation.revoked_at'
  ) from ml.run_seal_signing_key_revocation revocation;
  perform core.require_governed_effective_timestamp(
    revocation.revoked_at, 'secure_object.authority_signing_key_revocation.revoked_at'
  ) from secure_object.authority_signing_key_revocation revocation;
  perform core.require_governed_effective_timestamp(
    tombstone.erased_at, 'secure_object.erasure_tombstone.erased_at'
  ) from secure_object.erasure_tombstone tombstone;
end
$$;

create trigger zz_governed_effective_timestamp
  before insert on ml.promotion_receipt
  for each row execute function core.enforce_governed_effective_timestamp('promoted_at');
create trigger zz_governed_effective_timestamp
  before insert on ml.promotion_revocation
  for each row execute function core.enforce_governed_effective_timestamp('revoked_at');
create trigger zz_governed_effective_timestamp
  before insert on ml.promotion_signing_key_revocation
  for each row execute function core.enforce_governed_effective_timestamp('revoked_at');
create trigger zz_governed_effective_timestamp
  before insert on ml.run_seal
  for each row execute function core.enforce_governed_effective_timestamp('sealed_at');
create trigger zz_governed_effective_timestamp
  before insert on ml.run_seal_signing_key_revocation
  for each row execute function core.enforce_governed_effective_timestamp('revoked_at');
create trigger zz_governed_effective_timestamp
  before insert on secure_object.authority_signing_key_revocation
  for each row execute function core.enforce_governed_effective_timestamp('revoked_at');
create trigger zz_governed_effective_timestamp
  before insert on secure_object.erasure_tombstone
  for each row execute function core.enforce_governed_effective_timestamp('erased_at');

-- Tombstone authority historically truncated action microseconds before persisting/signing.
-- Reject the noncanonical action instant before that trigger can erase the mismatch.
create function secure_object.enforce_erasure_action_timestamp() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare v_effective_at timestamptz;
begin
  select action.effective_at into strict v_effective_at
    from core.action action
   where action.id = core.current_action_id();
  perform core.require_governed_effective_timestamp(
    v_effective_at,
    'secure_object.erasure_tombstone action effective_at'
  );
  return new;
end
$$;

revoke execute on function secure_object.enforce_erasure_action_timestamp() from public;

create trigger erasure_tombstone_0_governed_timestamp
  before insert on secure_object.erasure_tombstone
  for each row execute function secure_object.enforce_erasure_action_timestamp();

-- Secure Object Authority was the remaining key/signature surface whose SQL constraints
-- accepted alternate base64 spellings of identical bytes. Preserve one wire spelling only.
alter table secure_object.authority_signing_key
  add constraint authority_signing_key_canonical_base64 check (
    replace(
      encode(decode(public_key_spki_der_base64, 'base64'), 'base64'),
      E'\n',
      ''
    ) = public_key_spki_der_base64
  );

alter table secure_object.erasure_tombstone
  add constraint erasure_tombstone_signature_canonical_base64 check (
    octet_length(decode(signature, 'base64')) = 64
    and replace(encode(decode(signature, 'base64'), 'base64'), E'\n', '') = signature
  );

-- Resolve against one explicit evaluation instant. Future rows are rejected above, but this
-- keeps imported/legacy projections from activating early and documents effectivity in the
-- authoritative view instead of relying on insertion-time assumptions.
create or replace view ml.governed_alias
with (security_barrier = true, security_invoker = true) as
with evaluation as materialized (
  select clock_timestamp() as evaluated_at
), latest as (
  select distinct on (receipt.organization_id, receipt.alias_id)
    receipt.id, receipt.organization_id, receipt.alias_id, receipt.candidate_ref_id,
    receipt.run_seal_id, receipt.policy_ref_id, receipt.evidence_manifest_sha256,
    receipt.risk_tier, receipt.technical_authority_decision_ref_id,
    receipt.quality_authority_decision_ref_id, receipt.promoted_at,
    receipt.signing_key_id, receipt.receipt_sha256, receipt.signature
    from ml.promotion_receipt receipt
    cross join evaluation
   where receipt.promoted_at <= evaluation.evaluated_at
   order by receipt.organization_id, receipt.alias_id,
            receipt.promoted_at desc, receipt.receipt_sha256 desc
)
select latest.organization_id, latest.alias_id, latest.candidate_ref_id,
       latest.run_seal_id, latest.policy_ref_id, latest.evidence_manifest_sha256,
       latest.risk_tier, latest.technical_authority_decision_ref_id,
       latest.quality_authority_decision_ref_id, latest.promoted_at,
       latest.signing_key_id, latest.receipt_sha256, latest.signature
  from latest
  cross join evaluation
  join ml.promotion_signing_key signing_key
    on signing_key.organization_id = latest.organization_id
   and signing_key.key_id = latest.signing_key_id
   and signing_key.algorithm = 'Ed25519'
   and signing_key.valid_from <= latest.promoted_at
   and (signing_key.valid_until is null or signing_key.valid_until > latest.promoted_at)
  left join ml.promotion_revocation receipt_revocation
    on receipt_revocation.receipt_id = latest.id
   and receipt_revocation.revoked_at <= evaluation.evaluated_at
  left join ml.promotion_signing_key_revocation key_revocation
    on key_revocation.signing_key_registry_id = signing_key.id
   and key_revocation.revoked_at <= evaluation.evaluated_at
 where receipt_revocation.id is null
   and key_revocation.signing_key_registry_id is null;

comment on view ml.governed_alias is
  'Latest effective governed receipt per alias at one database evaluation instant, suppressed without fallback by effective receipt or signing-key revocation. Future authority events never take effect early.';

-- migrate:down

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

comment on view ml.governed_alias is
  'Latest governed receipt per alias, suppressed without fallback by receipt or signing-key revocation. Key expiry blocks new signing but does not retroactively withdraw a receipt valid at promoted_at.';

alter table secure_object.erasure_tombstone
  drop constraint if exists erasure_tombstone_signature_canonical_base64;
alter table secure_object.authority_signing_key
  drop constraint if exists authority_signing_key_canonical_base64;

drop trigger if exists erasure_tombstone_0_governed_timestamp
  on secure_object.erasure_tombstone;
drop function if exists secure_object.enforce_erasure_action_timestamp();

drop trigger if exists zz_governed_effective_timestamp on ml.promotion_receipt;
drop trigger if exists zz_governed_effective_timestamp on ml.promotion_revocation;
drop trigger if exists zz_governed_effective_timestamp on ml.promotion_signing_key_revocation;
drop trigger if exists zz_governed_effective_timestamp on ml.run_seal;
drop trigger if exists zz_governed_effective_timestamp on ml.run_seal_signing_key_revocation;
drop trigger if exists zz_governed_effective_timestamp
  on secure_object.authority_signing_key_revocation;
drop trigger if exists zz_governed_effective_timestamp on secure_object.erasure_tombstone;

drop function if exists core.enforce_governed_effective_timestamp();
drop function if exists core.require_governed_effective_timestamp(timestamptz, text);
