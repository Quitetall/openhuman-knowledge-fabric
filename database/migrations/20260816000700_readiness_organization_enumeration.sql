-- migrate:up

-- Enumerate organization IDENTIFIERS, and nothing else.
--
-- The search-index completeness check compares "how many records exist" against "how many are
-- indexed". Both sides are now row-level-security scoped, which leaves three ways to run it
-- and only one that is worth having:
--
--   as the owner, unscoped     — one global comparison. It works, and it makes a scheduled
--                                component that reads every record in every organization,
--                                whose entire output is one integer. The blast radius is
--                                wildly out of proportion to the answer.
--
--   as one bound identity      — honest for that organization's slice and structurally blind
--                                to every other. Every other organization's index could be
--                                empty and it would report ok. That is a check that cannot
--                                fail for the reason it exists.
--
--   federated, per organization — the comparison happens INSIDE each organization's scope and
--                                readiness reports the union. No identity ever holds a
--                                cross-organization view, and a shortfall anywhere is still
--                                visible.
--
-- The third needs one thing the second does not: a way to learn that an organization exists
-- without being able to read what is in it. That is this function, and its narrowness is the
-- whole point. It returns `uuid` and only `uuid` — no title, no enterprise identifier, no
-- classification, no counts, nothing that composes into a record. An organization identifier
-- is a coordinate, not contents.
--
-- SECURITY DEFINER because the caller has no context bound yet: that is the bootstrap this
-- solves. Revoked from PUBLIC and granted only to the two roles that assess readiness, so a
-- narrow bypass stays narrow.
--
-- What the caller does with these ids is bounded by what it can then ask. The readiness check
-- binds each id in turn and issues `count(*)` and nothing else — it can count records, it
-- cannot read one.

create function core.readiness_organization_ids() returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, core
as $$
  select object.id
    from core.object object
   where object.object_type = 'organization'
   order by object.id
$$;

revoke execute on function core.readiness_organization_ids() from public;
grant execute on function core.readiness_organization_ids() to kf_app, kf_worker;

comment on function core.readiness_organization_ids is
  'Organization identifiers only, for federated readiness. Deliberately returns no attribute '
  'of an organization beyond its id: a coordinate, not contents.';

-- migrate:down

drop function if exists core.readiness_organization_ids();
