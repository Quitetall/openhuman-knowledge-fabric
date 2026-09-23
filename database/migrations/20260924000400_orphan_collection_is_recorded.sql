-- migrate:up

-- Collecting orphaned evidence bytes leaves a record, not only a journal line.
--
-- `kf-storage --collect-orphans` deletes object-store keys under an organization's evidence
-- prefixes that no artifact version or location references (apps/kf-storage/src/orphans.ts).
-- ADR 0020 says every kf-storage write is a typed action by its service actor; this one was the
-- exception, recorded only as the key list in the run's journal line — which rotates, lives on
-- one host, and is in no backup. Threat model T2 listed it as an accepted gap.
--
-- It is not an ACT, and this does not pretend it is: an act is on a record, and an orphan is
-- bytes no record points at — that is what makes it one. So the fact gets its own append-only
-- table, written in the same run as the delete, by the service actor the run is bound as, and
-- carried in preservation exports like every other ledger.
--
-- WRITTEN THROUGH ONE SEAM. No role may insert here directly. `content.record_orphan_collection`
-- is SECURITY DEFINER and takes who and where from the sealed principal, not from its
-- arguments: the collector is the bound person, the organization the bound one, and the person
-- must be a declared service actor there (ADR 0020 — a human does not collect at 03:30). The key
-- must lie under that organization's evidence prefixes, the only ones the sweep lists. The
-- digest is not the caller's to state either: an evidence key ends in the sha256 of its bytes
-- (`evidenceStorageKey` in @kf/documents), and the database reads it from there.

create table content.orphan_collection (
  id               uuid primary key default uuidv7(),
  organization_id  uuid not null references org.organization (id) on delete restrict,
  store_id         text not null references content.artifact_store (id) on delete restrict,
  storage_key      text not null check (length(storage_key) between 1 and 1024),
  -- The digest the key names, when it names one. NULL for a key that does not end in one; the
  -- sweep lists only evidence prefixes, whose keys all do, but the column says what it knows.
  sha256           text check (sha256 ~ '^[0-9a-f]{64}$'),
  versions_removed integer not null check (versions_removed >= 0),
  collected_at     timestamptz not null default now(),
  collected_by     uuid not null references org.person (id) on delete restrict,
  reason           text not null check (length(btrim(reason)) >= 8)
);

comment on table content.orphan_collection is
  'Every object-store key the storage sweep deleted because no record referenced it: which key, '
  'in which store, the digest it named, how many versions went, when, by which service actor, and '
  'why. Append-only. The bytes are gone; this is what says so.';

create index orphan_collection_by_key on content.orphan_collection (storage_key);

alter table content.orphan_collection enable row level security;
alter table content.orphan_collection force row level security;

-- Readers: the auditor and the backup login, across organizations, as for the ledger; and a
-- session bound in the organization, for its own.
create policy orphan_collection_auditor_read on content.orphan_collection
  for select to kf_auditor using (true);
create policy orphan_collection_backup_read on content.orphan_collection
  for select to kf_backup using (true);
create policy orphan_collection_scoped_read on content.orphan_collection
  for select to kf_app, kf_worker
  using (organization_id = (select core.current_organization()));

grant select on content.orphan_collection to kf_app, kf_worker, kf_auditor, kf_backup;

create function content.refuse_orphan_collection_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'content.orphan_collection is append-only; % is not permitted', tg_op
    using errcode = 'insufficient_privilege',
          hint = 'A collection happened or it did not; there is nothing to correct afterwards.';
end
$$;

create trigger orphan_collection_append_only
  before update or delete or truncate on content.orphan_collection
  for each statement execute function content.refuse_orphan_collection_mutation();

create function content.record_orphan_collection(
  p_store_id text,
  p_storage_key text,
  p_versions_removed integer,
  p_reason text
) returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org, content
as $$
declare
  v_principal text := core.sealed_setting('kf.principal', true);
  v_org       text := core.sealed_setting('kf.principal_organization', true);
  v_digest    text;
  v_id        uuid;
begin
  if v_principal is null or v_org is null then
    raise exception 'recording an orphan collection needs the service actor bound as the principal'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from org.person p
                  where p.id = v_principal::uuid
                    and p.organization = v_org::uuid
                    and p.person_kind = 'service') then
    raise exception 'only a declared service actor collects orphaned bytes (ADR 0020)'
      using errcode = 'insufficient_privilege';
  end if;
  if p_storage_key !~ ('^(ingest|document-imports)/' || v_org || '/[^/]+$') then
    raise exception 'key % is not under this organization''s evidence prefixes', p_storage_key
      using errcode = 'insufficient_privilege';
  end if;
  v_digest := substring(p_storage_key from '/([0-9a-f]{64})$');

  insert into content.orphan_collection
    (organization_id, store_id, storage_key, sha256, versions_removed, collected_by, reason)
  values (v_org::uuid, p_store_id, p_storage_key, v_digest, p_versions_removed,
          v_principal::uuid, p_reason)
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function content.record_orphan_collection(text, text, integer, text) from public;
grant execute on function content.record_orphan_collection(text, text, integer, text) to kf_app;

-- migrate:down

drop function content.record_orphan_collection(text, text, integer, text);
drop trigger orphan_collection_append_only on content.orphan_collection;
drop function content.refuse_orphan_collection_mutation();
drop table content.orphan_collection;
