-- migrate:up

-- An agent acts for a named human, and the ledger says so (ADR 0035, KF-SAS-RQ-204, SAS §100.19).
--
-- An agent forms and dispatches an act on a token it obtained by OAuth 2.0 token exchange: `sub` is
-- the person, `azp` the agent's client, and — because Keycloak 26.4 emits no `act` claim of its own
-- — `act.client_id` stamped by the agent client's mapper. kf-attestor verifies the token, checks the
-- `act` shape (exactly `{client_id}`, equal to `azp`, one level deep), and asks for an attestation
-- naming the agent. The act stays the person's: actor, role, clearance and grants are theirs.
--
-- THREE THINGS HERE.
--
--   1. `org.declared_agent`: which clients may take part at all. Written only over the owner
--      credential (`kf declare-agent`); no application, worker or attestor login reads it — the
--      definer `core.issue_attestation` does. Kept in the database rather than as a realm
--      attribute for the reason role claims are never read: a realm administrator must not be able
--      to make a client an agent without touching this system. Rows are never deleted; the only
--      change a row accepts is its withdrawal, once.
--
--   2. The attestation records the agent. `core.issue_attestation` takes the token's `act.client_id`
--      and its `azp`, refuses a client that is not a live declared agent, and refuses a token with no
--      `act` whose `azp` IS a declared agent (a declared agent whose mapper was removed must not pass
--      as the person). The refusal happens before anything is stored, so nothing is attested.
--
--   3. `core.action.agent_participation`, written by the DATABASE. `core.bind_principal` reads the
--      agent from the attestation it was handed and seals it as `kf.agent_participation`; a BEFORE
--      INSERT trigger on `core.action` copies the sealed value over whatever the application
--      supplied. An administrator session (bootstrap, fixtures, restore) keeps a supplied value — a
--      restore must bring history back as recorded — and otherwise gets the sealed one too.
--      Existing rows are null: nothing before this acted through an agent.
--
-- WHAT DOES NOT CHANGE. The audit-chain preimage does not include the column, so every audit digest
-- (v1 and v2 links) is unchanged. `action_scoped_insert` is unchanged: the trigger runs before it.

-- 1. Declared agents ---------------------------------------------------------------------------

create table org.declared_agent (
  client_id        text primary key
                   check (client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'),
  declared_by      uuid not null references org.person (id),
  reason           text not null check (length(btrim(reason)) >= 8),
  declared_at      timestamptz not null default now(),
  declared_login   name not null default session_user,
  withdrawn_at     timestamptz,
  withdrawn_by     uuid references org.person (id),
  withdrawn_reason text check (withdrawn_reason is null or length(btrim(withdrawn_reason)) >= 8),
  withdrawn_login  name,
  constraint declared_agent_withdrawal_complete check (
    (withdrawn_at is null and withdrawn_by is null and withdrawn_reason is null
       and withdrawn_login is null)
    or (withdrawn_at is not null and withdrawn_by is not null and withdrawn_reason is not null
        and withdrawn_login is not null and withdrawn_at >= declared_at))
);

comment on table org.declared_agent is
  'OAuth clients that may act for a person on an exchanged token (ADR 0035). Written only over '
  'the owner credential (kf declare-agent); read only by core.issue_attestation. Never deleted; '
  'a withdrawal is the only change a row accepts.';

revoke all on org.declared_agent from public;

-- A declaration is a fact about who decided what; it is withdrawn, never rewritten or removed.
create function org.declared_agent_is_append_only() returns trigger
language plpgsql
set search_path = pg_catalog, org
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a declared agent is withdrawn, never deleted (%)', old.client_id
      using errcode = 'insufficient_privilege';
  end if;
  if old.withdrawn_at is not null then
    raise exception 'declared agent % was already withdrawn at %', old.client_id, old.withdrawn_at
      using errcode = 'insufficient_privilege';
  end if;
  if new.client_id is distinct from old.client_id
     or new.declared_by is distinct from old.declared_by
     or new.reason is distinct from old.reason
     or new.declared_at is distinct from old.declared_at
     or new.declared_login is distinct from old.declared_login then
    raise exception 'a declaration of agent % is withdrawn, not rewritten', old.client_id
      using errcode = 'insufficient_privilege';
  end if;
  new.withdrawn_at := now();
  new.withdrawn_login := session_user;
  return new;
end
$$;

create trigger declared_agent_is_append_only
  before update or delete on org.declared_agent
  for each row execute function org.declared_agent_is_append_only();

-- 2. The attestation names the agent ------------------------------------------------------------

alter table core.principal_attestation add column agent_client_id text;

comment on column core.principal_attestation.agent_client_id is
  'The declared agent client the token was exchanged for (its act.client_id), or null for a '
  'person''s own token. core.bind_principal seals it; core.action.agent_participation copies it.';

drop function core.issue_attestation(uuid, uuid, uuid, text, timestamptz);

create function core.issue_attestation(
  p_person           uuid,
  p_assignment       uuid,
  p_organization     uuid,
  p_ceiling          text,
  p_token_expiry     timestamptz,
  p_agent_client     text default null,
  p_authorized_party text default null
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_ceiling text;
  v_secret  bytea := public.gen_random_bytes(32);
  v_expiry  timestamptz;
begin
  if p_token_expiry is not null and p_token_expiry <= now() then
    raise exception 'the token has already expired'
      using errcode = 'insufficient_privilege';
  end if;
  -- The agent, before anything else is looked at: an undeclared client is refused whoever the
  -- person is, and the refusal says so in words the attestor maps to `undeclared_agent`.
  if p_agent_client is not null then
    if not exists (select 1 from org.declared_agent d
                    where d.client_id = p_agent_client and d.withdrawn_at is null) then
      raise exception 'client % is not a declared agent', p_agent_client
        using errcode = 'insufficient_privilege',
              hint = 'An owner declares agent clients with kf declare-agent (ADR 0035).';
    end if;
    if p_authorized_party is not null and p_authorized_party <> p_agent_client then
      raise exception 'the token names agent % but was issued to client %',
        p_agent_client, p_authorized_party
        using errcode = 'insufficient_privilege';
    end if;
  elsif p_authorized_party is not null
        and exists (select 1 from org.declared_agent d where d.client_id = p_authorized_party) then
    -- Issued to a (possibly withdrawn) declared agent and carrying no act: the agent's mapper is
    -- gone, and the token would otherwise pass as the person acting directly.
    raise exception 'client % is a declared agent, and its token does not name it', p_authorized_party
      using errcode = 'insufficient_privilege',
            hint = 'The agent client must stamp act.client_id with its own id (ADR 0035).';
  end if;
  if exists (select 1 from org.person where id = p_person and person_kind = 'service') then
    raise exception 'person % is a service actor; a service actor is never present', p_person
      using errcode = 'insufficient_privilege';
  end if;
  if not core.assignment_is_live(p_person, p_assignment, p_organization) then
    raise exception 'role assignment % is not held live by % in organization %',
      p_assignment, p_person, p_organization
      using errcode = 'insufficient_privilege';
  end if;
  select requested_classification into v_ceiling
    from org.resolve_effective_classification(p_person, p_organization, p_assignment, p_ceiling);

  v_expiry := least(coalesce(p_token_expiry, 'infinity'::timestamptz), now() + interval '60 seconds');

  -- Housekeeping, bounded by the index: nothing reads an expired row.
  delete from core.principal_attestation where expires_at < now() - interval '5 minutes';

  insert into core.principal_attestation
    (digest, person_id, assignment_id, organization_id, ceiling, expires_at, agent_client_id)
  values (sha256(v_secret), p_person, p_assignment, p_organization, v_ceiling, v_expiry,
          p_agent_client);

  return encode(v_secret, 'hex');
end
$$;

revoke all on function core.issue_attestation(uuid, uuid, uuid, text, timestamptz, text, text)
  from public;
grant execute on function core.issue_attestation(uuid, uuid, uuid, text, timestamptz, text, text)
  to kf_attestor;

-- 3. The bind seals the agent; the ledger row copies it ----------------------------------------

create or replace function core.bind_principal(
  p_subject      uuid,
  p_assignment   uuid,
  p_organization uuid,
  p_requested    text,
  p_attestation  text default null
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_existing text := core.sealed_setting('kf.principal', true);
  v_ceiling  text;
  v_agent    text;
begin
  if v_existing is not null and v_existing <> p_subject::text then
    raise exception 'transaction already bound to a different principal'
      using errcode = 'insufficient_privilege',
            hint = 'One transaction, one principal. Start a new transaction for another.';
  end if;
  if not core.assignment_is_live(p_subject, p_assignment, p_organization) then
    raise exception 'role assignment % is not held live by % in organization %',
      p_assignment, p_subject, p_organization
      using errcode = 'insufficient_privilege';
  end if;
  select requested_classification into v_ceiling
    from org.resolve_effective_classification(p_subject, p_organization, p_assignment, p_requested);

  if core.session_is_application() then
    if core.session_is_service_actor() then
      if not exists (select 1 from org.person where id = p_subject and person_kind = 'service') then
        raise exception 'a service-actor login binds only service actors, and % is not one', p_subject
          using errcode = 'insufficient_privilege';
      end if;
    elsif p_attestation is null
       or p_attestation !~ '^[0-9a-f]{64}$'
       or not exists (
         select 1
           from core.principal_attestation a
           join registry.classification attested on attested.id = a.ceiling
           join registry.classification bound on bound.id = v_ceiling
          where a.digest = sha256(decode(p_attestation, 'hex'))
            and a.person_id = p_subject
            and a.assignment_id = p_assignment
            and a.organization_id = p_organization
            and a.expires_at > now()
            and bound.rank <= attested.rank) then
      raise exception 'no current attestation that % is present under assignment % in organization %',
        p_subject, p_assignment, p_organization
        using errcode = 'insufficient_privilege',
              hint = 'The application binds a person only on an attestation from kf-attestor.';
    end if;
  end if;

  -- The agent the attestation names, if any. For an application session the row was just shown
  -- to exist; for every other tier an attestation is optional, and one that does not match this
  -- principal names nobody. Sealed every time, null included, so a second bind in the same
  -- transaction on a person's own token clears an agent a first bind set.
  if p_attestation is not null and p_attestation ~ '^[0-9a-f]{64}$' then
    select a.agent_client_id into v_agent
      from core.principal_attestation a
     where a.digest = sha256(decode(p_attestation, 'hex'))
       and a.person_id = p_subject
       and a.assignment_id = p_assignment
       and a.organization_id = p_organization
       and a.expires_at > now();
  end if;

  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', v_ceiling, true);
  perform core.seal_setting('kf.principal', p_subject::text, true);
  perform core.seal_setting('kf.principal_organization', p_organization::text, true);
  perform core.seal_setting('kf.principal_assignment', p_assignment::text, true);
  perform core.seal_setting('kf.principal_ceiling', v_ceiling, true);
  perform core.seal_setting('kf.agent_participation', v_agent, true);
  return v_ceiling;
end
$$;

alter table core.action add column agent_participation text
  check (agent_participation is null
         or agent_participation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$');

comment on column core.action.agent_participation is
  'The declared agent client through which the person performed this act (ADR 0035), or null '
  'for a person acting directly. Written by the database from the bound attestation '
  '(action_agent_participation_from_attestation); never the caller''s to set. Not in the audit '
  'chain preimage.';

create function core.action_agent_participation() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
begin
  if core.session_is_administrator() then
    new.agent_participation := coalesce(new.agent_participation,
                                        core.sealed_setting('kf.agent_participation', true));
  else
    new.agent_participation := core.sealed_setting('kf.agent_participation', true);
  end if;
  return new;
end
$$;

revoke all on function core.action_agent_participation() from public;

create trigger action_agent_participation_from_attestation
  before insert on core.action
  for each row execute function core.action_agent_participation();

-- Readiness: the declaration table is configuration read only through a definer seam, as
-- core.principal_attestation is. Replaces the whole list (20260925045000) with one entry added.
create or replace function core.readiness_row_security_exemptions()
returns table (table_name text, reason text)
language sql
immutable
set search_path = pg_catalog
as $$
  values
    -- Reference data mirrored from the ontology. Read by everyone, written only by migrations and
    -- the seed; nothing in it belongs to an organization.
    ('registry.action_type', 'ontology reference data'),
    ('registry.classification', 'ontology reference data'),
    ('registry.identifier_namespace', 'deployment reference data (ADR 0006)'),
    ('registry.object_state', 'ontology reference data'),
    ('registry.object_type', 'ontology reference data'),
    ('registry.relation_type', 'ontology reference data'),
    -- Which types each relation may connect (SAS §100.2, 20260925030300).
    ('registry.relation_type_endpoint', 'ontology reference data'),
    ('registry.retention_class', 'ontology reference data'),
    ('registry.rule_definition', 'ontology reference data'),
    ('registry.schema_release', 'ontology reference data'),
    ('registry.state_machine', 'ontology reference data'),
    ('registry.state_transition', 'ontology reference data'),
    ('org.role', 'role vocabulary; assignments are governed, the vocabulary is not'),
    ('quality.federated_source', 'the list of federated systems; citations of them are governed'),
    -- Guarded by grants: no application login reads the rows, only a definer seam does.
    ('core.audit_chain_head', 'chain bookkeeping; kf_app reads the digest column only'),
    ('core.audit_checkpoint', 'signed checkpoints; read through core.readiness_checkpoint_coverage'),
    ('core.context_seal_key', 'seal key; no application grant'),
    ('core.principal_attestation', 'attestations; written and read only through definer seams'),
    -- Which OAuth clients may act for a person (ADR 0035, 20260925100000). Written only over the
    -- owner credential; read only by core.issue_attestation. It belongs to no organization.
    ('org.declared_agent', 'declared agent clients; owner-written, read only through core.issue_attestation'),
    ('core.migration030_rollback_state', 'migration bookkeeping'),
    ('content.compiler_runtime_lease', 'worker lease; no record content'),
    ('content.document_basis_classifier_lease', 'worker lease; no record content'),
    ('public.schema_migrations', 'dbmate bookkeeping'),
    -- Which writes the act guard exempts, and why (20260925011000). Schema configuration written
    -- only by migrations; it names tables, not records, and belongs to no organization.
    ('core.write_guard_exemption', 'write-guard configuration; written only by migrations')
$$;

-- migrate:down

-- Reversible, so a release can be rolled back past this one. Rolling back drops the recorded
-- participation and the declarations with it: take an export first if that history must survive
-- (docs/deployment/private-host.md).

create or replace function core.readiness_row_security_exemptions()
returns table (table_name text, reason text)
language sql
immutable
set search_path = pg_catalog
as $$
  values
    ('registry.action_type', 'ontology reference data'),
    ('registry.classification', 'ontology reference data'),
    ('registry.identifier_namespace', 'deployment reference data (ADR 0006)'),
    ('registry.object_state', 'ontology reference data'),
    ('registry.object_type', 'ontology reference data'),
    ('registry.relation_type', 'ontology reference data'),
    ('registry.relation_type_endpoint', 'ontology reference data'),
    ('registry.retention_class', 'ontology reference data'),
    ('registry.rule_definition', 'ontology reference data'),
    ('registry.schema_release', 'ontology reference data'),
    ('registry.state_machine', 'ontology reference data'),
    ('registry.state_transition', 'ontology reference data'),
    ('org.role', 'role vocabulary; assignments are governed, the vocabulary is not'),
    ('quality.federated_source', 'the list of federated systems; citations of them are governed'),
    ('core.audit_chain_head', 'chain bookkeeping; kf_app reads the digest column only'),
    ('core.audit_checkpoint', 'signed checkpoints; read through core.readiness_checkpoint_coverage'),
    ('core.context_seal_key', 'seal key; no application grant'),
    ('core.principal_attestation', 'attestations; written and read only through definer seams'),
    ('core.migration030_rollback_state', 'migration bookkeeping'),
    ('content.compiler_runtime_lease', 'worker lease; no record content'),
    ('content.document_basis_classifier_lease', 'worker lease; no record content'),
    ('public.schema_migrations', 'dbmate bookkeeping'),
    ('core.write_guard_exemption', 'write-guard configuration; written only by migrations')
$$;

drop trigger action_agent_participation_from_attestation on core.action;
drop function core.action_agent_participation();
alter table core.action drop column agent_participation;

create or replace function core.bind_principal(
  p_subject      uuid,
  p_assignment   uuid,
  p_organization uuid,
  p_requested    text,
  p_attestation  text default null
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_existing text := core.sealed_setting('kf.principal', true);
  v_ceiling  text;
begin
  if v_existing is not null and v_existing <> p_subject::text then
    raise exception 'transaction already bound to a different principal'
      using errcode = 'insufficient_privilege',
            hint = 'One transaction, one principal. Start a new transaction for another.';
  end if;
  if not core.assignment_is_live(p_subject, p_assignment, p_organization) then
    raise exception 'role assignment % is not held live by % in organization %',
      p_assignment, p_subject, p_organization
      using errcode = 'insufficient_privilege';
  end if;
  select requested_classification into v_ceiling
    from org.resolve_effective_classification(p_subject, p_organization, p_assignment, p_requested);

  if core.session_is_application() then
    if core.session_is_service_actor() then
      if not exists (select 1 from org.person where id = p_subject and person_kind = 'service') then
        raise exception 'a service-actor login binds only service actors, and % is not one', p_subject
          using errcode = 'insufficient_privilege';
      end if;
    elsif p_attestation is null
       or p_attestation !~ '^[0-9a-f]{64}$'
       or not exists (
         select 1
           from core.principal_attestation a
           join registry.classification attested on attested.id = a.ceiling
           join registry.classification bound on bound.id = v_ceiling
          where a.digest = sha256(decode(p_attestation, 'hex'))
            and a.person_id = p_subject
            and a.assignment_id = p_assignment
            and a.organization_id = p_organization
            and a.expires_at > now()
            and bound.rank <= attested.rank) then
      raise exception 'no current attestation that % is present under assignment % in organization %',
        p_subject, p_assignment, p_organization
        using errcode = 'insufficient_privilege',
              hint = 'The application binds a person only on an attestation from kf-attestor.';
    end if;
  end if;

  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', v_ceiling, true);
  perform core.seal_setting('kf.principal', p_subject::text, true);
  perform core.seal_setting('kf.principal_organization', p_organization::text, true);
  perform core.seal_setting('kf.principal_assignment', p_assignment::text, true);
  perform core.seal_setting('kf.principal_ceiling', v_ceiling, true);
  return v_ceiling;
end
$$;

drop function core.issue_attestation(uuid, uuid, uuid, text, timestamptz, text, text);

create function core.issue_attestation(
  p_person       uuid,
  p_assignment   uuid,
  p_organization uuid,
  p_ceiling      text,
  p_token_expiry timestamptz
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_ceiling text;
  v_secret  bytea := public.gen_random_bytes(32);
  v_expiry  timestamptz;
begin
  if p_token_expiry is not null and p_token_expiry <= now() then
    raise exception 'the token has already expired'
      using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from org.person where id = p_person and person_kind = 'service') then
    raise exception 'person % is a service actor; a service actor is never present', p_person
      using errcode = 'insufficient_privilege';
  end if;
  if not core.assignment_is_live(p_person, p_assignment, p_organization) then
    raise exception 'role assignment % is not held live by % in organization %',
      p_assignment, p_person, p_organization
      using errcode = 'insufficient_privilege';
  end if;
  select requested_classification into v_ceiling
    from org.resolve_effective_classification(p_person, p_organization, p_assignment, p_ceiling);

  v_expiry := least(coalesce(p_token_expiry, 'infinity'::timestamptz), now() + interval '60 seconds');

  delete from core.principal_attestation where expires_at < now() - interval '5 minutes';

  insert into core.principal_attestation
    (digest, person_id, assignment_id, organization_id, ceiling, expires_at)
  values (sha256(v_secret), p_person, p_assignment, p_organization, v_ceiling, v_expiry);

  return encode(v_secret, 'hex');
end
$$;

revoke all on function core.issue_attestation(uuid, uuid, uuid, text, timestamptz) from public;
grant execute on function core.issue_attestation(uuid, uuid, uuid, text, timestamptz)
  to kf_attestor;

alter table core.principal_attestation drop column agent_client_id;

drop trigger declared_agent_is_append_only on org.declared_agent;
drop function org.declared_agent_is_append_only();
drop table org.declared_agent;
