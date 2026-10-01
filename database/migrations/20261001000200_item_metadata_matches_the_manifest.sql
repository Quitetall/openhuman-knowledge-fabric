-- migrate:up

-- Item-backed projections must carry the immutable claim's title and classification too.
-- The preceding set check covered type, digest and payload but accepted contradictory metadata.
-- Refuse pre-existing contradictions rather than rewriting either side of a preserved claim.
do $$
begin
  if exists (
    select 1 from (
      select item.master_record_id, item.item_state, item.object_id::text as object_id,
             item.object_type, item.title, item.classification
        from content.master_record_item item
      except
      select master.id, state.name, member ->> 'objectId', member ->> 'objectType',
             coalesce(member ->> 'title', member ->> 'objectType'), member ->> 'classification'
        from content.master_record master
       cross join (values ('included'), ('withdrawn')) as state(name)
       cross join lateral jsonb_array_elements(master.manifest -> state.name) as member
    ) contradictory
  ) then
    raise exception 'existing master-record item metadata contradicts its manifest'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

create or replace function content.master_record_item_matches_manifest() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_stray record;
begin
  -- One expansion per affected claim per statement, retaining the linear set check.
  select stray.* into v_stray
    from (
      select item.master_record_id, item.item_state, item.object_id::text as object_id,
             item.object_type, item.title, item.classification, item.content_digest, item.content_payload
        from inserted item
      except
      select master.id, state.name, member ->> 'objectId', member ->> 'objectType',
             coalesce(member ->> 'title', member ->> 'objectType'), member ->> 'classification',
             member ->> 'contentDigest', coalesce(member -> 'content', '{}'::jsonb)
        from (select distinct inserted.master_record_id from inserted) claims
        join content.master_record master on master.id = claims.master_record_id
       cross join (values ('included'), ('withdrawn')) as state(name)
       cross join lateral jsonb_array_elements(master.manifest -> state.name) as member
    ) as stray
   limit 1;
  if found then
    raise exception 'master record item % (%) is not a member of the manifest of claim %',
      v_stray.object_id, v_stray.item_state, v_stray.master_record_id
      using errcode = 'insufficient_privilege',
            hint = 'An item must reproduce its claim''s title, classification, type, digest and payload.';
  end if;
  return null;
end
$$;

revoke all on function content.master_record_item_matches_manifest() from public;
comment on function content.master_record_item_matches_manifest() is
  'Refuses items contradicting their immutable manifest in state, object, type, title, '
  'classification, content digest or payload. Once per statement over its transition table.';

-- migrate:down
-- kf:forward-only Restoring the incomplete item check would weaken immutable-claim integrity and permit contradictory title/classification in item-backed projections.
