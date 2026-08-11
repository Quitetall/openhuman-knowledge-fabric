-- migrate:up

-- The content schema: artifacts and their versions.
--
-- An Artifact is a logical output — "the Atlas enclosure CAD assembly". An Artifact Version
-- is one immutable set of bytes, or one pinned revision in a system that owns them. The
-- split matters: a decision cites a VERSION, never an artifact, because "we approved the
-- enclosure drawing" is meaningless if the drawing can change afterwards.
--
-- PostgreSQL holds identity, digest, provenance, classification and location. The object
-- store holds the bytes. Neither is a copy of the other.

create table content.artifact (
  id            uuid primary key references core.object (id) on delete restrict,
  -- What kind of thing this is, for retrieval and for knowing which tool opens it.
  artifact_kind text not null check (artifact_kind in (
    'cad_assembly', 'cad_part', 'drawing', 'schematic', 'pcb_layout', 'firmware_build',
    'source_archive', 'dataset', 'report', 'specification', 'photograph', 'measurement',
    'certificate', 'invoice_evidence', 'correspondence', 'other'
  )),
  -- The system that owns the bytes. `object_store` means we do; anything else means we hold
  -- a reference and the digest, and the other system can change underneath us — which is
  -- precisely why the digest is recorded.
  source_system text not null check (source_system in (
    'object_store', 'git', 'cad_pdm', 'document_system', 'accounting', 'external'
  ))
);

create table content.artifact_version (
  id              uuid primary key default uuidv7(),
  artifact_id     uuid not null references content.artifact (id) on delete restrict,
  -- Monotonic within the artifact. Not a semantic revision — that is `revision_label`.
  version_no      integer not null check (version_no > 0),
  -- The human-facing revision this corresponds to, when the owning system has one: a git
  -- commit, a PDM revision, "Rev 3.0".
  revision_label  text,

  -- Content identity. SHA-256 because that is what an auditor expects and what the rest of
  -- the QMS already uses.
  sha256          text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes      bigint not null check (size_bytes >= 0),
  media_type      text not null,

  -- Where the bytes are. A VERSION-addressed URI where the store provides one: an
  -- unversioned key can be overwritten, and then the digest recorded here would no longer
  -- describe what is at that address.
  storage_uri     text,
  storage_version text,

  created_at      timestamptz not null default now(),
  created_by      uuid not null,
  -- The action that produced this version, so provenance points at an authority and not
  -- just at a timestamp.
  created_by_action uuid references core.action (id),

  unique (artifact_id, version_no),
  -- The same bytes may legitimately appear as versions of DIFFERENT artifacts (a datasheet
  -- filed under two components), but not twice under one: that would be a duplicate record
  -- of a single fact.
  unique (artifact_id, sha256),

  -- A version with no location and no digest describes nothing. Bytes we hold must say
  -- where; bytes another system holds must still say what they were when we saw them.
  constraint artifact_version_locatable check (storage_uri is not null or revision_label is not null)
);

create index artifact_version_by_artifact on content.artifact_version (artifact_id, version_no desc);
create index artifact_version_by_digest on content.artifact_version (sha256);

-- Where a version came from, or what it was derived from. Kept separate from core.relation
-- because these are content-level facts that do not need an authorizing action.
create table content.artifact_relationship (
  id              uuid primary key default uuidv7(),
  from_version    uuid not null references content.artifact_version (id) on delete restrict,
  to_version      uuid not null references content.artifact_version (id) on delete restrict,
  relationship    text not null check (relationship in ('derived_from', 'supersedes', 'accompanies')),
  created_at      timestamptz not null default now(),
  constraint artifact_relationship_not_self check (from_version <> to_version)
);

-- A reference to a record in a system we do not own.
create table content.external_locator (
  id          uuid primary key default uuidv7(),
  version_id  uuid not null references content.artifact_version (id) on delete restrict,
  system      text not null check (length(btrim(system)) > 0),
  external_id text not null check (length(btrim(external_id)) > 0),
  uri         text,
  -- WHY we hold it. A mirror must never be mistaken for the authoritative copy.
  authority   text not null check (authority in ('authoritative', 'evidence', 'mirror', 'lookup')),
  synced_at   timestamptz,
  unique (version_id, system, external_id)
);

-- ── immutability ────────────────────────────────────────────────────────────────────────

-- An artifact version is a statement that a specific set of bytes existed and was used. It
-- is never edited: a correction is a new version, and supersession is a relationship.
create trigger artifact_version_append_only
  before update or delete or truncate on content.artifact_version
  for each statement execute function core.refuse_mutation();

create trigger artifact_relationship_append_only
  before update or delete or truncate on content.artifact_relationship
  for each statement execute function core.refuse_mutation();

-- Artifacts themselves are controlled records like any other.
create trigger artifact_guard_1_context
  before insert or update on content.artifact
  for each row execute function core.require_transaction_context();

/*
 * Version numbers are assigned by the database, not by the caller.
 *
 * Two concurrent uploads that each read "the latest is 3" would both write 4, and one would
 * lose to the unique constraint after doing all the work. Taking the number under a lock
 * here means the second waits and gets 5.
 */
create or replace function content.next_version_no(p_artifact uuid) returns integer
language plpgsql
as $$
declare v_next integer;
begin
  -- Lock the artifact row so concurrent uploads serialize on it.
  perform 1 from content.artifact where id = p_artifact for update;
  select coalesce(max(version_no), 0) + 1 into v_next
    from content.artifact_version where artifact_id = p_artifact;
  return v_next;
end
$$;

grant select on all tables in schema content to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on content.artifact, content.artifact_version,
                 content.artifact_relationship, content.external_locator to kf_app;
grant update on content.artifact to kf_app;
grant usage, select on all sequences in schema content to kf_app, kf_worker;
grant execute on function content.next_version_no(uuid) to kf_app;

comment on table content.artifact_version is
  'One immutable set of bytes, or one pinned revision elsewhere. A decision cites a VERSION '
  'and never an artifact: "we approved the drawing" means nothing if the drawing can change.';
comment on column content.artifact_version.storage_version is
  'The object store version id. An unversioned key can be overwritten, after which the '
  'digest recorded here no longer describes what is at that address.';

-- migrate:down

drop function if exists content.next_version_no(uuid);
drop table if exists content.external_locator;
drop table if exists content.artifact_relationship;
drop table if exists content.artifact_version;
drop table if exists content.artifact;
