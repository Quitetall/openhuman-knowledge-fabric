-- migrate:up

-- Band membership for the retrieval mask (§64A, KF-SAS-RQ-214).
--
-- The retrieval index holds a vector and an object identifier and no authorization input. The
-- decision about who may see what is therefore taken here, per query, and handed across as a
-- mask over the index's slot ordering. This migration supplies the two things that mask needs
-- from the database: which band each slot's record is in, and a version that moves whenever any
-- of those bands could have changed.
--
-- The version exists so a cached bitmap can be trusted without re-deriving it. Nothing here
-- caches; the cache lives in the process that builds masks and, per KF-SAS-RQ-223, never reaches
-- durable storage. What this side must guarantee is that the version cannot fail to move when a
-- classification does — because a cache keyed on a version that does not move is exactly the
-- stale-copy failure 20260914000100 removed from the search index.

create schema if not exists retrieval;
grant usage on schema retrieval to kf_app, kf_worker;

-- No foreign key on `organization_id`, deliberately, and the test that made this necessary is
-- worth keeping in mind. `core.object.organization_id` is `uuid not null` and references nothing:
-- an object may name an organization that has no `org.organization` row, which the fixture path
-- does routinely. A foreign key here was therefore STRICTER than the column it derives from, so
-- the trigger below refused the very insert it exists to observe.
--
-- A derived table must never be able to refuse the authoritative write it derives from. That is
-- true of this key specifically and of anything else added to this table later.
create table retrieval.band_version (
  organization_id uuid primary key,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table retrieval.band_version enable row level security;

create policy band_version_read on retrieval.band_version for select
  using (organization_id = core.current_organization());

grant select on retrieval.band_version to kf_app, kf_worker;

/**
 * Move the band version for an organization whose classifications may have changed.
 *
 * SECURITY DEFINER because the trigger fires under whatever context performed the act, and that
 * caller has no business holding write access to this table. The function writes one row and
 * reads nothing back.
 */
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

-- Fires on the three ways a band can move: a record appears, a record's classification changes,
-- and a record leaves. `update of classification` narrows it so ordinary edits — a title, a
-- state, a row_version — do not invalidate every cached bitmap in the estate. An organization
-- change moves a record between two organizations' band sets, so it is included.
create trigger object_band_version_insert
  after insert on core.object
  for each row execute function retrieval.bump_band_version();

create trigger object_band_version_update
  after update of classification, organization_id on core.object
  for each row execute function retrieval.bump_band_version();

create trigger object_band_version_delete
  after delete on core.object
  for each row execute function retrieval.bump_band_version();

/**
 * The band of each slot, in the order the slots were given.
 *
 * Takes the retrieval index's slot -> object_id map and answers, positionally, what band each
 * slot's record is in. Returns `null` for a slot whose identifier names no record in this
 * organization — an index that has outrun the database, or been pointed at the wrong one. The
 * caller masks those slots off; a slot KF cannot resolve is not a slot anyone may read.
 *
 * SECURITY DEFINER, and this is the part worth being explicit about. Band membership is a
 * property of the organization's records, not of the caller: the same four bitmaps serve every
 * person in the organization, which is what makes them cacheable at all. Deriving them therefore
 * requires seeing classifications above the caller's own ceiling, which RLS correctly forbids the
 * caller to do directly.
 *
 * What this returns is a position and a band name. Not a title, not a body, not an identifier
 * the caller did not already supply. The mask built from it then hides exactly those slots the
 * caller may not read, so the information does not reach a person — it reaches the process that
 * is about to enforce against it. Granted to the application and worker roles, which are
 * processes; a human never holds a database role here.
 */
create or replace function retrieval.slot_bands(p_organization uuid, p_object_ids uuid[])
returns table (slot integer, classification text)
language sql
stable
security definer
set search_path = core, retrieval, pg_catalog
as $$
  select s.ord::integer, o.classification
    from unnest(p_object_ids) with ordinality as s(id, ord)
    left join core.object o
      on o.id = s.id
     and o.organization_id = p_organization
   order by s.ord
$$;

revoke execute on function retrieval.slot_bands(uuid, uuid[]) from public;
revoke execute on function retrieval.bump_band_version() from public;
grant execute on function retrieval.slot_bands(uuid, uuid[]) to kf_app, kf_worker;

-- migrate:down

drop trigger if exists object_band_version_delete on core.object;
drop trigger if exists object_band_version_update on core.object;
drop trigger if exists object_band_version_insert on core.object;
drop function if exists retrieval.slot_bands(uuid, uuid[]);
drop function if exists retrieval.bump_band_version();
drop table if exists retrieval.band_version;
drop schema if exists retrieval;
