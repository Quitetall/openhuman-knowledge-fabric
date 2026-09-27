-- migrate:up

-- The band version moves at commit, not at the first write (§64A, KF-SAS-RQ-214, RQ-223,
-- ADR 0028).
--
-- WHAT WAS WRONG. `retrieval.bump_band_version()` ran as a row trigger AFTER each insert, delete
-- and reclassification of a record, and updated the organization's one `retrieval.band_version`
-- row. The row lock that update takes is held until the transaction ends, so from its first new
-- record onwards a transaction held its organization's row for the rest of its life: every other
-- transaction creating a record in that organization queued behind it. An ingest parses a file
-- after it creates the artifact, so two parallel large ingests into one organization ran one at a
-- time, and on the multi-organization fixture the waiting one outlasted its statement budget.
--
-- THE FIX. The triggers become constraint triggers, DEFERRABLE INITIALLY DEFERRED: the bump runs
-- when the transaction commits, after all its work, so the row is locked for the commit alone.
-- The guarantees are those of a bump at the first write, because they never depended on when
-- within the transaction the row moved:
--
--   * the version moves in the same transaction as the band change, so no reader sees one
--     without the other (both become visible at the same commit, or neither does);
--   * two committing transactions still serialize on the row, so each bump adds one to the value
--     the previous commit left, and the (epoch, counter) pair is never issued twice
--     (20260925064100; `band_version_epoch_is_fixed` still refuses a counter moving backwards);
--   * a bitmap is still valid only at the version it was built at: `buildBandBitmaps` reads the
--     version before and after deriving the bands and refuses if it moved.
--
-- A transaction bumps once per organization however many records it writes (the first bump
-- records the transaction id; later ones in the same transaction find it and do nothing). A
-- session that runs SET CONSTRAINTS ALL IMMEDIATE gets the old behaviour, locks and all, and is
-- no less correct.

alter table retrieval.band_version
  add column bumped_by xid8;

comment on column retrieval.band_version.bumped_by is
  'The transaction that last moved the version, so a transaction writing many records bumps once.';

create or replace function retrieval.bump_band_version() returns trigger
language plpgsql
security definer
set search_path = retrieval, pg_catalog
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  -- A new row is a new epoch: the counter restarting at 1 is harmless only because the epoch
  -- beside it has never been seen. An existing row keeps its epoch and moves its counter, once
  -- per transaction.
  insert into retrieval.band_version (organization_id, epoch, version, updated_at, bumped_by)
       values (v_org, uuidv7(), 1, now(), pg_current_xact_id())
  on conflict (organization_id) do update
      set version = retrieval.band_version.version + 1,
          updated_at = now(),
          bumped_by = excluded.bumped_by
    where retrieval.band_version.bumped_by is distinct from excluded.bumped_by;
  -- An organization change moves a record between two organizations' band sets: the one it left
  -- moves too.
  if tg_op = 'UPDATE' and old.organization_id is distinct from new.organization_id then
    insert into retrieval.band_version (organization_id, epoch, version, updated_at, bumped_by)
         values (old.organization_id, uuidv7(), 1, now(), pg_current_xact_id())
    on conflict (organization_id) do update
        set version = retrieval.band_version.version + 1,
            updated_at = now(),
            bumped_by = excluded.bumped_by
      where retrieval.band_version.bumped_by is distinct from excluded.bumped_by;
  end if;
  return null;
end
$$;

revoke execute on function retrieval.bump_band_version() from public;

drop trigger object_band_version_insert on core.object;
drop trigger object_band_version_update on core.object;
drop trigger object_band_version_delete on core.object;

create constraint trigger object_band_version_insert
  after insert on core.object
  deferrable initially deferred
  for each row execute function retrieval.bump_band_version();

create constraint trigger object_band_version_update
  after update of classification, organization_id on core.object
  deferrable initially deferred
  for each row execute function retrieval.bump_band_version();

create constraint trigger object_band_version_delete
  after delete on core.object
  deferrable initially deferred
  for each row execute function retrieval.bump_band_version();

-- migrate:down

drop trigger object_band_version_insert on core.object;
drop trigger object_band_version_update on core.object;
drop trigger object_band_version_delete on core.object;

create or replace function retrieval.bump_band_version() returns trigger
language plpgsql
security definer
set search_path = retrieval, pg_catalog
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  insert into retrieval.band_version (organization_id, epoch, version, updated_at)
       values (v_org, uuidv7(), 1, now())
  on conflict (organization_id) do update
      set version = retrieval.band_version.version + 1,
          updated_at = now();
  return null;
end
$$;

revoke execute on function retrieval.bump_band_version() from public;

create trigger object_band_version_insert
  after insert on core.object
  for each row execute function retrieval.bump_band_version();

create trigger object_band_version_update
  after update of classification, organization_id on core.object
  for each row execute function retrieval.bump_band_version();

create trigger object_band_version_delete
  after delete on core.object
  for each row execute function retrieval.bump_band_version();

alter table retrieval.band_version drop column bumped_by;
