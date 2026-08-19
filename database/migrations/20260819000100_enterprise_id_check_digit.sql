-- migrate:up

-- Enterprise identifiers: check digit at entry, and permanence after allocation.
--
-- OH-DOC-000001-3 R01 rule R7: "The final enterprise-ID digit is a Damm check digit. Invalid
-- check digits shall be rejected at entry and import."
--
-- Before this migration, `core.object.enterprise_id` was `text unique` and nothing else. The
-- ontology validated the SHAPE of the identifier — `^OH-(?:[A-Z]{2,5})-[0-9]{6}-[0-9]$` — and
-- nothing validated the digit, so `OH-DOC-000001-4`, one digit wrong on this organisation's own
-- registry document, matched every pattern in the system and would have been stored. A search
-- for "damm" across this repository returned zero matches.
--
-- WHY THE DATABASE AND NOT ONLY THE APPLICATION. R7 says "at entry and import". Import is the
-- case that matters: a bulk load, a restore, a migration script or a psql session reaches the
-- table without passing through any TypeScript. A constraint here holds for every path.
--
-- WHY NOT TIGHTEN THE JSON SCHEMA INSTEAD. Two reasons. A JSON Schema `pattern` cannot express
-- a check digit at all, so a stricter pattern would still be insufficient. And the current
-- pattern is part of the released `1.0.0-draft.1` pack pinned at tests/conformance/r01-golden/;
-- narrowing it would be redefining an approved semantic, which `r01-golden.test.ts` exists to
-- refuse. Appendix B.1 anticipates exactly this split: "Regex conformance is necessary but not
-- sufficient; validators shall also verify ... Damm digits, namespace state".

-- ── the check digit ─────────────────────────────────────────────────────────────────────

-- Appendix A's operation table, flattened row-major into a 100-element array. Indexed
-- 1-based, so cell (interim, digit) is at interim * 10 + digit + 1.
--
-- This is the THIRD copy of the table — ontology-registry/damm.yaml is canonical, damm.ts is
-- a checked copy, and this is a translation into SQL. Duplication is the price of enforcing
-- the same rule in three runtimes; `tests/database/enterprise-id-check-digit.test.ts` compares
-- this function's output against the TypeScript one across the full six-digit space it will
-- use, so a transposed cell here cannot survive a test run.
create or replace function core.damm_check(payload text)
  returns integer
  language plpgsql
  immutable
  strict
  parallel safe
as $$
declare
  t constant smallint[] := array[
    0,3,1,7,5,9,8,6,4,2,
    7,0,9,2,1,5,4,8,6,3,
    4,2,0,6,8,7,1,3,5,9,
    1,7,5,0,9,8,3,4,2,6,
    6,1,2,3,0,4,5,9,7,8,
    3,6,7,4,2,0,9,5,8,1,
    5,8,6,9,7,2,0,1,3,4,
    8,9,4,5,3,6,2,0,1,7,
    9,4,3,8,6,1,7,2,0,5,
    2,5,8,1,4,3,6,7,9,0
  ];
  interim integer := 0;
  d integer;
  i integer;
begin
  for i in 1 .. length(payload) loop
    d := ascii(substr(payload, i, 1)) - 48;
    -- A non-digit is an error, not a zero. Coercing would compute a plausible check digit for
    -- an identifier that has no valid one.
    if d < 0 or d > 9 then
      raise exception 'core.damm_check: % contains a non-digit', payload
        using errcode = 'invalid_parameter_value';
    end if;
    interim := t[interim * 10 + d + 1];
  end loop;
  return interim;
end;
$$;

comment on function core.damm_check(text) is
  'Damm check digit over a decimal payload. OH-DOC-000001-3 R01 Appendix A.';

-- ── identifier validity ─────────────────────────────────────────────────────────────────
--
-- Grammar AND check digit, with the Damm payload differing by kind:
--   enterprise  the six-digit sequence only, NOT the namespace   (§4.1)
--   record      the year AND the sequence, ten digits            (§9.4)
--   serial      the nine-digit sequence                          (§10.1)
--
-- The nineteen namespaces are enumerated rather than matched as a character class. §8's rule
-- is that an identifier absent from the registry does not exist, and `[A-Z]{2,5}` would accept
-- OH-XYZ-000001-3 for a namespace nobody allocated. RCD is absent from this list on purpose:
-- §4.2 lists it as a namespace whose members use the record grammar in §9.4.
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

comment on function core.valid_enterprise_id(text) is
  'Grammar plus Damm digit for enterprise, record and serial identifiers. OH-DOC-000001-3 R01 R4/R7.';

-- ── the constraint ──────────────────────────────────────────────────────────────────────
--
-- NOT VALID is deliberate and is not a weakening here: the column holds no rows with a
-- non-null enterprise_id at the time this runs, so there is nothing to validate against, and
-- the constraint is enforced for every insert and update from this point. It is validated
-- immediately below so the catalog records it as fully checked rather than leaving a
-- permanently `NOT VALID` constraint that reads as provisional.
alter table core.object
  add constraint object_enterprise_id_valid
  check (enterprise_id is null or core.valid_enterprise_id(enterprise_id))
  not valid;

alter table core.object validate constraint object_enterprise_id_valid;

comment on constraint object_enterprise_id_valid on core.object is
  'R7: invalid check digits are rejected at entry and import. Null until allocated (R9).';

-- ── permanence ──────────────────────────────────────────────────────────────────────────
--
-- R8: "An allocated enterprise identifier is permanent. It shall never be reused, redefined,
-- deleted, reassigned or attached to a different UUIDv7 object."
--
-- `unique` already prevents two objects holding the same identifier. It does not prevent an
-- object's identifier being CHANGED or CLEARED, which is the same harm arriving by a different
-- route: the identifier stops naming what it named, and every external reference to it —
-- printed on a label, quoted in a purchase order, cited in a regulatory submission — silently
-- resolves to nothing or to something else.
--
-- Allocation itself is permitted, once: null -> a value. That is R9's "allocation attaches the
-- ID to the existing object_id and never replaces the object".
create or replace function core.enterprise_id_is_permanent()
  returns trigger
  language plpgsql
as $$
begin
  if old.enterprise_id is not null and old.enterprise_id is distinct from new.enterprise_id then
    raise exception
      'enterprise_id % is permanent and cannot be changed to % (OH-DOC-000001-3 R01 rule R8)',
      old.enterprise_id, coalesce(new.enterprise_id, 'null')
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

create trigger object_enterprise_id_permanent
  before update on core.object
  for each row
  execute function core.enterprise_id_is_permanent();

comment on function core.enterprise_id_is_permanent() is
  'R8: an allocated enterprise identifier is never changed, cleared or reassigned.';

-- migrate:down

drop trigger if exists object_enterprise_id_permanent on core.object;
drop function if exists core.enterprise_id_is_permanent();
alter table core.object drop constraint if exists object_enterprise_id_valid;
drop function if exists core.valid_enterprise_id(text);
drop function if exists core.damm_check(text);
