-- migrate:up

-- Every controlled write names the sealed context that made it, or it is refused.
--
-- 20260923000100 made the context the database's to write. This makes the rows that record
-- authority agree with it. The same red-team pass, run as `kf_app`, succeeded at each of these:
--
--   * a `core.action` row credited to another person, inserted straight into the ledger;
--   * a `core.audit_event` with a digest nobody computed, which became the chain head — the
--     insert trigger checked the link to the predecessor and never the digest itself;
--   * `org.role_assignment.role_id` rewritten to `technical_authority` with no act at all;
--   * `org.external_identity` linking an attacker's provider subject to someone else's person,
--     with no context bound — the table had no row security;
--   * `core.object_verification` naming any verifier and any act.
--
-- ADMINISTRATOR sessions (`core.session_is_administrator`) are exempt where they are the path
-- that exists: bootstrap and grant-authority write through the owner credential by design, and
-- an owner could rewrite these tables anyway. Everything else is held to the context.

-- 1. THE LEDGER. An action row is the one the sealed context names.
drop policy action_scoped_insert on core.action;
create policy action_scoped_insert on core.action
  for insert
  with check (
    organization_id = core.current_organization()
    and id = core.current_action_id()
    and actor_id = core.current_actor_or_null()
    and acting_role_id = core.current_acting_role()
  );

-- 2. THE CHAIN. The database recomputes each event's digest from its own fields and its action's
-- targets, exactly as `auditChainDigest` does — RFC 8785 canonical JSON of eight fields, keys in
-- code-point order, object ids sorted, `effective_at` as the millisecond ISO wire form — and
-- refuses any event whose digest differs. The event must also describe its own action truthfully,
-- and outside an administrator session it must be the action the context names: an event for
-- someone else's past act is not a new fact.
create or replace function core.audit_event_digest(
  p_prev_digest text,
  p_action_id uuid,
  p_action_type text,
  p_actor_id uuid,
  p_acting_role_id uuid,
  p_object_ids uuid[],
  p_effective_at timestamptz,
  p_before_digest text,
  p_after_digest text
) returns text
language sql
stable
set search_path = pg_catalog
as $$
  select encode(sha256(decode(p_prev_digest, 'hex') || convert_to(
    '{"acting_role_id":' || to_json(p_acting_role_id::text)::text
    || ',"action_id":' || to_json(p_action_id::text)::text
    || ',"action_type":' || to_json(p_action_type)::text
    || ',"actor_id":' || to_json(p_actor_id::text)::text
    || ',"after_digest":' || coalesce(to_json(p_after_digest)::text, 'null')
    || ',"before_digest":' || coalesce(to_json(p_before_digest)::text, 'null')
    || ',"effective_at":' || to_json(to_char(p_effective_at at time zone 'UTC',
                                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    || ',"object_ids":[' || coalesce((
         select string_agg(to_json(id::text)::text, ',' order by id::text collate "C")
           from unnest(p_object_ids) as id), '')
    || ']}',
    'UTF8')), 'hex')
$$;

comment on function core.audit_event_digest(text, uuid, text, uuid, uuid, uuid[], timestamptz, text, text) is
  'The v1 audit-chain digest, computed by the database. Must equal @kf/canonicalization '
  'auditChainDigest byte for byte; tests/database/principal-binding.test.ts pins the two together.';

create or replace function core.enforce_audit_chain_head() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_seq bigint;
  v_digest text;
  v_action core.action;
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

  select * into v_action from core.action where id = new.action_id;
  if v_action.id is null then
    raise exception 'audit event names action %, which is not in the ledger', new.action_id
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_action.actor_id is distinct from new.actor_id
     or v_action.acting_role_id is distinct from new.acting_role_id
     or v_action.action_type is distinct from new.action_type then
    raise exception 'audit event does not describe its own action truthfully'
      using errcode = 'integrity_constraint_violation';
  end if;
  if not core.session_is_administrator()
     and new.action_id is distinct from core.current_action_id() then
    raise exception 'audit event must record the action this transaction is performing'
      using errcode = 'insufficient_privilege';
  end if;
  if new.digest is distinct from core.audit_event_digest(
       new.prev_digest, new.action_id, new.action_type, new.actor_id, new.acting_role_id,
       v_action.target_ids, new.effective_at, new.before_digest, new.after_digest) then
    raise exception 'audit event digest does not match its content'
      using errcode = 'integrity_constraint_violation',
            hint = 'The database recomputes every link; a digest it cannot reproduce is refused.';
  end if;

  update core.audit_chain_head set seq = new.seq, digest = new.digest where singleton;
  return new;
end
$$;

-- 3. ROLE ASSIGNMENTS AND CLEARANCES can only be end-dated. The application's one update to
-- each is closing an interval (organization-lifecycle.ts); nothing else about who holds what
-- may change after the fact, and an interval, once closed, stays closed.
revoke update on org.role_assignment from kf_app;
grant update (valid_to) on org.role_assignment to kf_app;

create function org.refuse_reopening_an_interval() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if core.session_is_administrator() then
    return new;
  end if;
  perform core.current_actor();
  if new.valid_to is null then
    raise exception '% % cannot be reopened; grant a new one', tg_table_name, old.id
      using errcode = 'insufficient_privilege';
  end if;
  if old.valid_to is not null and new.valid_to > old.valid_to then
    raise exception '% % cannot be extended; grant a new one', tg_table_name, old.id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

grant execute on function org.refuse_reopening_an_interval() to kf_app;

create trigger role_assignment_end_date_only
  before update on org.role_assignment
  for each row execute function org.refuse_reopening_an_interval();

create trigger person_clearance_end_date_only
  before update on org.person_clearance
  for each row execute function org.refuse_reopening_an_interval();

-- Who exists, who holds which role, and which login is whom are written by the owner
-- credential's admin commands (`kf:grant-authority`, `kf:declare-service-actor`, bootstrap) and
-- by nothing that runs as the application. The application's INSERT on them was unused, and it
-- was the whole of what a compromised API needed to mint itself an authority. A clearance is
-- still granted by a dispatched act, so that INSERT stays — but never to oneself.
revoke insert on org.role_assignment, org.person from kf_app;

drop policy person_clearance_write on org.person_clearance;
create policy person_clearance_write on org.person_clearance
  for insert
  with check (
    organization_id = core.current_organization()
    and granted_by = core.current_actor()
    and granted_by_action = core.current_action_id()
    and subject_id is distinct from core.current_actor()
    and exists (select 1 from core.object envelope where envelope.id = person_clearance.subject_id)
  );

-- 4. ACCESS GRANTS: revocation is the only update, so only its columns are writable, and its
-- time is the database's — a revocation recorded as having happened last month is a backdated
-- decision, and the policy already requires it to name the actor and act that made it.
revoke update on org.access_grant from kf_app;
grant update (revoked_at, revoked_by, revoked_by_action, revocation_reason) on org.access_grant to kf_app;

create function org.access_grant_revoked_now() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if not core.session_is_administrator() then
    new.revoked_at := now();
  end if;
  return new;
end
$$;

grant execute on function org.access_grant_revoked_now() to kf_app;

create trigger access_grant_revoked_now
  before update on org.access_grant
  for each row execute function org.access_grant_revoked_now();

-- 5. EXTERNAL IDENTITIES. Linking a provider subject to a person decides who can sign in as
-- whom; it is the most valuable single row in the system and had no row security at all. Only
-- `kf:grant-authority`, through the owner credential, links or revokes one, so the application
-- loses both grants; the policies below are the second line, for any role granted them later. Row
-- security is ENABLED, not forced: the identity resolver is SECURITY DEFINER and must find a
-- subject before any organization is known, which is the one read that precedes a context.
alter table org.external_identity enable row level security;

create policy external_identity_scoped_read on org.external_identity
  for select to kf_app, kf_worker
  using (exists (select 1 from org.person p
                  where p.id = external_identity.person_id
                    and p.organization = core.current_organization()));

-- Backup only. The auditor was deliberately denied the identity mapping in 20260816000600 —
-- who signs in as whom is not audit material — and enabling row security must not undo that.
create policy external_identity_backup_read on org.external_identity
  for select to kf_backup using (true);

create policy external_identity_link on org.external_identity
  for insert to kf_app
  with check (
    core.current_actor_or_null() is not null
    and exists (select 1 from org.person p
                 where p.id = external_identity.person_id
                   and p.organization = core.current_organization()));

create policy external_identity_revoke on org.external_identity
  for update to kf_app
  using (revoked_at is null
         and exists (select 1 from org.person p
                      where p.id = external_identity.person_id
                        and p.organization = core.current_organization()))
  with check (revoked_at is not null and core.current_actor_or_null() is not null);

revoke insert, update on org.external_identity from kf_app;

-- 6. VERIFICATION names the sealed actor and act. The worker had INSERT here and no business
-- with it: a verification is a person's judgement, recorded by the act they performed.
drop policy object_verification_write on core.object_verification;
create policy object_verification_write on core.object_verification
  for insert
  with check (
    exists (select 1 from core.object o where o.id = object_id)
    and verified_by = core.current_actor_or_null()
    and recorded_by_action = core.current_action_id()
    -- RQ-230: whoever admitted a record is the one person whose check means least.
    and verified_by is distinct from (select o.created_by from core.object o where o.id = object_id)
  );
revoke insert on core.object_verification from kf_worker;

-- 7. DEFINER FUNCTIONS THAT TAKE AN ORGANIZATION answer only for the bound one. Each ran as the
-- owner with the organization as a plain argument, so any caller could ask about any tenant.
create or replace function retrieval.slot_bands(p_organization uuid, p_object_ids uuid[])
returns table (slot integer, classification text)
language sql
stable
security definer
set search_path = core, retrieval, pg_catalog
as $$
  select s.ord::integer, o.classification
    from unnest(p_object_ids) with ordinality as s(id, ord)
    left join core.object o
      on o.id = s.id
     and o.organization_id = p_organization
     and (core.session_is_administrator() or p_organization = core.current_organization())
   order by s.ord
$$;

create or replace function org.secure_object_capability_grants(p_organization uuid)
returns table (
  source_id uuid, organization_id uuid, principal_id uuid, scope_external_ref text,
  classification text, valid_from timestamptz, valid_to timestamptz, granted_by_action uuid)
language sql
stable
security definer
set search_path = pg_catalog, secure_object, org
as $$
  select issue.id,
         request.organization_id,
         issue.actor_id,
         request.external_authority_ref || '@' || request.external_revision_ref,
         request.classification_id,
         issue.issued_at,
         revocation.revoked_at,
         issue.action_id
    from secure_object.capability_issue issue
    join secure_object.capability_request request on request.id = issue.request_id
    left join secure_object.capability_revocation revocation
      on revocation.capability_id = issue.id
   where request.organization_id = p_organization
     and (core.session_is_administrator()
          or pg_has_role(session_user, 'kf_backup', 'MEMBER')
          or pg_has_role(session_user, 'kf_auditor', 'MEMBER')
          or p_organization = core.current_organization())
$$;

create or replace function org.person_lookup(p_person uuid)
returns table (present boolean, organization uuid, display_name text)
language sql
stable
security definer
set search_path = pg_catalog, org
as $$
  with visible as (
    select p.* from org.person p
     where p.id = p_person
       and (core.session_is_administrator() or p.organization = core.current_organization())
  )
  select exists (select 1 from visible),
         (select v.organization from visible v),
         (select v.display_name from visible v)
$$;

create or replace function org.organization_by_name(p_legal_name text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, org
as $$
  select o.id from org.organization o
   where lower(btrim(o.legal_name)) = lower(btrim(p_legal_name)) and o.retired_at is null
     and (core.session_is_administrator() or o.id = core.current_organization())
   limit 1
$$;

-- 8. AN UNVERIFIED RECORD CANNOT BE CITED BY WRAPPING ITS ID. The guard cast the whole reference
-- to uuid and treated anything that did not cast as "not ours": `kf:<uuid>`, a URL ending in one,
-- or "see <uuid>" all passed. Every uuid in the reference is now checked.
create or replace function work.evidence_ref_is_unverified_record(p_ref text) returns boolean
language plpgsql
stable
security definer
set search_path = core, work, pg_catalog
as $$
begin
  return exists (
    select 1
      from regexp_matches(coalesce(p_ref, ''),
             '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', 'g') as m
      join core.object o on o.id = lower(m[1])::uuid
     where not exists (select 1 from core.object_verification v where v.object_id = o.id));
end
$$;

-- 9. READINESS COUNTS WITHOUT BINDING EVERY TENANT. The search-index check bound each
-- organization in turn at `restricted` to count its records — the exact bind the application
-- role no longer has. It needed counts, not records, so the database now counts, as it already
-- enumerates the organizations: numbers per tenant, and nothing a count could leak beyond the
-- number of records, which readiness reports anyway.
create function core.readiness_search_index_counts()
returns table (organization_id uuid, objects bigint, indexed bigint)
language sql
stable
security definer
set search_path = pg_catalog, core, search
as $$
  select org.id,
         (select count(*) from core.object o where o.organization_id = org.id),
         (select count(*) from search.document d where d.organization_id = org.id)
    from core.readiness_organization_ids() as org(id)
$$;

revoke execute on function core.readiness_search_index_counts() from public;
grant execute on function core.readiness_search_index_counts() to kf_app, kf_worker;

-- migrate:down
-- kf:forward-only reverting would re-admit forged ledger rows, forged audit digests, role escalation by update, and identity takeover by insert
