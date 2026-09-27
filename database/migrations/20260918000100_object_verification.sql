-- migrate:up

-- Whether anyone has checked a record, recorded beside the record and not inside it.
--
-- KF-SAS-RQ-232: verification is recorded independently of lifecycle state and is never inferred
-- from the state a record happens to occupy. That is why this is a table and not a column.
--
-- `core.object` carries three guard triggers — context, transition, row_version — and every write
-- to it is a lifecycle event passing through them. Verification is not a lifecycle event: a work
-- order is verified while still `planned`, a piece of equipment while `in_service`. Putting the
-- fact in `core.object` would route it through the transition guard and bump the row version of a
-- record nothing changed about, which is the conflation `0.1.0-draft.6` exists to correct. Here,
-- the orthogonality is structural rather than a convention somebody has to keep.
--
-- ABSENCE IS THE UNVERIFIED STATE. No row means nobody has checked it. There is deliberately no
-- `verified boolean`: a column would have to default to something, and a default of false on a
-- table nobody writes is indistinguishable from a system that has never verified anything, while
-- a default of true would be a lie told once per insert.
--
-- Nothing here deletes. Law 6 applies: if a verification is withdrawn, the withdrawal is another
-- record, not the removal of this one. `on delete restrict` on the action reference says the same
-- thing from the other side.

create table core.object_verification (
  object_id          uuid primary key references core.object (id),
  verified_at        timestamptz not null default now(),
  verified_by        uuid not null,
  -- KF-SAS-RQ-231. Reviewing five hundred records one at a time and promoting five hundred in one
  -- gesture are different facts, and "verified" carries no information if it is written for both.
  -- An auditor asking whether a person looked at this record gets a true answer either way.
  basis              text not null
                       check (basis in ('reviewed_individually', 'promoted_in_bulk')),
  recorded_by_action uuid not null references core.action (id) on delete restrict
);

comment on table core.object_verification is
  'Whether a record has been verified, by whom, on what basis (KF-SAS-RQ-228 to RQ-232). '
  'Absence means unverified. Orthogonal to lifecycle state by construction: a record is verified '
  'while `planned`, `active` or `in_service`, and lifecycle is not consulted here.';

create index object_verification_by_actor on core.object_verification (verified_by);

alter table core.object_verification enable row level security;

-- Visibility defers to the record, exactly as `core.relation` does and as `search.document` was
-- taught to on 2026-09-14. A verification is a fact ABOUT an object; a session that cannot see the
-- object has no business learning that somebody checked it.
create policy object_verification_read on core.object_verification
  for select
  using (exists (select 1 from core.object o where o.id = object_id));

-- Writing one is permitted for a session that can see the record, and for no other. Without this
-- policy the table had row security enabled and no insert rule, so every write by the application
-- role was refused however correct it was — and a test asserting that an unattributed write is
-- refused passed against that, rather than against the guard below. A grant without a policy is
-- not a narrow permission, it is no permission.
create policy object_verification_write on core.object_verification
  for insert
  with check (exists (select 1 from core.object o where o.id = object_id));

-- A verification is a controlled write and enters through the dispatcher like any other, so the
-- same guard that refuses an unattributed write elsewhere refuses one here.
create trigger object_verification_guard_context
  before insert or update on core.object_verification
  for each row execute function core.require_transaction_context();

grant select, insert on core.object_verification to kf_app, kf_worker;
grant select on core.object_verification to kf_readonly, kf_auditor;

-- migrate:down

drop trigger if exists object_verification_guard_context on core.object_verification;
drop table if exists core.object_verification;
