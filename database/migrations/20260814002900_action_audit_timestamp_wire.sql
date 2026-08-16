-- migrate:up

-- Audit digests serialize effective_at with RFC 3339 millisecond precision. PostgreSQL can
-- retain microseconds that JavaScript Date and that digest wire cannot represent. Refuse such
-- values at authority so distinct database instants cannot collapse to one signed preimage.
alter table core.action
  add constraint action_effective_at_canonical_wire
  check (core.is_canonical_wire_timestamp(effective_at));

alter table core.audit_event
  add constraint audit_event_effective_at_canonical_wire
  check (core.is_canonical_wire_timestamp(effective_at));

-- Existing history must bind each receipt to the exact action instant. Do not round, rewrite,
-- or silently bless older rows during upgrade.
do $$
begin
  if exists (
    select 1
      from core.audit_event event
      join core.action action on action.id = event.action_id
     where event.effective_at is distinct from action.effective_at
  ) then
    raise exception 'existing audit/action effective_at values do not match exactly'
      using errcode = 'check_violation';
  end if;
end
$$;

do $$
begin
  if exists (
    with linked as (
      select event.seq, event.prev_digest,
             lag(event.digest) over (order by event.seq) as expected_prev
        from core.audit_event event
    )
    select 1 from linked
     where (expected_prev is null and prev_digest <> repeat('0', 64))
        or (expected_prev is not null and prev_digest <> expected_prev)
  ) then
    raise exception 'existing audit history does not form one global predecessor chain'
      using errcode = 'check_violation';
  end if;
end
$$;

-- Global audit order crosses tenant RLS boundaries. A tenant-scoped query cannot safely find
-- its predecessor: the real previous event may belong to another organization. Keep one
-- derived opaque head outside tenant rows and advance it under a database-owned row lock.
create table core.audit_chain_head (
  singleton boolean primary key default true check (singleton),
  seq       bigint not null check (seq >= 0),
  digest    text not null check (digest ~ '^[0-9a-f]{64}$')
);

insert into core.audit_chain_head (singleton, seq, digest)
select true, coalesce(event.seq, 0), coalesce(event.digest, repeat('0', 64))
  from (select 1) seed
  left join lateral (
    select audit.seq, audit.digest from core.audit_event audit order by audit.seq desc limit 1
  ) event on true;

revoke all on core.audit_chain_head from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
grant select (digest) on core.audit_chain_head to kf_app;

create function core.enforce_audit_chain_head() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_seq bigint;
  v_digest text;
begin
  select head.seq, head.digest into strict v_seq, v_digest
    from core.audit_chain_head head
   where head.singleton
   for update;

  if new.seq <= v_seq then
    raise exception 'audit event sequence % does not advance global head %', new.seq, v_seq
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.prev_digest is distinct from v_digest then
    raise exception 'audit event predecessor does not match global chain head'
      using errcode = 'integrity_constraint_violation';
  end if;

  update core.audit_chain_head set seq = new.seq, digest = new.digest where singleton;
  return new;
end
$$;

revoke all on function core.enforce_audit_chain_head() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create trigger audit_event_global_chain_head
  before insert on core.audit_event
  for each row execute function core.enforce_audit_chain_head();

comment on table core.audit_chain_head is
  'Derived global audit append cursor. Not preservation authority; restore rebuilds it only after verifying every event link and digest. Application can read only opaque digest needed for next append.';

-- migrate:down

drop trigger if exists audit_event_global_chain_head on core.audit_event;
drop function if exists core.enforce_audit_chain_head();
drop table if exists core.audit_chain_head;
alter table core.audit_event
  drop constraint if exists audit_event_effective_at_canonical_wire;
alter table core.action
  drop constraint if exists action_effective_at_canonical_wire;
