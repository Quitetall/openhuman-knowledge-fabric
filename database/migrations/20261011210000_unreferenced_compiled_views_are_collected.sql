-- migrate:up

-- The views a refused compilation materialized are collected like orphaned evidence (SAS §100.64,
-- KF-SAS-RQ-094, RQ-102).
--
-- THE GAP. The compiler runtime writes each view to the working store under its content address,
-- `compiled-views/sha256/<digest>`, and only then asks the database to record the run. A run the
-- database refuses as not reproducing an earlier one (KF-DOC-DETERMINISM-001) is recorded as
-- failed with no views, so the bytes it wrote stay in the store under a key no artifact version
-- or location names — as does a view whose run crashed between the put and the record. RQ-094
-- says a failed act leaves no unreferenced content in a store; the evidence prefixes were met by
-- `kf-storage --collect-orphans` and its record, `content.orphan_collection` (20260924000400).
-- This extends the same sweep, the same record and the same rules to the compiled-view prefix.
--
-- WHAT IS DIFFERENT ABOUT THIS PREFIX, and what the three functions below are for.
--
--   * It is not an organization's. A view's key is its digest alone, so two organizations that
--     compile the same bytes share one key. The evidence sweep's reference check runs under the
--     collector's row security, which would see another organization's reference as no reference.
--     `content.claim_unreferenced_compiled_view` answers across organizations, as a definer, and
--     answers only "referenced or not" for a key in this one prefix, only to a bound service
--     actor (ADR 0020).
--
--   * An old key can be adopted. The runtime reuses an existing key rather than writing it again
--     (create-only, §49), so a compilation in flight can adopt a view a refused run left years
--     ago, and the evidence sweep's grace period — the key's age — does not cover it. Both sides
--     therefore take one lock per key, `content.lock_stored_key`: the sweep from its reference
--     check through the delete to its record, in one transaction; the runtime in the transaction
--     that records the run, where it re-reads every view's bytes at the recorded version before
--     recording it. Whichever is second sees what the first did: a sweep that waited finds the
--     key referenced and keeps it; a runtime that waited finds its version gone, records nothing,
--     and is retried, writing the view again.
--
--   * What a collection keeps. The bytes go; `content.orphan_collection` keeps the key and the
--     digest it names, when, by whom and why, in the preservation export as before. The refused
--     run itself keeps its failure, the run it did not reproduce, and that run's own views.
--
-- NOT COLLECTED, by construction: any key an artifact version or location names, in any
-- organization (a compiled view is recorded as an artifact version, so its retention, its legal
-- holds — on the record, `core.retention_hold` — its durable and public copies, its exports and
-- its backups all hang off a reference this check sees); and anything outside
-- `compiled-views/sha256/<64 hex>`. The durable store is not swept: it is written only by
-- replication, which copies recorded versions.

-- One lock per stored key, held to the end of the transaction. Shared by the sweep and the
-- compiler runtime so the key derivation exists once.
create function content.lock_stored_key(p_key text) returns void
language sql
volatile
set search_path = pg_catalog
as $$
  select pg_advisory_xact_lock(hashtextextended('kf:stored-key:v1:' || p_key, 0))
$$;

comment on function content.lock_stored_key(text) is
  'SAS §100.64: the transaction-scoped lock the storage sweep and the compiler runtime both take '
  'on an object-store key before deciding whether it is referenced (20261011210000).';

revoke all on function content.lock_stored_key(text) from public;
grant execute on function content.lock_stored_key(text) to kf_app, kf_worker;

-- The bound principal is a declared service actor of the bound organization (ADR 0020).
create function content.require_bound_service_actor() returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_principal text := core.sealed_setting('kf.principal', true);
  v_org       text := core.sealed_setting('kf.principal_organization', true);
begin
  if v_principal is null or v_org is null then
    raise exception 'collecting orphaned bytes needs the service actor bound as the principal'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from org.person p
                  where p.id = v_principal::uuid
                    and p.organization = v_org::uuid
                    and p.person_kind = 'service') then
    raise exception 'only a declared service actor collects orphaned bytes (ADR 0020)'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

revoke all on function content.require_bound_service_actor() from public;

-- A compiled-view key nothing references, in any organization. Locks the key first.
create function content.claim_unreferenced_compiled_view(p_key text) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, content
as $$
begin
  perform content.require_bound_service_actor();
  if p_key is null or p_key !~ '^compiled-views/sha256/[0-9a-f]{64}$' then
    raise exception 'key % is not a compiled view''s content address', p_key
      using errcode = 'insufficient_privilege';
  end if;
  perform content.lock_stored_key(p_key);
  return not exists (select 1 from content.artifact_version v where v.storage_uri = p_key)
     and not exists (select 1 from content.artifact_location l where l.uri = p_key);
end
$$;

comment on function content.claim_unreferenced_compiled_view(text) is
  'SAS §100.64: lock a compiled-view key and say whether no artifact version or location in any '
  'organization names it; for a bound service actor only (20261011210000).';

revoke all on function content.claim_unreferenced_compiled_view(text) from public;
grant execute on function content.claim_unreferenced_compiled_view(text) to kf_app;

-- The record, now for either kind of orphan. The evidence branch is unchanged; a compiled-view
-- key is recorded only while it is still unreferenced, under the lock its claim took.
create or replace function content.record_orphan_collection(
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
  v_principal text;
  v_org       text;
  v_digest    text;
  v_id        uuid;
begin
  perform content.require_bound_service_actor();
  v_principal := core.sealed_setting('kf.principal', true);
  v_org := core.sealed_setting('kf.principal_organization', true);
  if p_storage_key ~ '^compiled-views/sha256/[0-9a-f]{64}$' then
    if not content.claim_unreferenced_compiled_view(p_storage_key) then
      raise exception 'compiled view % is referenced; it is not an orphan', p_storage_key
        using errcode = 'integrity_constraint_violation';
    end if;
  elsif p_storage_key !~ ('^(ingest|document-imports)/' || v_org || '/[^/]+$') then
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

-- The reference checks above, and the evidence sweep's, look a key up by value.
create index artifact_version_by_storage_uri on content.artifact_version (storage_uri);
create index artifact_location_by_uri on content.artifact_location (uri);

-- migrate:down

drop index content.artifact_location_by_uri;
drop index content.artifact_version_by_storage_uri;

create or replace function content.record_orphan_collection(
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

drop function content.claim_unreferenced_compiled_view(text);
drop function content.require_bound_service_actor();
drop function content.lock_stored_key(text);
