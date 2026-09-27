-- migrate:up

-- A master-record item is checked against its manifest once per statement, not once per row.
--
-- THE DEFECT. `master_record_item_insert` (20260901000100) required every inserted item to match
-- a member of its claim's manifest, and said so row by row: for EACH item the policy fetched the
-- claim, detoasted `manifest`, and walked `jsonb_array_elements(manifest -> 'included')` until it
-- found the item. A manifest carries every member with its payload, so the cost of one item grows
-- with the corpus and the cost of compiling grows with its square. Measured on the kf-fixa
-- fixture (2026-09-26), for a reader who may see the ~50 000 records of one organization: the
-- refresh POST of an Object View was still inserting items after 13 minutes, each insert taking
-- one to three seconds, every one of them waiting on BufFileWrite while it expanded the manifest
-- again. The request's client had given up at 300 s. A compilation that cannot finish is a master
-- record nobody at that scale can have, and so an Object View nobody at that scale can read.
--
-- THE FIX. The same predicate, evaluated once per statement over the rows the statement wrote:
--
--   * the policy keeps what is cheap and per row — the claim exists, was recorded by the bound
--     actor under the bound act, and that act is not yet sealed into the audit chain;
--   * `master_record_item_matches_manifest`, an AFTER INSERT ... FOR EACH STATEMENT trigger with
--     the statement's new rows as a transition table, expands each claim's manifest ONCE and
--     refuses the statement if any new item is not a member of it — same object, type, content
--     digest and payload, in the state the item names. A set difference, so the whole check is
--     linear in the corpus.
--
-- The guarantee is unchanged: no item exists that its claim's manifest does not list, in the same
-- transaction, for every writer the policy bound. It is now also held for writers the policy did
-- not bind (the owner), which is stricter. The preservation import disables USER triggers while it
-- loads a verified export (packages/export, `setUserTriggers`), as it does for every other trigger
-- on these tables. The compiler now writes a claim's items in one statement, derived from the
-- stored manifest (packages/documents, `compileAndRecordMasterRecord`), so a compilation expands
-- its manifest once for the check instead of once per member.

drop policy master_record_item_insert on content.master_record_item;

create policy master_record_item_insert on content.master_record_item
  for insert with check (exists (
    select 1 from content.master_record master
     where master.id = master_record_item.master_record_id
       and master.recorded_by = (select core.current_actor())
       and master.recorded_by_action = (select core.current_action_id())
       and not exists (
         select 1 from core.audit_event event where event.action_id = master.recorded_by_action
       )
  ));

create function content.master_record_item_matches_manifest() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  v_stray record;
begin
  -- Every claim this statement wrote items for, its manifest expanded once, and the new items that
  -- are not among its members: a set difference, which PostgreSQL hashes or sorts. (Written as a
  -- NOT EXISTS the planner guessed a hundred members per manifest — what it assumes of any
  -- set-returning function — and chose a nested loop: 50 000 items against 50 000 members, which
  -- ran past the statement timeout on kf-fixa.) Read under the writer's own row security, as the
  -- policy read it: a claim the writer cannot see lists nothing, and every item for it is refused.
  select stray.* into v_stray
    from (
      select item.master_record_id, item.item_state, item.object_id::text as object_id,
             item.object_type, item.content_digest, item.content_payload
        from inserted item
      except
      select master.id, state.name, member ->> 'objectId', member ->> 'objectType',
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
            hint = 'A master-record item is written from its claim''s manifest and nothing else.';
  end if;
  return null;
end
$$;

revoke all on function content.master_record_item_matches_manifest() from public;

create trigger master_record_item_matches_manifest
  after insert on content.master_record_item
  referencing new table as inserted
  for each statement execute function content.master_record_item_matches_manifest();

comment on function content.master_record_item_matches_manifest() is
  'Refuses a statement that wrote a master-record item its claim''s manifest does not list, in the '
  'state, type, content digest and payload the item names. Once per statement over the new rows '
  '(20260926110000); it replaced a per-row policy predicate that made compiling quadratic.';

-- migrate:down
-- kf:forward-only restoring the per-row predicate makes compiling a large corpus quadratic again; the guarantee it held is held by the statement trigger
