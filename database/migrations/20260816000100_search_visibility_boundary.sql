-- migrate:up

-- The search index enforced its visibility rule in ONE query and nowhere else.
--
-- `20260811001800_search.sql` states the design out loud: "The index holds everything; who
-- may see what is decided here" — meaning at query time, in `searchIn`, which does apply the
-- organization and classification predicate. That is a coherent design for callers who go
-- through `@kf/search`. It is not a boundary, because two other paths reach the same rows and
-- neither one is that query:
--
--   1. `select` on `search.document` is granted to kf_readonly and kf_auditor. Those roles
--      exist precisely to connect and read directly; for them there is no query time at which
--      anything is enforced. Measured before this migration, as kf_readonly with no access
--      context bound: `core.object` returned 0 rows and `search.document` returned all 15.
--
--   2. `search.text_for`, `search.text_for_structured_record`, `search.index_object` and
--      `search.rebuild` are SECURITY DEFINER owned by the database owner, and PostgreSQL
--      grants EXECUTE to PUBLIC by default. None of them was revoked. So any role that can
--      connect could call `search.text_for('<any object id>')` and get that record's title,
--      typed detail and — since 20260812000100 folded parsed document atoms into it — the
--      body text of a controlled document, with row-level security bypassed entirely.
--      Measured: the same kf_readonly session that saw 0 rows in `core.object` received the
--      controlled document's text.
--
-- Both are closed here. The predicate inside `searchIn` STAYS: the comment there is right
-- that a filter living on one of two paths will be missed on the other, and the answer to
-- that is a filter on both, not a filter moved.

alter table search.document enable row level security;

create policy search_document_read on search.document for select using (
  organization_id = core.current_organization()
  and (select rank from registry.classification where id = classification)
    <= core.current_classification_rank()
);

-- Deliberately NOT `force row level security`, unlike the append-only authority tables.
--
-- There, forcing is the point: every write must pass a trigger, so the owner must not be able
-- to go around it. Here the owner IS the maintenance path — `search.index_object` and
-- `search.rebuild` are SECURITY DEFINER and run as the owner — and an indexer that could only
-- index rows it can itself see would build the subset index that `search.text_for`'s own
-- comment rejects: "an index that looks complete and is not".

-- Restore the privilege model the original migration described. `revoke ... from public`
-- does not disturb the explicit role grants below it; it removes the implicit one that made
-- them meaningless.
revoke execute on function search.text_for(uuid) from public;
revoke execute on function search.text_for_structured_record(uuid) from public;
revoke execute on function search.index_object(uuid) from public;
revoke execute on function search.rebuild() from public;

-- `text_for` and `text_for_structured_record` get no grant at all. Their only caller is
-- `search.index_object`, which is SECURITY DEFINER and therefore resolves them as the owner.
-- Nothing outside the indexer has a reason to assemble a record's text bypassing RLS.
grant execute on function search.index_object(uuid) to kf_app, kf_worker;

-- kf_worker only, which is what 20260811001800 said and, until this line, was not true:
-- PUBLIC held EXECUTE, and kf_app is a member of PUBLIC, so kf_app could trigger a full
-- rebuild — the exact thing that comment set out to prevent.
grant execute on function search.rebuild() to kf_worker;

comment on table search.document is
  'Derived, disposable search projection. Visibility is enforced twice: row-level security on '
  'this table, and the explicit organization/classification predicate in @kf/search.';

-- migrate:down

-- Forward-only. Reverting would restore PUBLIC EXECUTE on four SECURITY DEFINER functions and
-- an unrestricted derived projection of every record in every organization.
