-- migrate:up

-- Agents submit; authority verifies (ADR 0040 decisions 5 and 6, SAS §24B, KF-SAS-RQ-263 to
-- RQ-266; closes §100.46 and §100.47 for milestone M2, KF-WAR-0004).
--
-- ADR 0035 made an agent's act the person's act with the agent's participation recorded by the
-- database. Nothing yet said what that participation MEANS for trust. This migration says it,
-- in the database, in five parts:
--
--   1. AN AGENT NEVER PERFORMS AN INSTITUTIONAL ACT. An act whose type `requires: act` (ADR 0016,
--      `registry.action_type.requires_capability = 'act'`) is refused when the bound attestation
--      names an agent, whatever grants reach the person. So is an agent's `verify_record` (a
--      verification is a person's judgement) and an agent's resolution of a proposal. The agent
--      may PROPOSE an institutional act (part 4); only its person performs it. KF-SAS-RQ-265.
--
--   2. A VERIFICATION POLICY, as data: `core.verification_policy`, one row per decision, per
--      organization, record kind (`object_type`), the act that writes it, and declared agent,
--      `required` (the default, which is also what no row means) or `verified_on_submit`. Rows are
--      written only by the act `set_verification_policy`, which is itself institutional, so no
--      agent can set its own trust. Append-only: a later row for the same key supersedes, and the
--      history of who trusted which agent for what stays. The database refuses
--      `verified_on_submit` for an institutional act type (KF-VPOL-001) and for an agent that is
--      not a live declared one (KF-VPOL-002). KF-SAS-RQ-264.
--
--   3. VERIFIED BY POLICY, a third basis beside `reviewed_individually` and `promoted_in_bulk`
--      (KF-SAS-RQ-231): `core.object_verification.basis = 'verified_by_policy'` with `policy_id`
--      naming the policy row that applied. Written only by the database, at commit, for a record
--      an agent's act created when the policy in force for (organization, kind, act, agent) says
--      `verified_on_submit`; `verified_by` is the person who set that policy. A forged row is
--      refused (KF-VPOL-003), and no row is ever written for an institutional act, even by an
--      administrator session. Absence remains the unverified state (20260918000100): with no
--      policy, an agent's record is unverified until a person verifies it. KF-SAS-RQ-263.
--
--   4. PROPOSALS. `core.act_proposal` holds an institutional act an agent proposed for its person:
--      the type, targets, payload, reason and the request digest the person's own act would carry
--      (`kf-action-request-v1`), written by the act `propose_act` under the agent's attestation.
--      `core.act_proposal_resolution` records the person's answer, once: `declined`, or
--      `confirmed` naming the act they performed, which must be theirs, with no agent, of the
--      proposed type and with the proposed request digest (KF-AGENT-005). A proposal becomes an
--      act only by its person performing that act; never by expiry, policy or bulk.
--
--   5. WHAT AN AGENT TOUCHED, findable: a partial index on the acts with an agent's participation,
--      so "unverified records an agent wrote" (Needs you) reads only those acts.
--
-- THE GUARDS THIS INHERITS. Every new table: row security enabled and forced, every policy's
-- context function wrapped as `(select …)`, the act write guard (core.install_action_context_guards),
-- a kf_backup read policy, and a declared exemption from the master-record input triggers (none is
-- read by a permitted set). None is transient (§64B): policies, proposals and resolutions are
-- records of decisions, exported and restored.

-- 0. Helpers ------------------------------------------------------------------------------------

-- Whether an action type is institutional: it declares `requires: act` (ADR 0016).
create function core.action_type_is_institutional(p_action_type text) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, registry
as $$
  select coalesce(
    (select requires_capability = 'act' from registry.action_type where id = p_action_type),
    false)
$$;

revoke all on function core.action_type_is_institutional(text) from public;
grant execute on function core.action_type_is_institutional(text) to kf_app, kf_worker;

-- The agent the bound attestation names, or null (20260925100000 seals it on every bind).
create function core.current_agent_or_null() returns text
language sql
stable
security definer
set search_path = pg_catalog, core
as $$ select core.sealed_setting('kf.agent_participation', true) $$;

revoke all on function core.current_agent_or_null() from public;
grant execute on function core.current_agent_or_null() to kf_app, kf_worker;

-- The person the session is bound as (core.bind_principal seals it), for reads: a read route binds
-- a principal and no act, so `core.current_actor_or_null()`, the act's actor, is null there.
create function core.current_principal_or_null() returns uuid
language sql
stable
as $$ select core.sealed_setting('kf.principal', true)::uuid $$;

grant execute on function core.current_principal_or_null() to kf_app, kf_worker;

-- The act this transaction recorded, or null. A row of the three tables below is written only by
-- its own act: the act write guard (20260925011000) proves a write belongs to SOME act recorded in
-- this transaction, not that the act's type writes this table, so without this a compromised API
-- could write a policy under a cheap act and step around set_verification_policy's act authority.
-- The dispatcher records the act before its effects run (applyAction), so it is there to read.
create function core.current_action_type() returns text
language sql
stable
security definer
set search_path = pg_catalog, core
as $$ select a.action_type from core.action a where a.id = core.current_action_id() $$;

revoke all on function core.current_action_type() from public;

-- 1. An agent never performs an institutional act -----------------------------------------------

create function core.action_agent_bar() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, registry
as $$
declare
  v_agent text;
begin
  if core.session_is_administrator() then
    return new;
  end if;
  v_agent := core.current_agent_or_null();
  if v_agent is null then
    return new;
  end if;
  if core.action_type_is_institutional(new.action_type) then
    raise exception 'KF-AGENT-001: % is an institutional act; agent % acting for this person may '
      'propose it (propose_act) and only the person performs it (KF-SAS-RQ-265)',
      new.action_type, v_agent
      using errcode = 'check_violation';
  end if;
  if new.action_type in ('verify_record', 'resolve_act_proposal') then
    raise exception 'KF-AGENT-002: % is a person''s own judgement; agent % acting for this person '
      'may not record it (KF-SAS-RQ-263, RQ-265)', new.action_type, v_agent
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

revoke all on function core.action_agent_bar() from public;

create trigger action_agent_bar
  before insert on core.action
  for each row execute function core.action_agent_bar();

-- 2. The verification policy --------------------------------------------------------------------

create table core.verification_policy (
  id               uuid primary key default uuidv7(),
  -- Supersession order within a key: the highest revision is in force. By default rather than
  -- always, so a restore keeps the archive's numbers; outside an administrator session the
  -- database draws it (verification_policy_bounded), whatever the insert said.
  revision         bigint generated by default as identity unique,
  organization_id  uuid not null references org.organization (id) on delete restrict,
  object_type      text not null references registry.object_type (id),
  action_type      text not null references registry.action_type (id),
  agent_client_id  text not null
                   check (agent_client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'),
  mode             text not null check (mode in ('required', 'verified_on_submit')),
  reason           text not null check (length(btrim(reason)) >= 8),
  set_by           uuid not null references org.person (id),
  set_by_action    uuid not null unique references core.action (id) on delete restrict,
  set_at           timestamptz not null default now()
);

create index verification_policy_key
  on core.verification_policy (organization_id, object_type, action_type, agent_client_id, revision desc);

comment on table core.verification_policy is
  'Whether records of a kind, written by an act, with a declared agent''s participation, are '
  'verified on arrival (KF-SAS-RQ-264). Absence, or mode required, means a person verifies. '
  'Append-only; the highest revision per key is in force. Written only by set_verification_policy, '
  'an institutional act. Never verified_on_submit for an institutional act type (KF-VPOL-001).';

-- The policy in force for one key, or no row. Definer: it is asked by the commit-time trigger and
-- the basis guard, which must see the policy whatever the bound reader may see.
create function core.verification_policy_in_force(
  p_organization uuid, p_object_type text, p_action_type text, p_agent text)
returns setof core.verification_policy
language sql
stable
security definer
set search_path = pg_catalog, core
as $$
  select p.*
    from core.verification_policy p
   where p.organization_id = p_organization
     and p.object_type = p_object_type
     and p.action_type = p_action_type
     and p.agent_client_id = p_agent
   order by p.revision desc
   limit 1
$$;

revoke all on function core.verification_policy_in_force(uuid, text, text, text) from public;

create function core.verification_policy_bounded() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, org, registry
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'a verification policy is superseded by a later one, never % (Law 6)', lower(tg_op)
      using errcode = 'insufficient_privilege';
  end if;
  -- The institutional bar holds in every session, an administrator's included: no policy can ever
  -- name an institutional act as verified on submit (KF-SAS-RQ-265).
  if new.mode = 'verified_on_submit' and core.action_type_is_institutional(new.action_type) then
    raise exception 'KF-VPOL-001: % is an institutional act, and no verification policy applies to '
      'an institutional act (KF-SAS-RQ-265)', new.action_type
      using errcode = 'check_violation';
  end if;
  if core.session_is_administrator() then
    return new;
  end if;
  if new.mode = 'verified_on_submit' and not exists (
       select 1 from org.declared_agent d
        where d.client_id = new.agent_client_id and d.withdrawn_at is null) then
    raise exception 'KF-VPOL-002: % is not a live declared agent; a policy trusts a declared agent '
      'or none (ADR 0035)', new.agent_client_id
      using errcode = 'check_violation';
  end if;
  if core.current_action_type() is distinct from 'set_verification_policy' then
    raise exception 'KF-VPOL-004: a verification policy is written only by set_verification_policy, '
      'an institutional act; this transaction recorded %', coalesce(core.current_action_type(), 'no act')
      using errcode = 'check_violation';
  end if;
  -- Who decided, by which act, when, and in what order: the database's, never the caller's.
  new.revision := nextval(pg_get_serial_sequence('core.verification_policy', 'revision'));
  new.set_by := core.current_actor_or_null();
  new.set_by_action := core.current_action_id();
  new.set_at := now();
  return new;
end
$$;

revoke all on function core.verification_policy_bounded() from public;

create trigger verification_policy_bounded
  before insert or update or delete on core.verification_policy
  for each row execute function core.verification_policy_bounded();

create trigger verification_policy_guard_context
  before insert on core.verification_policy
  for each row execute function core.require_transaction_context();

alter table core.verification_policy enable row level security;
alter table core.verification_policy force row level security;

create policy verification_policy_read on core.verification_policy
  for select
  using (organization_id = (select core.current_organization()));

create policy verification_policy_insert on core.verification_policy
  for insert
  with check (
    organization_id = (select core.current_organization())
    and set_by = (select core.current_actor_or_null())
    and set_by_action = (select core.current_action_id())
  );

create policy verification_policy_auditor_read on core.verification_policy
  for select to kf_auditor using (true);
create policy verification_policy_backup_read on core.verification_policy
  for select to kf_backup using (true);

revoke all on core.verification_policy from public;
grant select, insert on core.verification_policy to kf_app;
grant select on core.verification_policy to kf_readonly, kf_auditor, kf_backup;
-- pg_dump locks and reads every sequence it dumps (20260925130000).
grant select on sequence core.verification_policy_revision_seq to kf_backup;

-- 3. Verified by policy -------------------------------------------------------------------------

alter table core.object_verification
  add column policy_id uuid references core.verification_policy (id) on delete restrict;

alter table core.object_verification
  drop constraint object_verification_basis_check;
alter table core.object_verification
  add constraint object_verification_basis_check
  check (basis in ('reviewed_individually', 'promoted_in_bulk', 'verified_by_policy'));
alter table core.object_verification
  add constraint object_verification_policy_names_its_basis
  check ((basis = 'verified_by_policy') = (policy_id is not null));

comment on column core.object_verification.policy_id is
  'The verification policy that verified this record on arrival (basis verified_by_policy), and '
  'null for every verification a person made (KF-SAS-RQ-264).';

-- A verification row says what it is. A person's (individual or bulk) is never recorded under an
-- agent's attestation; a policy's is recorded only when the policy it names was in force for the
-- record's kind, the act that wrote it and that act's agent, and never for an institutional act.
create function core.object_verification_basis_guard() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, registry
as $$
declare
  v_object core.object%rowtype;
  v_action core.action%rowtype;
  v_policy core.verification_policy%rowtype;
begin
  if new.basis <> 'verified_by_policy' then
    if not core.session_is_administrator() and core.current_agent_or_null() is not null then
      raise exception 'KF-AGENT-002: a verification is a person''s judgement; agent % acting for '
        'this person may not record one (KF-SAS-RQ-263)', core.current_agent_or_null()
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select * into v_action from core.action where id = new.recorded_by_action;
  -- In every session: no policy verifies what an institutional act wrote (KF-SAS-RQ-265).
  if found and core.action_type_is_institutional(v_action.action_type) then
    raise exception 'KF-VPOL-001: % is an institutional act, and no verification policy applies to '
      'an institutional act (KF-SAS-RQ-265)', v_action.action_type
      using errcode = 'check_violation';
  end if;
  if core.session_is_administrator() then
    return new;
  end if;

  select * into v_object from core.object where id = new.object_id;
  select * into v_policy
    from core.verification_policy_in_force(v_object.organization_id, v_object.object_type,
                                            v_action.action_type, v_action.agent_participation);
  if v_action.id is null
     or v_action.agent_participation is null
     or v_policy.id is distinct from new.policy_id
     or v_policy.mode <> 'verified_on_submit'
     or new.verified_by is distinct from v_policy.set_by
     or v_action.organization_id is distinct from v_object.organization_id
     or not (new.object_id = any(v_action.target_ids) or v_action.id = core.current_action_id()) then
    raise exception 'KF-VPOL-003: record % was not written by an act a verification policy in force '
      'verifies on submit; verified_by_policy is the database''s to record (KF-SAS-RQ-264)',
      new.object_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

revoke all on function core.object_verification_basis_guard() from public;

create trigger object_verification_basis_guard
  before insert on core.object_verification
  for each row execute function core.object_verification_basis_guard();

-- At commit, for every record an agent's act created: verify it if, and only if, the policy in
-- force for its kind, the act and the agent says so. Deferred because the dispatcher creates a
-- record before it writes the act (prepareActionState, then applyAction); by commit both exist.
-- Run with `set constraints all immediate`, the act is not yet there and nothing is verified:
-- the failure is towards unverified, never towards trusted.
create function core.verify_by_policy_at_commit() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, registry
as $$
declare
  v_agent  text;
  v_action core.action%rowtype;
  v_policy core.verification_policy%rowtype;
begin
  if core.session_is_administrator() then
    return null;
  end if;
  v_agent := core.current_agent_or_null();
  if v_agent is null then
    return null;
  end if;
  -- The act that wrote the record: the first act of this transaction naming it as a target (a
  -- created record joins its act's targets), else the bound act (a record an effect created).
  select a.* into v_action
    from core.action a
   where new.id = any(a.target_ids)
     and a.organization_id = new.organization_id
     and a.recorded_at = transaction_timestamp()
   order by a.id
   limit 1;
  if not found then
    select a.* into v_action from core.action a where a.id = core.current_action_id();
    if not found then
      return null;
    end if;
  end if;
  if v_action.agent_participation is distinct from v_agent
     or core.action_type_is_institutional(v_action.action_type) then
    return null;
  end if;
  select * into v_policy
    from core.verification_policy_in_force(new.organization_id, new.object_type,
                                            v_action.action_type, v_agent);
  if not found or v_policy.mode <> 'verified_on_submit' then
    return null;
  end if;
  if exists (select 1 from core.object_verification where object_id = new.id) then
    return null;
  end if;
  insert into core.object_verification (object_id, verified_by, basis, policy_id, recorded_by_action)
  values (new.id, v_policy.set_by, 'verified_by_policy', v_policy.id, v_action.id);
  return null;
end
$$;

revoke all on function core.verify_by_policy_at_commit() from public;

-- The WHEN clause is evaluated as the row is written, so an insert with no agent bound (every
-- person's own act, every sync, every import) queues nothing.
create constraint trigger object_verified_by_policy
  after insert on core.object
  deferrable initially deferred
  for each row
  when (core.current_agent_or_null() is not null)
  execute function core.verify_by_policy_at_commit();

-- 4. Proposals ----------------------------------------------------------------------------------

create table core.act_proposal (
  id                 uuid primary key default uuidv7(),
  organization_id    uuid not null references org.organization (id) on delete restrict,
  -- The person the agent acted for, who alone may perform or decline it.
  proposed_for       uuid not null references org.person (id),
  -- The assignment the proposal was made under; the person confirms under the same one, so the
  -- request digest below is the one their act will carry.
  acting_role_id     uuid not null,
  agent_client_id    text not null
                     check (agent_client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'),
  action_type        text not null references registry.action_type (id),
  -- Empty for an act that names no target (one that creates what it acts on).
  target_ids         uuid[] not null,
  payload            jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  reason             text,
  -- `kf-action-request-v1` of the act as the person would dispatch it (semanticActionRequestDigest).
  request_digest     text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  proposed_by_action uuid not null unique references core.action (id) on delete restrict,
  proposed_at        timestamptz not null default now()
);

create index act_proposal_for_person on core.act_proposal (organization_id, proposed_for, proposed_at desc);

comment on table core.act_proposal is
  'An institutional act an agent proposed for its person (KF-SAS-RQ-265). Performs nothing. '
  'Written by propose_act under the agent''s attestation; resolved once, by the person, in '
  'core.act_proposal_resolution. Append-only.';

create table core.act_proposal_resolution (
  proposal_id        uuid primary key references core.act_proposal (id) on delete restrict,
  organization_id    uuid not null references org.organization (id) on delete restrict,
  resolution         text not null check (resolution in ('confirmed', 'declined')),
  performed_action   uuid unique references core.action (id) on delete restrict,
  resolved_by        uuid not null references org.person (id),
  resolved_by_action uuid not null unique references core.action (id) on delete restrict,
  resolved_at        timestamptz not null default now(),
  check ((resolution = 'confirmed') = (performed_action is not null))
);

comment on table core.act_proposal_resolution is
  'The person''s answer to an agent''s proposal: declined, or confirmed naming the act they '
  'performed (theirs, no agent, the proposed type and request digest). Once; append-only.';

create function core.act_proposal_bounded() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, registry
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'a proposal is resolved, never % (Law 6)', lower(tg_op)
      using errcode = 'insufficient_privilege';
  end if;
  if not core.action_type_is_institutional(new.action_type) then
    raise exception 'KF-AGENT-003: % is not an institutional act; an agent performs it for its '
      'person rather than proposing it', new.action_type
      using errcode = 'check_violation';
  end if;
  if core.session_is_administrator() then
    return new;
  end if;
  if core.current_agent_or_null() is null then
    raise exception 'KF-AGENT-004: a proposal is an agent''s; a person performs the act directly'
      using errcode = 'check_violation';
  end if;
  if core.current_action_type() is distinct from 'propose_act' then
    raise exception 'KF-AGENT-006: a proposal is written only by propose_act; this transaction '
      'recorded %', coalesce(core.current_action_type(), 'no act')
      using errcode = 'check_violation';
  end if;
  new.organization_id := core.current_organization();
  new.proposed_for := core.current_actor_or_null();
  new.acting_role_id := core.current_acting_role();
  new.agent_client_id := core.current_agent_or_null();
  new.proposed_by_action := core.current_action_id();
  new.proposed_at := now();
  return new;
end
$$;

revoke all on function core.act_proposal_bounded() from public;

create trigger act_proposal_bounded
  before insert or update or delete on core.act_proposal
  for each row execute function core.act_proposal_bounded();

create trigger act_proposal_guard_context
  before insert on core.act_proposal
  for each row execute function core.require_transaction_context();

create function core.act_proposal_resolution_bounded() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, registry
as $$
declare
  v_proposal core.act_proposal%rowtype;
  v_act      core.action%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'a proposal is resolved once, never % (Law 6)', lower(tg_op)
      using errcode = 'insufficient_privilege';
  end if;
  if core.session_is_administrator() then
    return new;
  end if;
  if core.current_agent_or_null() is not null then
    raise exception 'KF-AGENT-002: resolving a proposal is the person''s own judgement; agent % may '
      'not record it (KF-SAS-RQ-265)', core.current_agent_or_null()
      using errcode = 'check_violation';
  end if;
  if core.current_action_type() is distinct from 'resolve_act_proposal' then
    raise exception 'KF-AGENT-006: a resolution is written only by resolve_act_proposal; this '
      'transaction recorded %', coalesce(core.current_action_type(), 'no act')
      using errcode = 'check_violation';
  end if;
  select * into v_proposal from core.act_proposal where id = new.proposal_id;
  if not found
     or v_proposal.proposed_for is distinct from core.current_actor_or_null()
     or v_proposal.organization_id is distinct from core.current_organization() then
    raise exception 'KF-AGENT-005: proposal % is not one awaiting this person', new.proposal_id
      using errcode = 'check_violation';
  end if;
  if new.resolution = 'confirmed' then
    select * into v_act from core.action where id = new.performed_action;
    if not found
       or v_act.actor_id is distinct from v_proposal.proposed_for
       or v_act.organization_id is distinct from v_proposal.organization_id
       or v_act.action_type is distinct from v_proposal.action_type
       or v_act.request_digest is distinct from v_proposal.request_digest
       or v_act.agent_participation is not null
       or v_act.result_status is distinct from 'applied' then
      raise exception 'KF-AGENT-005: act % is not the proposed act performed by its person; a '
        'proposal is confirmed only by the person performing exactly what was proposed',
        new.performed_action
        using errcode = 'check_violation';
    end if;
  end if;
  new.organization_id := v_proposal.organization_id;
  new.resolved_by := core.current_actor_or_null();
  new.resolved_by_action := core.current_action_id();
  new.resolved_at := now();
  return new;
end
$$;

revoke all on function core.act_proposal_resolution_bounded() from public;

create trigger act_proposal_resolution_bounded
  before insert or update or delete on core.act_proposal_resolution
  for each row execute function core.act_proposal_resolution_bounded();

create trigger act_proposal_resolution_guard_context
  before insert on core.act_proposal_resolution
  for each row execute function core.require_transaction_context();

alter table core.act_proposal enable row level security;
alter table core.act_proposal force row level security;
alter table core.act_proposal_resolution enable row level security;
alter table core.act_proposal_resolution force row level security;

-- A proposal is visible to the person it waits for, in the organization it was made in, and to
-- nobody else: it names what their agent asked them to do.
create policy act_proposal_read on core.act_proposal
  for select
  using (
    organization_id = (select core.current_organization())
    and proposed_for = (select core.current_principal_or_null())
  );
create policy act_proposal_insert on core.act_proposal
  for insert
  with check (
    organization_id = (select core.current_organization())
    and proposed_for = (select core.current_actor_or_null())
    and proposed_by_action = (select core.current_action_id())
  );
create policy act_proposal_auditor_read on core.act_proposal
  for select to kf_auditor using (true);
create policy act_proposal_backup_read on core.act_proposal
  for select to kf_backup using (true);

create policy act_proposal_resolution_read on core.act_proposal_resolution
  for select
  using (
    organization_id = (select core.current_organization())
    and resolved_by = (select core.current_principal_or_null())
  );
create policy act_proposal_resolution_insert on core.act_proposal_resolution
  for insert
  with check (
    organization_id = (select core.current_organization())
    and resolved_by = (select core.current_actor_or_null())
    and resolved_by_action = (select core.current_action_id())
  );
create policy act_proposal_resolution_auditor_read on core.act_proposal_resolution
  for select to kf_auditor using (true);
create policy act_proposal_resolution_backup_read on core.act_proposal_resolution
  for select to kf_backup using (true);

revoke all on core.act_proposal, core.act_proposal_resolution from public;
grant select, insert on core.act_proposal, core.act_proposal_resolution to kf_app;
grant select on core.act_proposal, core.act_proposal_resolution to kf_readonly, kf_auditor, kf_backup;

-- 5. What an agent touched ----------------------------------------------------------------------

-- Needs you reads an organization's agent acts newest first; nothing else reads this index, and
-- an act with no agent (nearly all of them) is not in it.
create index action_agent_recent on core.action (organization_id, recorded_at desc)
  where agent_participation is not null;

-- 6. The guards every new table inherits --------------------------------------------------------

-- None of the three is read by a master-record permitted set, its payload walk or an input policy.
insert into content.master_record_input_exemption (table_name, reason) values
  ('core.verification_policy',
   'Who trusts which agent for what kind; read at commit to verify, never by a permitted-set read.'),
  ('core.act_proposal',
   'Institutional acts an agent proposed; read by Needs you, never by a permitted-set enumeration.'),
  ('core.act_proposal_resolution',
   'A person''s answer to a proposal; read by Needs you, never by a permitted-set enumeration.');

-- Every row kf_app writes here belongs to an act recorded in this transaction (20260925011000).
select core.install_action_context_guards();

-- migrate:down

drop trigger if exists zz_written_under_an_act on core.verification_policy;
drop trigger if exists written_act_is_recorded on core.verification_policy;
drop trigger if exists zz_written_under_an_act on core.act_proposal;
drop trigger if exists written_act_is_recorded on core.act_proposal;
drop trigger if exists zz_written_under_an_act on core.act_proposal_resolution;
drop trigger if exists written_act_is_recorded on core.act_proposal_resolution;

delete from content.master_record_input_exemption
 where table_name in ('core.verification_policy', 'core.act_proposal',
                      'core.act_proposal_resolution');

drop index if exists core.action_agent_recent;

drop table core.act_proposal_resolution;
drop table core.act_proposal;
drop function core.act_proposal_resolution_bounded();
drop function core.act_proposal_bounded();

drop trigger object_verified_by_policy on core.object;
drop function core.verify_by_policy_at_commit();
drop trigger object_verification_basis_guard on core.object_verification;
drop function core.object_verification_basis_guard();

-- Rolling back past this release forgets every verification a policy made: they become
-- unverified, which is the direction a rollback may err in. Take an export first if they matter.
-- The table is append-only (object_verification_append_only, a statement trigger, so it refuses
-- even a delete that matches nothing). This section forgets those rows deliberately; until
-- 2026-10-07 it ran into the guard and no rollback past this migration could complete
-- (tests/database/rollback-to-floor.test.ts). The guard is back on before anything else runs.
alter table core.object_verification disable trigger object_verification_append_only;
delete from core.object_verification where basis = 'verified_by_policy';
alter table core.object_verification enable trigger object_verification_append_only;
alter table core.object_verification drop constraint object_verification_policy_names_its_basis;
alter table core.object_verification drop constraint object_verification_basis_check;
alter table core.object_verification
  add constraint object_verification_basis_check
  check (basis in ('reviewed_individually', 'promoted_in_bulk'));
alter table core.object_verification drop column policy_id;

-- The function first: it returns the table's row type, so the table cannot go while it exists.
-- This order was the other way round until 2026-10-07 (tests/database/rollback-to-floor.test.ts).
drop function core.verification_policy_in_force(uuid, text, text, text);
drop table core.verification_policy;
drop function core.verification_policy_bounded();

drop trigger action_agent_bar on core.action;
drop function core.action_agent_bar();
drop function core.current_action_type();
drop function core.current_principal_or_null();
drop function core.current_agent_or_null();
drop function core.action_type_is_institutional(text);
