-- migrate:up

-- Stop hardcoding one organisation's identifier prefix in the product.
--
-- WHAT WAS WRONG. `core.valid_enterprise_id` matched `^OH-(ITM|DOC|INTF|…)-[0-9]{6}-[0-9]$` —
-- OpenHuman Technologies LLC's prefix and its nineteen namespaces, written into a function that
-- ships with the software. A different deployment could configure its own registry, watch it
-- compile, and then be rejected by this constraint on the first insert. ADR 0006 recorded that
-- as the place the product/instance boundary leaked.
--
-- THE OBVIOUS FIX IS UNSOUND, and is worth writing down so nobody re-proposes it. "Have
-- valid_enterprise_id read a namespaces table" cannot work: a CHECK constraint must be
-- IMMUTABLE, and a function that reads a table is STABLE at best. It survives casual testing
-- and breaks on dump/restore and constraint revalidation, which is the worst possible time.
--
-- SO SPLIT THE TWO QUESTIONS, because they have different natures:
--
--   "is this the right SHAPE, and does the check digit hold?"   universal    -> immutable CHECK
--   "is this namespace ALLOCATED, under that grammar?"          per-instance -> foreign key
--
-- Shape and arithmetic stay in the constraint and lose the prefix. Allocation moves to a table
-- that each deployment seeds from its own registry, reached by a foreign key from two stored
-- generated columns. The FK does exactly the work the namespace alternation used to do, and
-- does it against data instead of source.
--
-- Verified on PostgreSQL 18 before writing this, all cases, in a rolled-back probe:
--   OH-DOC-000001-3      allocated, enterprise grammar   accepted
--   OH-XYZ-000001-3      namespace never allocated       rejected by the FK
--   OH-DOC-2026-000001-5 record grammar, document ns     rejected by the FK
--   AC-PART-000042-7     a different instance, seeded    accepted
--   NULL                 not yet allocated               accepted, FK does not fire

-- ── where this lives, and why it is not in core ────────────────────────────────────────────
--
-- `registry.*` is already the home of compiled policy reference data — object_type,
-- state_machine, retention_class, rule_definition — read by everyone and written only by
-- migrations and loaders. An allocated-namespace list is that exact kind of thing. Putting it
-- in `core` would also have tripped `typed-table-visibility`, which requires RLS on anything in
-- core that the read roles can see; this is not organisation-scoped data and RLS on it would be
-- theatre.
create table registry.identifier_namespace (
  -- The FULL head, prefix included: 'OH-DOC', not 'DOC'. One column, so one foreign key
  -- enforces both "this deployment's prefix" and "an allocated namespace" together. Splitting
  -- them would allow OH-PART to pass on an instance that allocated AC-PART.
  qualified_code text primary key,
  -- Which grammar the namespace's members use. R01 §4.2 lists RCD as a namespace whose members
  -- use the §9.4 record grammar, so this is a property of the namespace, not of the string.
  grammar text not null check (grammar in ('enterprise', 'record', 'serial')),
  -- R01 §13.3's namespace lifecycle. Recorded rather than enforced here: a foreign key cannot
  -- be conditional, so "no NEW allocation into a retired namespace" belongs to the allocator.
  -- Retiring a namespace must not invalidate identifiers already issued under it (§13.4).
  state text not null default 'active'
    check (state in ('unallocated', 'reserved', 'active', 'deprecated', 'retired')),
  -- The registry revision this row was seeded from, so a row can be traced to its source.
  source_document text,
  source_revision text,
  unique (qualified_code, grammar)
);

comment on table registry.identifier_namespace is
  'Allocated identifier namespaces for THIS deployment, seeded from the configured registry '
  '(KF_REGISTRY_DIR). Instance policy, not product data — see ADR 0006.';

grant select on registry.identifier_namespace
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor;

-- ── the two generated columns the foreign key hangs on ─────────────────────────────────────
--
-- STORED, not virtual: a foreign key needs a real column. They are derived, never written, so
-- they cannot drift from enterprise_id the way a denormalised copy would.
--
-- ns_shape reads the grammar OUT OF THE STRING. Pairing it with ns_head in one composite key is
-- what catches OH-DOC-2026-000001-5 — a well-formed record identifier using a namespace that
-- was allocated for enterprise use. Checking the two independently would let it through.
alter table core.object
  add column ns_head text generated always as (
    substring(enterprise_id from '^([A-Z]+-[A-Z]+)-')
  ) stored,
  add column ns_shape text generated always as (
    case
      -- Order is not significant: the three patterns are disjoint because each is anchored and
      -- fixes its digit counts. Listed longest-payload first only for readability.
      when enterprise_id ~ '^[A-Z]+-[A-Z]+-[0-9]{4}-[0-9]{6}-[0-9]$' then 'record'
      when enterprise_id ~ '^[A-Z]+-[A-Z]+-[0-9]{9}-[0-9]$' then 'serial'
      when enterprise_id ~ '^[A-Z]+-[A-Z]+-[0-9]{6}-[0-9]$' then 'enterprise'
    end
  ) stored;

comment on column core.object.ns_head is
  'Derived prefix and namespace, e.g. OH-DOC. Exists so the allocation check can be a foreign key.';
comment on column core.object.ns_shape is
  'Which grammar the enterprise_id string uses. Paired with ns_head so a namespace cannot be '
  'used under a grammar it was not allocated for.';

-- NULL in either column makes the FK not fire, which is the behaviour wanted: an object has no
-- enterprise identifier until one is allocated, and spec §7.1 makes node_id sufficient alone.
alter table core.object
  add constraint object_enterprise_namespace_allocated
  foreign key (ns_head, ns_shape)
  references registry.identifier_namespace (qualified_code, grammar);

-- ── the constraint, minus the prefix ───────────────────────────────────────────────────────
--
-- Same three grammars, same Damm payloads, no organisation in it. What it no longer does is
-- reject an unallocated namespace — the foreign key above does that now, against seeded data
-- rather than a literal written into the product.
--
-- This is Appendix B.1's own position made structural: "Regex conformance is necessary but not
-- sufficient; validators shall also verify … namespace state, allocation threshold …". The
-- regex was doing part of the allocation check by accident of enumeration.
create or replace function core.valid_enterprise_id(id text)
  returns boolean
  language plpgsql
  immutable
  strict
  parallel safe
as $$
declare
  m text[];
begin
  -- enterprise: Damm over the six-digit sequence alone.
  m := regexp_match(id, '^[A-Z]+-[A-Z]+-([0-9]{6})-([0-9])$');
  if m is not null then
    return core.damm_check(m[1] || m[2]) = 0;
  end if;

  -- record: Damm over YYYYNNNNNN, ten digits.
  m := regexp_match(id, '^[A-Z]+-[A-Z]+-([0-9]{4})-([0-9]{6})-([0-9])$');
  if m is not null then
    return core.damm_check(m[1] || m[2] || m[3]) = 0;
  end if;

  -- serial: nine digits, globally allocated.
  m := regexp_match(id, '^[A-Z]+-[A-Z]+-([0-9]{9})-([0-9])$');
  if m is not null then
    return core.damm_check(m[1] || m[2]) = 0;
  end if;

  return false;
end;
$$;

comment on function core.valid_enterprise_id(text) is
  'Grammar shape plus Damm digit, prefix-agnostic. Whether the namespace is ALLOCATED is a '
  'foreign key to registry.identifier_namespace, not this function — a CHECK must be IMMUTABLE '
  'and cannot read a table. R01 R4/R7.';

-- migrate:down

alter table core.object drop constraint object_enterprise_namespace_allocated;
alter table core.object drop column ns_shape;
alter table core.object drop column ns_head;
drop table registry.identifier_namespace;

-- Restore the prefix-bound function exactly as it stood, so `down` is a real inverse rather
-- than an approximation that leaves the database subtly different from before.
create or replace function core.valid_enterprise_id(id text)
  returns boolean
  language plpgsql
  immutable
  strict
  parallel safe
as $$
declare
  m text[];
begin
  m := regexp_match(id,
    '^OH-(ITM|DOC|INTF|BIND|SWC|DAT|MDL|REQ|RSK|TST|CHG|ADR|BSL|RLS|QEV|EQP|SUP|LOT|WRK)-([0-9]{6})-([0-9])$');
  if m is not null then
    return core.damm_check(m[2] || m[3]) = 0;
  end if;

  m := regexp_match(id, '^OH-RCD-([0-9]{4})-([0-9]{6})-([0-9])$');
  if m is not null then
    return core.damm_check(m[1] || m[2] || m[3]) = 0;
  end if;

  m := regexp_match(id, '^OH-SN-([0-9]{9})-([0-9])$');
  if m is not null then
    return core.damm_check(m[1] || m[2]) = 0;
  end if;

  return false;
end;
$$;
