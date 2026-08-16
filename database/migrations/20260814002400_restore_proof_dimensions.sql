-- migrate:up

-- A database round-trip proves database bytes only. It does not prove historical checkpoint
-- trust or recovery of externally stored artifact bytes. Make those three dimensions explicit
-- so neither scripts nor readiness can collapse a partial restore into "verified".

alter table ops.restore_drill
  drop constraint restore_drill_outcome_check,
  add constraint restore_drill_outcome_check
    check (outcome in ('verified', 'partial', 'failed')),
  add column database_verified boolean not null default false,
  add column database_snapshot_sha256 text,
  add column checkpoint_verified boolean not null default false,
  add column checkpoint_proof_sha256 text,
  add column object_store_verified boolean not null default false,
  add column object_store_proof_ref text,
  add column object_store_proof_sha256 text;

-- Historical "verified" rows did not record checkpoint/object-store dimensions. They are
-- preserved as honest partial evidence rather than grandfathered into a stronger claim.
alter table ops.restore_drill disable trigger restore_drill_append_only;
update ops.restore_drill set outcome = 'partial' where outcome = 'verified';
alter table ops.restore_drill enable trigger restore_drill_append_only;

alter table ops.restore_drill
  add constraint restore_database_proof_shape check (
    database_verified = coalesce(database_snapshot_sha256 ~ '^[0-9a-f]{64}$', false)
  ),
  add constraint restore_checkpoint_proof_shape check (
    checkpoint_verified = coalesce(checkpoint_proof_sha256 ~ '^[0-9a-f]{64}$', false)
  ),
  add constraint restore_object_store_proof_shape check (
    object_store_verified = coalesce((
      object_store_proof_sha256 ~ '^[0-9a-f]{64}$'
      and object_store_proof_ref is not null
      and length(object_store_proof_ref) between 1 and 512
      and object_store_proof_ref = btrim(object_store_proof_ref)
    ), false)
  ),
  add constraint restore_verified_means_complete check (
    (outcome = 'verified') =
      (database_verified and checkpoint_verified and object_store_verified)
  );

comment on column ops.restore_drill.database_verified is
  'True only after authenticated dump restore and byte-identical canonical re-export.';
comment on column ops.restore_drill.checkpoint_verified is
  'True only after full ledger verification against authenticated historical public keys.';
comment on column ops.restore_drill.object_store_verified is
  'True only after an external store adapter re-reads referenced bytes and verifies digests.';
comment on constraint restore_verified_means_complete on ops.restore_drill is
  'Generic verified outcome is legal only when database, checkpoint, and object-store proofs all pass.';

-- migrate:down

alter table ops.restore_drill
  drop constraint if exists restore_verified_means_complete,
  drop constraint if exists restore_object_store_proof_shape,
  drop constraint if exists restore_checkpoint_proof_shape,
  drop constraint if exists restore_database_proof_shape;
alter table ops.restore_drill disable trigger restore_drill_append_only;
update ops.restore_drill set outcome = 'failed' where outcome = 'partial';
alter table ops.restore_drill enable trigger restore_drill_append_only;
alter table ops.restore_drill
  drop column if exists object_store_proof_sha256,
  drop column if exists object_store_proof_ref,
  drop column if exists object_store_verified,
  drop column if exists checkpoint_proof_sha256,
  drop column if exists checkpoint_verified,
  drop column if exists database_snapshot_sha256,
  drop column if exists database_verified,
  drop constraint restore_drill_outcome_check,
  add constraint restore_drill_outcome_check check (outcome in ('verified', 'failed'));
