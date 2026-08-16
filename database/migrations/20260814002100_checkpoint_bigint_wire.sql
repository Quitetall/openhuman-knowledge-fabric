-- migrate:up

-- v1/v2 encoded bigint-backed sequence values as JSON numbers. JavaScript cannot represent
-- PostgreSQL bigint exactly above 2^53-1, so v3 commits sequence bounds and leaf_count as
-- canonical decimal strings. Historical formats remain accepted for verification only.
alter table core.audit_checkpoint
  drop constraint audit_checkpoint_known_format;

alter table core.audit_checkpoint
  add constraint audit_checkpoint_known_format check (
    format_version in (
      'kf.audit-checkpoint.v1',
      'kf.audit-checkpoint.v2',
      'kf.audit-checkpoint.v3'
    )
  );

-- PostgreSQL decode(), like Node Buffer.from(..., 'base64'), accepts more spellings than one
-- Ed25519 signature should have. Persist exactly one canonical encoding for each 64-byte value.
alter table core.audit_checkpoint
  add constraint audit_checkpoint_signature_canonical_ed25519 check (
    signature ~ '^[A-Za-z0-9+/]{86}==$'
    and octet_length(decode(signature, 'base64')) = 64
    and replace(encode(decode(signature, 'base64'), 'base64'), E'\n', '') = signature
  );

alter table core.audit_checkpoint
  add constraint audit_checkpoint_positive_sequence_range check (
    from_seq > 0 and to_seq > 0 and leaf_count > 0
  );

alter table core.audit_checkpoint
  add constraint audit_checkpoint_signing_key_id check (
    signing_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
  );

-- Legacy signatures committed JSON numbers. Above this boundary, distinct PostgreSQL bigint
-- values collapse in JavaScript and actual event membership cannot be recovered from bounds.
-- Fail migration rather than silently reinterpret such evidence; v3 has no such restriction.
alter table core.audit_checkpoint
  add constraint audit_checkpoint_legacy_safe_integer_range check (
    format_version = 'kf.audit-checkpoint.v3'
    or (
      from_seq <= 9007199254740991
      and to_seq <= 9007199254740991
      and leaf_count <= 9007199254740991
    )
  );

comment on column core.audit_checkpoint.format_version is
  'Signed checkpoint/leaf contract. v1/v2 retain historical numeric sequence preimages; '
  'v3 signs PostgreSQL bigint sequence bounds and leaf_count as canonical decimal strings.';

-- migrate:down

alter table core.audit_checkpoint
  drop constraint audit_checkpoint_legacy_safe_integer_range;

alter table core.audit_checkpoint
  drop constraint audit_checkpoint_signing_key_id;

alter table core.audit_checkpoint
  drop constraint audit_checkpoint_positive_sequence_range;

alter table core.audit_checkpoint
  drop constraint audit_checkpoint_signature_canonical_ed25519;

alter table core.audit_checkpoint
  drop constraint audit_checkpoint_known_format;

alter table core.audit_checkpoint
  add constraint audit_checkpoint_known_format check (
    format_version in ('kf.audit-checkpoint.v1', 'kf.audit-checkpoint.v2')
  );

comment on column core.audit_checkpoint.format_version is
  'Signed checkpoint/leaf contract. v1 is retained only for historical verification; new writes use v2.';
