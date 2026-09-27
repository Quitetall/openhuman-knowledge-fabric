-- migrate:up

-- A lost band-version row must never replay a version it issued before (ADR 0028, amended
-- 2026-09-24; SAS §64A).
--
-- WHAT WAS WRONG. `retrieval.band_version` is derived and excluded from preservation, so a
-- restore that leaves it out, or an operator who truncates it, loses the row. The next
-- band-moving write recreated it at version 1, and the counter climbed back through every value
-- it had issued before. A bitmap cached at version 7 before the loss — in the process that
-- builds masks, or in the retrieval engine it was pushed to — became valid again the moment the
-- counter reached 7, over records that had since been reclassified. A cache keyed on a version
-- that can repeat is the stale-copy failure this table exists to prevent.
--
-- THE FIX. The row carries an epoch, a fresh uuidv7() every time the row is CREATED and never
-- changed by a bump. The version the application reads is the pair (epoch, counter), and it
-- keys on the pair. A recreated row has a new epoch, so no token it issues can equal one issued
-- under the old. Existing rows get a distinct epoch each (a volatile default is evaluated per row
-- when the column is added), which invalidates every cache once, the safe direction.
--
-- The bump function is unchanged in shape: its INSERT branch takes the column default, its
-- ON CONFLICT branch does not touch the epoch. Rewritten anyway so the rule is in the function
-- and not only in a default someone could drop.

alter table retrieval.band_version
  add column epoch uuid not null default uuidv7();

create or replace function retrieval.bump_band_version() returns trigger
language plpgsql
security definer
set search_path = retrieval, pg_catalog
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  -- A new row is a new epoch: the counter restarting at 1 is harmless only because the epoch
  -- beside it has never been seen. An existing row keeps its epoch and moves its counter.
  insert into retrieval.band_version (organization_id, epoch, version, updated_at)
       values (v_org, uuidv7(), 1, now())
  on conflict (organization_id) do update
      set version = retrieval.band_version.version + 1,
          updated_at = now();
  return null;
end
$$;

revoke execute on function retrieval.bump_band_version() from public;

-- The epoch is identity of the row's lifetime, not data: nothing may rewrite it in place. Only
-- the owner can write this table at all; this makes even the owner's UPDATE unable to reuse an
-- epoch while moving the counter back.
create or replace function retrieval.band_version_epoch_is_fixed() returns trigger
language plpgsql
set search_path = retrieval, pg_catalog
as $$
begin
  if new.epoch is distinct from old.epoch then
    raise exception 'retrieval.band_version.epoch is fixed for the life of the row'
      using errcode = '55000';
  end if;
  if new.version < old.version then
    raise exception 'retrieval.band_version.version never moves backwards (% -> %)',
      old.version, new.version
      using errcode = '55000';
  end if;
  return new;
end
$$;

revoke execute on function retrieval.band_version_epoch_is_fixed() from public;

create trigger band_version_epoch_is_fixed
  before update on retrieval.band_version
  for each row execute function retrieval.band_version_epoch_is_fixed();

-- migrate:down

drop trigger if exists band_version_epoch_is_fixed on retrieval.band_version;
drop function if exists retrieval.band_version_epoch_is_fixed();

create or replace function retrieval.bump_band_version() returns trigger
language plpgsql
security definer
set search_path = retrieval, pg_catalog
as $$
declare
  v_org uuid := coalesce(new.organization_id, old.organization_id);
begin
  insert into retrieval.band_version (organization_id, version, updated_at)
       values (v_org, 1, now())
  on conflict (organization_id) do update
      set version = retrieval.band_version.version + 1,
          updated_at = now();
  return null;
end
$$;

revoke execute on function retrieval.bump_band_version() from public;

alter table retrieval.band_version drop column epoch;
