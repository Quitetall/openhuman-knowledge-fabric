-- migrate:up

-- Row-level security.
--
-- RLS is deny-by-default: with it enabled and no permissive policy matching, a row is
-- invisible. That is the property worth having — a table someone forgets to write a policy
-- for leaks nothing, rather than everything.
--
-- FORCE ROW LEVEL SECURITY makes the policies apply to the table OWNER too. Without it, the
-- owner bypasses every policy, which means the protection evaporates the moment anything
-- runs as the owner — including a migration that accidentally does more than migrate.
--
-- Two dimensions are enforceable today: which organization the reader belongs to, and how
-- far up the classification ladder they may see. Project-membership scoping needs
-- org.role_assignment and work.project_membership, which arrive with the work-control slice;
-- until then those tables do not exist and no policy pretends to consult them.

-- ── access context ──────────────────────────────────────────────────────────────────────

create or replace function core.set_access_context(
  p_organization uuid,
  p_max_classification text
) returns void
language plpgsql
as $$
begin
  if not exists (select 1 from registry.classification where id = p_max_classification) then
    raise exception 'unknown classification %', p_max_classification
      using errcode = 'invalid_parameter_value';
  end if;
  perform set_config('kf.organization', p_organization::text, true);
  perform set_config('kf.max_classification', p_max_classification, true);
end
$$;

create or replace function core.current_organization() returns uuid
language sql stable
as $$ select nullif(current_setting('kf.organization', true), '')::uuid $$;

/*
 * The highest classification rank the session may read.
 *
 * Returns -1 when unset, which is BELOW every real rank, so an unset context sees nothing.
 * Returning a permissive default here would silently disable the control for every caller
 * that forgot to set it — the opposite of what a security default should do.
 */
create or replace function core.current_classification_rank() returns integer
language sql stable
as $$
  select coalesce(
    (select rank from registry.classification
      where id = nullif(current_setting('kf.max_classification', true), '')),
    -1)
$$;

-- ── policies ────────────────────────────────────────────────────────────────────────────

alter table core.object enable row level security;
alter table core.object force row level security;

create policy object_read on core.object
  for select
  using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
        <= core.current_classification_rank()
  );

create policy object_write on core.object
  for insert
  with check (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
        <= core.current_classification_rank()
  );

-- An update may not move a row out of the caller's reach, nor raise its classification
-- beyond what the caller may see. Otherwise a writer could reclassify a record to hide it
-- from themselves and from everyone auditing them.
create policy object_update on core.object
  for update
  using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
        <= core.current_classification_rank()
  )
  with check (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
        <= core.current_classification_rank()
  );

alter table core.relation enable row level security;
alter table core.relation force row level security;

-- An edge is visible only when BOTH endpoints are. Otherwise the graph leaks the existence
-- of records the reader may not see, and existence is often the sensitive part.
create policy relation_read on core.relation
  for select
  using (
    exists (select 1 from core.object o where o.id = source_id)
    and exists (select 1 from core.object o where o.id = target_id)
  );

create policy relation_write on core.relation
  for insert
  with check (
    exists (select 1 from core.object o where o.id = source_id)
    and exists (select 1 from core.object o where o.id = target_id)
  );

create policy relation_update on core.relation
  for update
  using (
    exists (select 1 from core.object o where o.id = source_id)
    and exists (select 1 from core.object o where o.id = target_id)
  );

-- Audit rows are visible to auditors unconditionally and to the application only for objects
-- it can already see. An audit log you cannot read for your own records is useless; one you
-- can read for everyone else's is a leak.
alter table core.audit_event enable row level security;
alter table core.audit_event force row level security;

create policy audit_read_auditor on core.audit_event
  for select to kf_auditor
  using (true);

create policy audit_read_scoped on core.audit_event
  for select
  using (object_id is null or exists (select 1 from core.object o where o.id = object_id));

create policy audit_append on core.audit_event
  for insert
  with check (true);

comment on function core.current_classification_rank is
  'Highest classification rank the session may read. Returns -1 when unset — below every '
  'real rank — so an unset context sees nothing rather than everything.';
comment on policy relation_read on core.relation is
  'An edge is visible only when both endpoints are: otherwise the graph leaks the existence '
  'of records the reader may not see.';

-- migrate:down

drop policy if exists audit_append on core.audit_event;
drop policy if exists audit_read_scoped on core.audit_event;
drop policy if exists audit_read_auditor on core.audit_event;
alter table core.audit_event disable row level security;

drop policy if exists relation_update on core.relation;
drop policy if exists relation_write on core.relation;
drop policy if exists relation_read on core.relation;
alter table core.relation disable row level security;

drop policy if exists object_update on core.object;
drop policy if exists object_write on core.object;
drop policy if exists object_read on core.object;
alter table core.object disable row level security;

drop function if exists core.current_classification_rank();
drop function if exists core.current_organization();
drop function if exists core.set_access_context(uuid, text);
