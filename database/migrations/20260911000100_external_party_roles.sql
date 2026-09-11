-- migrate:up

-- Two roles for people who are not the institution but must read what it publishes to them.
--
-- Row-level security scopes every record to ONE organization, so a customer's contact or a
-- partner's contact who is to read this organization's documents is a person IN this
-- organization's tenancy — a person of kind `human`, with a clearance that caps what they can
-- ever see and a role assignment that is their organization-wide read grant. The ten R01
-- roles are all institutional; assigning `reviewer` to a customer would say something about
-- them that is not true. These two say exactly what they are.
--
-- What they do NOT do: they carry no `act` authority the dispatcher honours beyond what the
-- role assignment itself confers (a role assignment is read AND act at its scope — see
-- org.effective_access_grant). The classification ceiling on the person's CLEARANCE is the
-- real limit: a customer contact cleared to `public` sees public records and nothing else,
-- whatever their role says.
insert into org.role (id, description) values
  ('customer_contact', 'A customer''s named contact: reads what this organization publishes to its customers.'),
  ('partner_contact',  'A partner''s named contact: reads what this organization shares with that partner.');

-- ── seeing another organization's lifecycle without seeing the organization ─────────────
--
-- `retire_organization` may name a successor, and must refuse one that is itself retired. The
-- act runs scoped to the organization being retired, and `org.organization` is read through
-- the `core.object` envelope, which row-level security scopes to that one organization — so
-- the successor's row is invisible from exactly the place that has to check it. The first
-- version of the precondition read `core.object` directly and could never have seen a
-- successor at all.
--
-- `org.organization` enables row-level security without FORCING it, so a definer function
-- owned by the table's owner reads past the policy. It answers two things and nothing else:
-- does this organization exist, and when was it retired. An id is all a caller learns.
create function org.organization_retirement(target uuid)
  returns table (present boolean, retired_at timestamptz)
  language sql
  stable
  security definer
  set search_path = pg_catalog, org
as $$
  select exists (select 1 from org.organization o where o.id = target),
         (select o.retired_at from org.organization o where o.id = target)
$$;

revoke execute on function org.organization_retirement(uuid) from public;
grant execute on function org.organization_retirement(uuid) to kf_app, kf_worker;

comment on function org.organization_retirement(uuid) is
  'Existence and retirement instant of one organization, readable from any scope. Used by '
  'retire_organization to validate a successor the caller''s row-level scope cannot see.';

-- ── where a retired organization's records went ─────────────────────────────────────────
--
-- A `core.relation` needs both ends visible under the caller's row-level scope, and a
-- successor organization is by definition another scope — so "supersedes" between two
-- organizations cannot be a relation, and the first version of the retire effect, which tried
-- to write one, was refused by the policy the first time it was actually run. The successor is
-- a fact about the retired organization, so it lives on that organization's row, set by the
-- act that named it (the act's payload carries it too).
alter table org.organization
  add column succeeded_by uuid references org.organization (id) on delete restrict,
  add constraint organization_successor_is_other check (succeeded_by is distinct from id),
  add constraint organization_successor_only_when_retired
    check (succeeded_by is null or retired_at is not null);

comment on column org.organization.succeeded_by is
  'The organization that took over this one''s records, named on the retire_organization act. '
  'Not a core.relation: a relation cannot cross organizations under row-level security.';

-- ── a clearance can be retired by an act ────────────────────────────────────────────────
--
-- `org.person_clearance` is append-only for the application role, and its retirement is a row
-- in `org.person_clearance_retirement` that the resolver and `explainAccess` already honour.
-- But the application could only SELECT that table, so no act could ever retire a clearance:
-- `deactivate_person` and `retire_organization` end a person's authority, and both would have
-- failed on the first clearance they reached. The insert is admitted under the same shape as
-- the clearance grant itself: this actor, this action, this organization.
grant insert on org.person_clearance_retirement to kf_app;

-- And the interval closes with it. `person_clearance_no_overlap` excludes overlapping
-- (subject, organization, tstzrange(valid_from, valid_to)); a retired clearance whose
-- `valid_to` stayed null would still occupy the open range and refuse every later grant to the
-- same person — "retire it deliberately before granting" would then be advice nothing could
-- follow. The retirement row is the record (who, why, under which act); `valid_to` is what
-- keeps the constraint truthful. One column, one scope, and only ever forward.
grant update (valid_to) on org.person_clearance to kf_app;

create policy person_clearance_close on org.person_clearance
  for update
  using (organization_id = core.current_organization())
  with check (organization_id = core.current_organization());

create policy person_clearance_retirement_write on org.person_clearance_retirement
  for insert to kf_app
  with check (
    retired_by = core.current_actor()
    and retired_by_action = core.current_action_id()
    and exists (
      select 1 from org.person_clearance clearance
       where clearance.id = person_clearance_retirement.clearance_id
         and clearance.organization_id = core.current_organization()
    )
  );

-- migrate:down

alter table org.organization drop column succeeded_by;
drop policy person_clearance_close on org.person_clearance;
revoke update (valid_to) on org.person_clearance from kf_app;
drop policy person_clearance_retirement_write on org.person_clearance_retirement;
revoke insert on org.person_clearance_retirement from kf_app;
drop function org.organization_retirement(uuid);
delete from org.role where id in ('customer_contact', 'partner_contact');
