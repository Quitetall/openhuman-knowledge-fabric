-- migrate:up

-- Two problems, one root: an organization could be created without limit and retired never.
--
-- Nothing constrained `legal_name`, so the same company could be created any number of times.
-- A bootstrap defect did exactly that eight times in one session, and because `core.object` is
-- append-only and `organization` had no lifecycle, every duplicate was permanent. Repeat that
-- deliberately and the instance fills with organizations nobody can remove — the record is
-- degraded for good by a caller that never violated a single rule.
--
-- Creation is constrained here. Retirement arrives with the `organization` lifecycle in
-- `ontology/state-machines.yaml` and the `retire_organization` act that drives it.

-- ── why a column and not a join ─────────────────────────────────────────────────────────
--
-- Lifecycle lives on `core.object`, so the natural rule — "no two ACTIVE organizations share a
-- legal name" — needs to read another table. Two attempts failed before this one, and both
-- failed the same way:
--
--   A plain trigger ran as the caller. `core.object` forces row-level security, so the trigger's
--   lookup was scoped to the organization being created — which, for a row that is its own
--   organization, can never see another. It let a ninth duplicate through while reading like a
--   working constraint.
--
--   SECURITY DEFINER did not fix it. FORCE means the table's owner is subject to its policies
--   too, so the definer was just as blind.
--
-- A uniqueness rule filtered by the caller's scope is not a uniqueness rule; it is a rule about
-- what the caller could already see. So the fact the constraint needs must live on the row it
-- constrains, and the constraint must be an INDEX — indexes are enforced beneath row-level
-- security and cannot be scoped away.
--
-- `retired_at` therefore duplicates something `core.object.lifecycle_state` already says. That
-- redundancy is the point and not an oversight: it is what makes the invariant expressible
-- without a join. The lifecycle remains authoritative; this column exists so the database can
-- enforce what the lifecycle means.
alter table org.organization
  add column retired_at timestamptz;

comment on column org.organization.retired_at is
  'Set when the organization reaches `retired`. Denormalised from core.object.lifecycle_state '
  'so that legal-name uniqueness can be a unique index rather than a trigger — a trigger cannot '
  'see past row-level security, and a uniqueness rule that can be scoped away is not one.';

-- ── the duplicates that already exist ───────────────────────────────────────────────────
--
-- The index cannot be created while they are active, and they cannot be retired through the act
-- because the act did not exist when they were made. They are retired here, oldest of each name
-- kept, with the reason recorded in the column comment above and in this migration.
--
-- This is a data repair inside the migration that closes the defect that caused it. It is the
-- one place that is honest: doing it later through the act would attribute a decision to a
-- person who did not make it.
update org.organization g
   set retired_at = now()
 where exists (
   select 1 from org.organization older
    where lower(btrim(older.legal_name)) = lower(btrim(g.legal_name))
      and older.id < g.id
 );

update core.object o
   set lifecycle_state = 'retired', row_version = row_version + 1
  from org.organization g
 where g.id = o.id
   and g.retired_at is not null
   and o.lifecycle_state <> 'retired';

-- ── the constraint ──────────────────────────────────────────────────────────────────────
--
-- Case-insensitive: "Munder Diffin" and "munder diffin" are the same company to every reader,
-- and a rule a rename can walk around is not a rule.
--
-- Partial on `retired_at is null`, so a retired organization keeps its row and its name in the
-- record while a successor may legitimately carry the same legal name. What is refused is two
-- organizations claiming to be the same company AT THE SAME TIME.
create unique index organization_active_legal_name_unique
  on org.organization (lower(btrim(legal_name)))
  where retired_at is null;

-- ── the kinds the application believed in ───────────────────────────────────────────────
--
-- `bootstrap-organization` validated against company, customer, supplier, partner, regulator.
-- The column allowed company, supplier, laboratory, university, regulator, other. Two of the
-- application's five would have passed its own validator and then been refused by the database,
-- which is a refusal in the wrong place: the caller learns at write time what a validator should
-- have told them. `customer` and `partner` are real relationships this record needs.
alter table org.organization drop constraint organization_organization_kind_check;
alter table org.organization add constraint organization_organization_kind_check
  check (organization_kind in
    ('company', 'customer', 'supplier', 'partner', 'laboratory', 'university',
     'regulator', 'other'));

-- migrate:down

drop index org.organization_active_legal_name_unique;
alter table org.organization drop column retired_at;
alter table org.organization drop constraint organization_organization_kind_check;
alter table org.organization add constraint organization_organization_kind_check
  check (organization_kind in
    ('company', 'supplier', 'laboratory', 'university', 'regulator', 'other'));
