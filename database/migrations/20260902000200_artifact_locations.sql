-- migrate:up

-- ADR 0017. Where the bytes of an artifact version are is a set of LOCATIONS, each in a
-- declared STORE with a declared ROLE, each verifiable on its own — not one column. Until
-- now `content.artifact_version.storage_uri/storage_version` named exactly one place, the
-- working store; a durable second copy, an evidence copy for an auditor, or a public copy
-- had no row to exist in, so none could be recorded or verified.
--
-- The columns stay. `artifact_version` is append-only, so they are written once, and the
-- trigger below records the SAME address as the version's `working` location at that moment;
-- a second trigger refuses a working location that disagrees with them. The columns are the
-- working row, read through the old names — the compatibility view, on a table that cannot
-- carry a view.

create table content.artifact_store (
  id          text primary key check (id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  -- What talks to it. `object_store` is any S3-wire store: the instance's own, or Google
  -- Cloud Storage through its S3 interoperability endpoint — the client is the same.
  kind        text not null check (kind in ('object_store', 'memory')),
  -- A name, never a URI with credentials in it. Read by every read role in the system.
  label       text not null check (length(btrim(label)) > 0),
  writable    boolean not null default true,
  declared_at timestamptz not null default now(),
  notes       text
);

comment on table content.artifact_store is
  'Declared places bytes may live. Credentials are instance configuration, never rows.';

create table content.artifact_location (
  id                   uuid primary key default uuidv7(),
  version_id           uuid not null references content.artifact_version (id) on delete restrict,
  store_id             text not null references content.artifact_store (id) on delete restrict,
  -- working:       where the instance reads and writes; exactly one per version.
  -- hot_cache:     a copy the instance may drop at will.
  -- durable_copy:  a copy in a second failure domain, kept as long as the version.
  -- evidence_copy: a copy handed to an auditor or regulator; its digest is the receipt.
  -- public_copy:   a copy outside the product-instance boundary. Allowed by the schema so
  --                a publication act has a row to make; NOTHING writes it until that act
  --                exists (ADR 0017 defers the publication boundary).
  role                 text not null
    check (role in ('working', 'hot_cache', 'durable_copy', 'evidence_copy', 'public_copy')),
  uri                  text not null check (length(btrim(uri)) > 0),
  -- The store's immutable version of the object, where the store has one. A location
  -- without it cannot be verified as THE bytes, only as SOME bytes at that address.
  store_version        text,
  recorded_at          timestamptz not null default now(),
  recorded_by          uuid references org.person (id) on delete restrict,
  recorded_by_action   uuid references core.action (id) on delete restrict,
  -- Verification is re-hashing the bytes at this location against the version's sha256.
  -- Both outcomes are recorded; a failed verification is the finding, not an absence.
  verified_at          timestamptz,
  verified_sha256      text check (verified_sha256 ~ '^[0-9a-f]{64}$'),
  verification_failure text,
  verified_by_action   uuid references core.action (id) on delete restrict,
  constraint artifact_location_verification_complete check (
    (verified_at is null and verified_sha256 is null and verification_failure is null)
    or (verified_at is not null and (verified_sha256 is not null or verification_failure is not null))
  ),
  unique (version_id, store_id, role)
);

create unique index artifact_location_one_working
  on content.artifact_location (version_id) where (role = 'working');
create index artifact_location_by_version on content.artifact_location (version_id, role);

comment on table content.artifact_location is
  'Every place a version''s bytes are, with role and last verification. The working row mirrors artifact_version.storage_uri.';

-- The instance's own store. Its endpoint and credentials are configuration (S3_* env); the
-- row is the name the rest of the ledger refers to.
insert into content.artifact_store (id, kind, label, notes)
values ('working', 'object_store', 'Instance object store (S3_* configuration)',
        'Declared by migration 20260902000200; every pre-existing version''s bytes are here.');

-- Every version already recorded with an address gets its working location.
insert into content.artifact_location (version_id, store_id, role, uri, store_version, recorded_at)
select v.id, 'working', 'working', v.storage_uri, v.storage_version, v.created_at
  from content.artifact_version v
 where v.storage_uri is not null;

-- A new version with an address gets its working location in the same statement.
create or replace function content.artifact_version_working_location() returns trigger
language plpgsql
set search_path = pg_catalog, content
as $$
begin
  if new.storage_uri is not null then
    insert into content.artifact_location
      (version_id, store_id, role, uri, store_version, recorded_at, recorded_by,
       recorded_by_action)
    values (new.id, 'working', 'working', new.storage_uri, new.storage_version,
            new.created_at, new.created_by, new.created_by_action);
  end if;
  return new;
end;
$$;

create trigger artifact_version_working_location
  after insert on content.artifact_version
  for each row execute function content.artifact_version_working_location();

-- A working location must say what the version says; any other role may only ever have its
-- verification columns change. Deleting a location is a different act from deleting bytes.
create or replace function content.artifact_location_guard() returns trigger
language plpgsql
set search_path = pg_catalog, content
as $$
declare
  v_uri text;
  v_version text;
begin
  if tg_op = 'DELETE' then
    raise exception 'artifact locations are append-only; a lost copy is recorded by a failed verification'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'UPDATE' and (
       new.version_id <> old.version_id or new.store_id <> old.store_id or new.role <> old.role
       or new.uri <> old.uri or new.store_version is distinct from old.store_version
       or new.recorded_at <> old.recorded_at or new.recorded_by is distinct from old.recorded_by
       or new.recorded_by_action is distinct from old.recorded_by_action) then
    raise exception 'only the verification of an artifact location may change'
      using errcode = 'check_violation';
  end if;
  if new.role = 'working' then
    select storage_uri, storage_version into v_uri, v_version
      from content.artifact_version where id = new.version_id;
    if v_uri is distinct from new.uri or v_version is distinct from new.store_version then
      raise exception 'working location for version % must match artifact_version.storage_uri/storage_version',
        new.version_id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger artifact_location_guard
  before insert or update or delete on content.artifact_location
  for each row execute function content.artifact_location_guard();

alter table content.artifact_store enable row level security;
alter table content.artifact_store force row level security;
create policy artifact_store_read on content.artifact_store for select using (true);
create policy artifact_store_write on content.artifact_store for insert with check (true);

alter table content.artifact_location enable row level security;
alter table content.artifact_location force row level security;
create policy artifact_location_scoped_read on content.artifact_location for select using (
  exists (select 1 from content.artifact_version parent where parent.id = artifact_location.version_id)
);
create policy artifact_location_scoped_insert on content.artifact_location for insert with check (
  exists (select 1 from content.artifact_version parent where parent.id = artifact_location.version_id)
);
create policy artifact_location_scoped_verify on content.artifact_location for update using (
  exists (select 1 from content.artifact_version parent where parent.id = artifact_location.version_id)
) with check (
  exists (select 1 from content.artifact_version parent where parent.id = artifact_location.version_id)
);
create policy artifact_store_backup_read on content.artifact_store for select to kf_backup using (true);
create policy artifact_location_backup_read on content.artifact_location for select to kf_backup using (true);

grant select on content.artifact_store, content.artifact_location
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on content.artifact_store, content.artifact_location to kf_app;
grant update on content.artifact_location to kf_app;

-- migrate:down

drop policy artifact_location_backup_read on content.artifact_location;
drop policy artifact_store_backup_read on content.artifact_store;
drop policy artifact_location_scoped_verify on content.artifact_location;
drop policy artifact_location_scoped_insert on content.artifact_location;
drop policy artifact_location_scoped_read on content.artifact_location;
drop policy artifact_store_write on content.artifact_store;
drop policy artifact_store_read on content.artifact_store;
drop trigger artifact_location_guard on content.artifact_location;
drop function content.artifact_location_guard();
drop trigger artifact_version_working_location on content.artifact_version;
drop function content.artifact_version_working_location();
drop table content.artifact_location;
drop table content.artifact_store;
