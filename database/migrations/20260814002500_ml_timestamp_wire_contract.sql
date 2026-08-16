-- migrate:up

-- ML API and signature contracts use canonical four-digit-year RFC 3339 timestamps with
-- exactly millisecond precision. node-postgres decodes timestamptz through JavaScript Date,
-- which would silently discard PostgreSQL microseconds. Reject values outside that shared
-- wire domain at authority instead of returning altered provenance.
create function core.is_canonical_wire_timestamp(p_value timestamptz) returns boolean
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select isfinite(p_value)
     and p_value >= timestamptz '0001-01-01 00:00:00+00'
     and p_value < timestamptz '10000-01-01 00:00:00+00'
     and p_value = date_trunc('milliseconds', p_value)
$$;

revoke execute on function core.is_canonical_wire_timestamp(timestamptz) from public;
grant usage on schema core to kf_migrator;
grant usage on schema ml to kf_migrator;
grant execute on function core.is_canonical_wire_timestamp(timestamptz)
  to kf_app, kf_worker, kf_ml_promoter, kf_migrator;

-- ADD CONSTRAINT validates existing rows before installing each write guard. Migrations run
-- transactionally, so one legacy microsecond value refuses the whole upgrade without
-- truncating or otherwise rewriting append-only history.
alter table ml.run_lineage
  add constraint run_lineage_recorded_at_canonical_wire
  check (core.is_canonical_wire_timestamp(recorded_at));

alter table ml.metric_write_authorization
  add constraint metric_write_authorization_authorized_at_canonical_wire
  check (core.is_canonical_wire_timestamp(authorized_at));

alter table ml.metric_event
  add constraint metric_event_recorded_at_canonical_wire
    check (core.is_canonical_wire_timestamp(recorded_at)),
  add constraint metric_event_timestamp_value_canonical_wire
    check (core.is_canonical_wire_timestamp(timestamp_value));

alter table ml.run_seal
  add constraint run_seal_sealed_at_canonical_wire
    check (core.is_canonical_wire_timestamp(sealed_at)),
  add constraint run_seal_recorded_at_canonical_wire
    check (core.is_canonical_wire_timestamp(recorded_at));

alter table ml.promotion_receipt
  add constraint promotion_receipt_promoted_at_canonical_wire
    check (core.is_canonical_wire_timestamp(promoted_at)),
  add constraint promotion_receipt_recorded_at_canonical_wire
    check (core.is_canonical_wire_timestamp(recorded_at));

alter table ml.promotion_revocation
  add constraint promotion_revocation_revoked_at_canonical_wire
    check (core.is_canonical_wire_timestamp(revoked_at)),
  add constraint promotion_revocation_recorded_at_canonical_wire
    check (core.is_canonical_wire_timestamp(recorded_at));

alter table ml.promotion_signing_key
  add constraint promotion_signing_key_valid_from_canonical_wire
    check (core.is_canonical_wire_timestamp(valid_from)),
  add constraint promotion_signing_key_valid_until_canonical_wire
    check (core.is_canonical_wire_timestamp(valid_until)),
  add constraint promotion_signing_key_registered_at_canonical_wire
    check (core.is_canonical_wire_timestamp(registered_at));

alter table ml.promotion_signing_key_revocation
  add constraint promotion_signing_key_revoked_at_canonical_wire
  check (core.is_canonical_wire_timestamp(revoked_at));

alter table ml.run_seal_signing_key
  add constraint run_seal_signing_key_valid_from_canonical_wire
    check (core.is_canonical_wire_timestamp(valid_from)),
  add constraint run_seal_signing_key_valid_until_canonical_wire
    check (core.is_canonical_wire_timestamp(valid_until)),
  add constraint run_seal_signing_key_registered_at_canonical_wire
    check (core.is_canonical_wire_timestamp(registered_at));

alter table ml.run_seal_signing_key_revocation
  add constraint run_seal_signing_key_revoked_at_canonical_wire
  check (core.is_canonical_wire_timestamp(revoked_at));

alter table ml.promotion_authority_decision
  add constraint promotion_authority_decision_effective_at_canonical_wire
    check (core.is_canonical_wire_timestamp(effective_at)),
  add constraint promotion_authority_decision_valid_until_canonical_wire
    check (core.is_canonical_wire_timestamp(valid_until)),
  add constraint promotion_authority_decision_recorded_at_canonical_wire
    check (core.is_canonical_wire_timestamp(recorded_at));

-- Preserve now() transaction semantics while making generated metadata representable on the
-- same lossless wire. Caller-supplied authority times are rejected, never coerced.
alter table ml.run_lineage alter column recorded_at
  set default date_trunc('milliseconds', transaction_timestamp());
alter table ml.run_seal alter column recorded_at
  set default date_trunc('milliseconds', transaction_timestamp());
alter table ml.promotion_receipt alter column recorded_at
  set default date_trunc('milliseconds', transaction_timestamp());
alter table ml.promotion_revocation alter column recorded_at
  set default date_trunc('milliseconds', transaction_timestamp());
alter table ml.promotion_authority_decision alter column recorded_at
  set default date_trunc('milliseconds', transaction_timestamp());

comment on function core.is_canonical_wire_timestamp(timestamptz) is
  'True only for finite four-digit-year PostgreSQL instants exactly representable by the KF RFC 3339 millisecond wire contract. NULL remains allowed only where the column permits it.';

-- migrate:down

alter table ml.promotion_authority_decision alter column recorded_at set default now();
alter table ml.promotion_revocation alter column recorded_at set default now();
alter table ml.promotion_receipt alter column recorded_at set default now();
alter table ml.run_seal alter column recorded_at set default now();
alter table ml.run_lineage alter column recorded_at set default now();

alter table ml.promotion_authority_decision
  drop constraint if exists promotion_authority_decision_recorded_at_canonical_wire,
  drop constraint if exists promotion_authority_decision_valid_until_canonical_wire,
  drop constraint if exists promotion_authority_decision_effective_at_canonical_wire;
alter table ml.run_seal_signing_key_revocation
  drop constraint if exists run_seal_signing_key_revoked_at_canonical_wire;
alter table ml.run_seal_signing_key
  drop constraint if exists run_seal_signing_key_registered_at_canonical_wire,
  drop constraint if exists run_seal_signing_key_valid_until_canonical_wire,
  drop constraint if exists run_seal_signing_key_valid_from_canonical_wire;
alter table ml.promotion_signing_key_revocation
  drop constraint if exists promotion_signing_key_revoked_at_canonical_wire;
alter table ml.promotion_signing_key
  drop constraint if exists promotion_signing_key_registered_at_canonical_wire,
  drop constraint if exists promotion_signing_key_valid_until_canonical_wire,
  drop constraint if exists promotion_signing_key_valid_from_canonical_wire;
alter table ml.promotion_revocation
  drop constraint if exists promotion_revocation_recorded_at_canonical_wire,
  drop constraint if exists promotion_revocation_revoked_at_canonical_wire;
alter table ml.promotion_receipt
  drop constraint if exists promotion_receipt_recorded_at_canonical_wire,
  drop constraint if exists promotion_receipt_promoted_at_canonical_wire;
alter table ml.run_seal
  drop constraint if exists run_seal_recorded_at_canonical_wire,
  drop constraint if exists run_seal_sealed_at_canonical_wire;
alter table ml.metric_event
  drop constraint if exists metric_event_timestamp_value_canonical_wire,
  drop constraint if exists metric_event_recorded_at_canonical_wire;
alter table ml.metric_write_authorization
  drop constraint if exists metric_write_authorization_authorized_at_canonical_wire;
alter table ml.run_lineage
  drop constraint if exists run_lineage_recorded_at_canonical_wire;

revoke execute on function core.is_canonical_wire_timestamp(timestamptz)
  from kf_app, kf_worker, kf_ml_promoter, kf_migrator;
revoke usage on schema ml from kf_migrator;
revoke usage on schema core from kf_migrator;
drop function if exists core.is_canonical_wire_timestamp(timestamptz);
