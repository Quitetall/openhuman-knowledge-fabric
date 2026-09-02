-- migrate:up

-- ADR 0013. A master record's identity is its CORPUS — the exact authorized set of
-- (object, type, content digest, classification, state) — and nothing else.
--
-- Until now the unique key was (person, organization, permission_digest), and that digest
-- already hashed member content, so it was a corpus digest under the wrong name. What it did
-- not cover was sectioning: `your_record` versus `org_view` is decided by the relevance closure
-- over core.relation, which ADR 0011 already calls "presentation partitions, never membership
-- filters" — yet the runtime wrote those sections into the manifest and into
-- master_record_item.section, and the read surface computed staleness from the permission
-- digest alone. Measured 2026-08-28: one relation edge changed a person's sectioning without
-- changing their corpus, recompilation collided on the unique key and surfaced as
-- `500 internal_error`, and GET /master-record kept serving the old sectioning with
-- `stale: false`.
--
-- After this migration:
--   * corpus_digest is the identity; the same corpus compiled twice is ONE record (the
--     repository replays it rather than inserting), and a changed corpus is a new record.
--   * permission_digest is redefined as the ACCESS fact — which object ids, under which
--     ceiling — so a changed corpus can be explained as "access changed" or "content drifted".
--   * both digests are recomputed by the database from the manifest and CHECKed, so a stored
--     identity cannot disagree with the claim it identifies.
--   * sections leave the manifest and the item table. They are derived at read time from the
--     current relation graph, which is what makes a new edge visible without recompiling.
--
-- The digests are line-canonical rather than JCS on purpose: PostgreSQL can recompute them.
-- Lines are joined with a newline, fields with the unit separator (0x1F — text may not carry
-- NUL), and sorted in "C" collation, which the TypeScript side matches with code-unit order.

create or replace function content.master_record_corpus_digest(p_manifest jsonb)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select encode(
    sha256(convert_to(coalesce(string_agg(line, E'\n' order by line collate "C"), ''), 'UTF8')),
    'hex'
  )
  from (
    select (member ->> 'objectId') || chr(31) || (member ->> 'objectType') || chr(31)
        || (member ->> 'contentDigest') || chr(31) || (member ->> 'classification') || chr(31)
        || 'included' as line
      from jsonb_array_elements(coalesce(p_manifest -> 'included', '[]'::jsonb)) member
    union all
    select (member ->> 'objectId') || chr(31) || (member ->> 'objectType') || chr(31)
        || (member ->> 'contentDigest') || chr(31) || (member ->> 'classification') || chr(31)
        || 'withdrawn'
      from jsonb_array_elements(coalesce(p_manifest -> 'withdrawn', '[]'::jsonb)) member
  ) lines
$$;

create or replace function content.master_record_permission_digest(p_manifest jsonb, p_ceiling text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select encode(
    sha256(convert_to(coalesce(string_agg(line, E'\n' order by line collate "C"), ''), 'UTF8')),
    'hex'
  )
  from (
    select 'ceiling' || chr(31) || p_ceiling as line
    union all
    select 'object' || chr(31) || (member ->> 'objectId')
      from jsonb_array_elements(coalesce(p_manifest -> 'included', '[]'::jsonb)) member
  ) lines
$$;

revoke all on function content.master_record_corpus_digest(jsonb) from public;
revoke all on function content.master_record_permission_digest(jsonb, text) from public;
grant execute on function content.master_record_corpus_digest(jsonb) to kf_app, kf_readonly, kf_auditor;
grant execute on function content.master_record_permission_digest(jsonb, text) to kf_app, kf_readonly, kf_auditor;

alter table content.master_record
  add column corpus_digest text check (corpus_digest ~ '^[0-9a-f]{64}$');

-- Existing claims keep their manifests and record_digest untouched; only the two identity
-- columns are recomputed under the new definitions. Every row already has the manifest fields
-- both functions read. The table is append-only by trigger, and rightly: this is the one
-- write that is a re-derivation of what each row already says rather than a change to it, so
-- the guard is lifted for exactly this statement and restored — the same shape
-- 20260814001900 used on core.action.
alter table content.master_record disable trigger master_record_append_only;
update content.master_record
   set corpus_digest = content.master_record_corpus_digest(manifest),
       permission_digest = content.master_record_permission_digest(manifest, effective_classification);
alter table content.master_record enable trigger master_record_append_only;

alter table content.master_record
  alter column corpus_digest set not null,
  drop constraint master_record_person_id_organization_id_permission_digest_key,
  add constraint master_record_corpus_identity unique (person_id, organization_id, corpus_digest),
  add constraint master_record_corpus_digest_matches_manifest
    check (corpus_digest = content.master_record_corpus_digest(manifest)),
  add constraint master_record_permission_digest_matches_manifest
    check (permission_digest = content.master_record_permission_digest(manifest, effective_classification)),
  -- A v2 manifest carries its own identity and must agree with the row. v1 manifests predate
  -- the field; they are identified by the recomputed column alone.
  add constraint master_record_manifest_carries_identity
    check (
      (manifest ->> 'format') = 'kf-master-record-v1'
      or (manifest ->> 'corpusDigest') = corpus_digest
    );

comment on column content.master_record.corpus_digest is
  'Identity of the claim: the exact authorized corpus. Same digest, same record. ADR 0013.';
comment on column content.master_record.permission_digest is
  'The access fact behind the corpus: object ids under the effective ceiling. Explains why a corpus changed; is not its identity. ADR 0013.';

-- Sections leave the item table. The insert policy bound section to manifest.sections, so it
-- goes first; the state-shape CHECK names the column, so it goes next; then the column.
drop policy master_record_item_insert on content.master_record_item;
drop index content.master_record_item_section;
alter table content.master_record_item
  drop constraint master_record_item_state_shape,
  drop column section,
  add constraint master_record_item_state_shape check (
    (item_state = 'included' and withdrawn_at is null and withdrawal_reason is null)
    or
    (item_state = 'withdrawn' and withdrawn_at is not null and withdrawal_reason is not null
      and length(btrim(withdrawal_reason)) > 0)
  );
create index master_record_item_by_type
  on content.master_record_item (master_record_id, object_type, object_id);

create policy master_record_item_insert on content.master_record_item
  for insert with check (exists (
    select 1 from content.master_record master
     where master.id = master_record_item.master_record_id
       and master.recorded_by = core.current_actor()
       and master.recorded_by_action = core.current_action_id()
       and not exists (
         select 1 from core.audit_event event where event.action_id = master.recorded_by_action
       )
       and (
         (master_record_item.item_state = 'included'
          and exists (
            select 1
              from jsonb_array_elements(master.manifest -> 'included') member
             where member ->> 'objectId' = master_record_item.object_id::text
               and member ->> 'objectType' = master_record_item.object_type
               and member ->> 'contentDigest' = master_record_item.content_digest
               and coalesce(member -> 'content', '{}'::jsonb) = master_record_item.content_payload
          ))
         or
         (master_record_item.item_state = 'withdrawn'
          and exists (
            select 1
              from jsonb_array_elements(master.manifest -> 'withdrawn') member
             where member ->> 'objectId' = master_record_item.object_id::text
               and member ->> 'objectType' = master_record_item.object_type
               and member ->> 'contentDigest' = master_record_item.content_digest
               and coalesce(member -> 'content', '{}'::jsonb) = master_record_item.content_payload
          ))
       )
  ));

-- migrate:down
-- kf:forward-only the old key made a relevance-only change unrepresentable and the dropped section column was never authoritative; restoring either would reintroduce the 500 and re-assert presentation as identity

-- Forward-only. Reverting would restore a unique key under which a relevance-only change
-- cannot be recompiled, and would re-add a section column that ADR 0011 already said was
-- presentation rather than membership.
