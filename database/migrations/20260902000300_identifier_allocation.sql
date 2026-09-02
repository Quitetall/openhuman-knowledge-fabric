-- migrate:up

-- ADR 0018. OH-DOC-000001-3 R01 rule R6: "Enterprise sequences are fixed width, zero padded and
-- atomically allocated." Fixed width and padding were checked by the grammar from the first
-- day; ATOMIC ALLOCATION never existed — rules.yaml said so in its own words, and every
-- identifier this instance holds arrived from a reviewed seed file. An identifier that a
-- process could not allocate is one a process could only fabricate, which is what §12.4 of the
-- OpenWarrant SAS forbids and what OW-WAR-0044 is blocked on.
--
-- The allocator is a row lock on a per-namespace sequence, in the same transaction as the
-- action that asked, so two concurrent allocations serialise on the namespace and the second
-- sees the first's advance. It never reuses (R8), never replaces the object (R9), refuses a
-- namespace this instance has not allocated or has retired (§13.3), and skips any sequence
-- value an identifier already occupies — the reviewed seeds that arrived before there was an
-- allocator keep their numbers.

create table registry.identifier_sequence (
  qualified_code  text primary key references registry.identifier_namespace (qualified_code),
  -- The next value to TRY. Occupied values are skipped at allocation time, so this is a floor,
  -- not a promise.
  next_sequence   bigint not null default 1 check (next_sequence between 1 and 1000000),
  allocated_count bigint not null default 0 check (allocated_count >= 0),
  updated_at      timestamptz not null default now()
);

comment on table registry.identifier_sequence is
  'R6 allocation cursor per namespace. Locked for update by core.allocate_enterprise_id.';

-- The ledger: which act gave which object which identifier. `core.object.enterprise_id` is
-- the identity; this row is the receipt, and the one place a replay can read it back from.
create table registry.identifier_allocation (
  enterprise_id       text primary key check (core.valid_enterprise_id(enterprise_id)),
  object_id           uuid not null unique references core.object (id) on delete restrict,
  qualified_code      text not null references registry.identifier_namespace (qualified_code),
  sequence            bigint not null check (sequence between 1 and 999999),
  allocated_at        timestamptz not null default now(),
  allocated_by        uuid not null references org.person (id) on delete restrict,
  allocated_by_action uuid not null unique references core.action (id) on delete restrict,
  unique (qualified_code, sequence)
);

comment on table registry.identifier_allocation is
  'Append-only receipt of every R6 allocation: object, namespace, sequence, actor, act.';

create or replace function registry.identifier_allocation_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'identifier allocations are permanent (R8): % is not %',
    tg_op, 'permitted' using errcode = 'restrict_violation';
end;
$$;

create trigger identifier_allocation_append_only
  before update or delete on registry.identifier_allocation
  for each row execute function registry.identifier_allocation_append_only();

/*
 * Allocate the next free enterprise identifier for `p_object` under the namespace its object
 * type declares, attach it, and record the receipt against `p_action`.
 *
 * Refusals are exceptions with a named reason, because each one is a fact about the record:
 * already allocated (R8 — permanent, so a second allocation is a contradiction, not a retry),
 * no namespace declared for the type, namespace not allocated on this instance, namespace not
 * active, namespace exhausted.
 */
create or replace function core.allocate_enterprise_id(p_object uuid, p_actor uuid, p_action uuid)
returns text
language plpgsql
set search_path = pg_catalog, core, registry
as $$
declare
  v_type text;
  v_existing text;
  v_namespace text;
  v_qualified text;
  v_state text;
  v_sequence bigint;
  v_payload text;
  v_candidate text;
begin
  select o.object_type, o.enterprise_id into v_type, v_existing
    from core.object o where o.id = p_object for update;
  if v_type is null then
    raise exception 'object % is not visible to this caller', p_object
      using errcode = 'no_data_found';
  end if;
  if v_existing is not null then
    raise exception 'object % already holds enterprise identifier %; an allocation is permanent (R8)',
      p_object, v_existing using errcode = 'unique_violation';
  end if;

  select t.enterprise_namespace into v_namespace from registry.object_type t where t.id = v_type;
  if v_namespace is null then
    raise exception 'object type % declares no enterprise namespace; nothing can be allocated to it',
      v_type using errcode = 'check_violation';
  end if;

  -- The namespace is declared by its bare code (DOC); this instance allocates qualified heads
  -- (OH-DOC). The prefix is the instance's, never assumed here.
  select n.qualified_code, n.state into v_qualified, v_state
    from registry.identifier_namespace n
   where n.grammar = 'enterprise' and n.qualified_code like '%-' || v_namespace
   order by n.qualified_code limit 1;
  if v_qualified is null then
    raise exception 'namespace % is not allocated on this instance (R01 §8: an identifier absent from the registry does not exist)',
      v_namespace using errcode = 'check_violation';
  end if;
  if v_state <> 'active' then
    raise exception 'namespace % is % on this instance; no new allocation (R01 §13.3)',
      v_qualified, v_state using errcode = 'check_violation';
  end if;

  insert into registry.identifier_sequence (qualified_code) values (v_qualified)
    on conflict (qualified_code) do nothing;
  select s.next_sequence into v_sequence
    from registry.identifier_sequence s where s.qualified_code = v_qualified for update;

  loop
    if v_sequence > 999999 then
      raise exception 'namespace % is exhausted at 999999', v_qualified
        using errcode = 'sequence_generator_limit_exceeded';
    end if;
    v_payload := lpad(v_sequence::text, 6, '0');
    v_candidate := v_qualified || '-' || v_payload || '-' || core.damm_check(v_payload)::text;
    exit when not exists (select 1 from core.object o where o.enterprise_id = v_candidate)
      and not exists (select 1 from registry.identifier_allocation a where a.enterprise_id = v_candidate);
    v_sequence := v_sequence + 1;
  end loop;

  update core.object
     set enterprise_id = v_candidate,
         row_version = row_version + 1,
         updated_at = now(),
         updated_by = p_actor
   where id = p_object;
  insert into registry.identifier_allocation
    (enterprise_id, object_id, qualified_code, sequence, allocated_by, allocated_by_action)
  values (v_candidate, p_object, v_qualified, v_sequence, p_actor, p_action);
  update registry.identifier_sequence
     set next_sequence = v_sequence + 1, allocated_count = allocated_count + 1, updated_at = now()
   where qualified_code = v_qualified;
  return v_candidate;
end;
$$;

comment on function core.allocate_enterprise_id(uuid, uuid, uuid) is
  'R6 atomic allocation: next free sequence under the object type''s namespace, Damm digit, ledger row.';

revoke all on function core.allocate_enterprise_id(uuid, uuid, uuid) from public;
grant execute on function core.allocate_enterprise_id(uuid, uuid, uuid) to kf_app;

alter table registry.identifier_sequence enable row level security;
alter table registry.identifier_sequence force row level security;
create policy identifier_sequence_read on registry.identifier_sequence for select using (true);
create policy identifier_sequence_write on registry.identifier_sequence
  for insert with check (true);
create policy identifier_sequence_advance on registry.identifier_sequence
  for update using (true) with check (true);
create policy identifier_sequence_backup_read on registry.identifier_sequence
  for select to kf_backup using (true);

alter table registry.identifier_allocation enable row level security;
alter table registry.identifier_allocation force row level security;
create policy identifier_allocation_scoped_read on registry.identifier_allocation
  for select using (
    exists (select 1 from core.object envelope where envelope.id = identifier_allocation.object_id)
  );
create policy identifier_allocation_write on registry.identifier_allocation
  for insert with check (
    allocated_by = core.current_actor()
    and allocated_by_action = core.current_action_id()
    and exists (select 1 from core.object envelope where envelope.id = identifier_allocation.object_id)
  );
create policy identifier_allocation_backup_read on registry.identifier_allocation
  for select to kf_backup using (true);

grant select on registry.identifier_sequence, registry.identifier_allocation
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
grant insert, update on registry.identifier_sequence to kf_app;
grant insert on registry.identifier_allocation to kf_app;

-- migrate:down

drop policy identifier_allocation_backup_read on registry.identifier_allocation;
drop policy identifier_allocation_write on registry.identifier_allocation;
drop policy identifier_allocation_scoped_read on registry.identifier_allocation;
drop policy identifier_sequence_backup_read on registry.identifier_sequence;
drop policy identifier_sequence_advance on registry.identifier_sequence;
drop policy identifier_sequence_write on registry.identifier_sequence;
drop policy identifier_sequence_read on registry.identifier_sequence;
drop function core.allocate_enterprise_id(uuid, uuid, uuid);
drop trigger identifier_allocation_append_only on registry.identifier_allocation;
drop function registry.identifier_allocation_append_only();
drop table registry.identifier_allocation;
drop table registry.identifier_sequence;
