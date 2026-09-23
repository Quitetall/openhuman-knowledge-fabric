-- migrate:up

-- The transaction context is the database's to write, not the application's.
--
-- Every guard, policy and trigger in this schema reads who is acting, in which organization,
-- at what ceiling, from `kf.*` settings. Until now those were plain custom settings, and a
-- custom setting is writable by ANY role with `set_config` — which is every role. A red-team
-- pass run as `kf_app` on 2026-09-23 showed what that meant: `set_config('kf.organization', …)`
-- bound any tenant, `core.set_access_context(<any org>, 'restricted')` bound the widest ceiling
-- with no person behind it, and `core.set_transaction_context` accepted a uuid that was nobody.
-- The row-level security was real; the facts it was keyed on were the application's say-so.
--
-- THE SEAL. A setting written through `core.seal_setting` is accompanied by an HMAC over its
-- name, its value, the backend and the transaction's start time, under a key held in a table
-- no role with write grants can read. `core.sealed_setting` recomputes it and answers NULL on any
-- mismatch — so a raw `set_config` is not refused, it is simply not believed, and reads as the
-- unset context it is: no organization, rank −1, no actor. Binding the backend and the
-- transaction start means a seal copied out of one transaction is worthless in the next.
--
-- THE KEY is not backup material. A seal lives for one transaction, so a restored database
-- needs a key, not THE key; `backup.sh` excludes the row's data and the first seal after a
-- restore creates a fresh one. That keeps the key out of every dump, where it would be
-- readable by whoever holds the dump.
--
-- THE SETTERS become SECURITY DEFINER, and check what they are told:
--
--   * an ADMINISTRATOR session (a member of the owner or migrator role — admin commands,
--     migrations, fixtures) binds as before; it could rewrite the tables anyway.
--   * an APPLICATION session (`kf_app`) must bind a PRINCIPAL first, through
--     `core.bind_principal`: a person, their live role assignment in the organization, and a
--     requested ceiling that is clamped to their clearance. `set_access_context` may then
--     only NARROW that ceiling, in that organization, and the transaction's actor must be the
--     principal acting under that assignment.
--   * a SERVICE session (worker, readiness, auditor, checkpoint, backup) keeps its login as its
--     authority, as documented for each; its actor, if it binds one, must still be a person
--     holding the stated assignment live in the bound organization.
--
-- What this does NOT do, stated because it is the next question: the database still cannot
-- tell whether the person the API names is present. It verifies that they hold the authority
-- the API claims for them, which bounds a compromised API to impersonating real people with
-- their real authority rather than inventing both. Threat model T2, open item 6.

create table core.context_seal_key (
  singleton boolean primary key default true check (singleton),
  key       bytea not null check (octet_length(key) = 32)
);

comment on table core.context_seal_key is
  'HMAC key sealing the kf.* transaction context. Readable by no role that can write; excluded from '
  'backups by design — seals are transaction-scoped, so a restore needs a key, not this one.';

revoke all on core.context_seal_key from public;
-- `pg_dump` locks every table it dumps the schema of, and locking needs SELECT, so the backup
-- login holds it — and `backup.sh` then excludes the row. That login already reads every record;
-- the key adds nothing to what it can disclose, and a forged seal is worth something only to a
-- session with write grants, which the backup login does not have.
grant select on core.context_seal_key to kf_backup;

insert into core.context_seal_key (key) values (public.gen_random_bytes(32));

-- The MAC. Not executable by anyone but its owner: a role that could call it could seal.
create function core.context_mac(p_name text, p_value text) returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, core
as $$
declare
  v_key bytea;
begin
  select key into v_key from core.context_seal_key where singleton;
  if v_key is null then
    return null;
  end if;
  return encode(
    public.hmac(
      convert_to(
        concat_ws(chr(31), p_name, p_value, pg_backend_pid()::text,
                  extract(epoch from transaction_timestamp())::text),
        'UTF8'),
      v_key,
      'sha256'),
    'hex');
end
$$;

revoke all on function core.context_mac(text, text) from public;

-- Write a sealed setting. The third argument mirrors `set_config`'s `is_local` so that callers
-- read the same, and must be true: a session-scoped context would outlive the transaction the
-- seal is bound to, and read as unset in the next one anyway.
create function core.seal_setting(p_name text, p_value text, p_is_local boolean) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, core
as $$
begin
  if p_name !~ '^kf\.[a-z_]+$' then
    raise exception 'not a context setting: %', p_name using errcode = 'invalid_parameter_value';
  end if;
  if p_is_local is distinct from true then
    raise exception 'context settings are transaction-local' using errcode = 'invalid_parameter_value';
  end if;
  -- First seal after a restore: the key row is not in any dump (see above).
  if not exists (select 1 from core.context_seal_key) then
    insert into core.context_seal_key (key) values (public.gen_random_bytes(32))
      on conflict do nothing;
  end if;
  perform set_config(p_name, coalesce(p_value, ''), true);
  perform set_config(p_name || '_seal',
                     coalesce(core.context_mac(p_name, coalesce(p_value, '')), ''), true);
  return coalesce(p_value, '');
end
$$;

revoke all on function core.seal_setting(text, text, boolean) from public;

-- Read a sealed setting. An unsealed, forged or stale value reads as NULL — exactly as if it had
-- never been set — so every consumer's existing "unset means nothing" behaviour carries over
-- without a new failure mode. The second argument mirrors `current_setting`'s `missing_ok`.
create function core.sealed_setting(p_name text, p_missing_ok boolean) returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, core
as $$
declare
  v_value text := current_setting(p_name, true);
  v_seal  text := current_setting(p_name || '_seal', true);
begin
  if v_value is null or v_value = '' or v_seal is null or v_seal = '' then
    return null;
  end if;
  if v_seal is distinct from core.context_mac(p_name, v_value) then
    return null;
  end if;
  return v_value;
end
$$;

revoke all on function core.sealed_setting(text, boolean) from public;
grant execute on function core.sealed_setting(text, boolean)
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup, kf_ml_promoter;

-- Which tier a session is in. SECURITY DEFINER so `current_user` is the schema owner: an
-- administrator is a login that is a member of the owner, or of the owner or migrator groups.
create function core.session_is_administrator() returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select pg_has_role(session_user, current_user, 'MEMBER')
      or pg_has_role(session_user, 'kf_owner_role', 'MEMBER')
      or pg_has_role(session_user, 'kf_migrator', 'MEMBER')
$$;

create function core.session_is_application() returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select not core.session_is_administrator() and pg_has_role(session_user, 'kf_app', 'MEMBER')
$$;

-- Answering "which tier am I" discloses nothing a session does not already know about itself,
-- and triggers running as the invoker need to ask it.
revoke all on function core.session_is_administrator() from public;
revoke all on function core.session_is_application() from public;
grant execute on function core.session_is_administrator(), core.session_is_application()
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup, kf_ml_promoter;

-- The accessors, now reading only sealed values.
create or replace function core.current_organization() returns uuid
language sql stable
as $$ select core.sealed_setting('kf.organization', true)::uuid $$;

create or replace function core.current_classification_rank() returns integer
language sql stable
as $$
  select coalesce(
    (select rank from registry.classification
      where id = core.sealed_setting('kf.max_classification', true)),
    -1)
$$;

create or replace function core.current_action_id() returns uuid
language sql stable
as $$ select core.sealed_setting('kf.action_id', true)::uuid $$;

create or replace function core.current_actor() returns uuid
language plpgsql stable
as $$
declare v text := core.sealed_setting('kf.actor', true);
begin
  if v is null then
    raise exception 'no transaction context: this write must go through the action service'
      using errcode = 'insufficient_privilege',
            hint = 'Call core.set_transaction_context() first. Direct writes are not permitted.';
  end if;
  return v::uuid;
end
$$;

-- For predicates that must evaluate to "nobody" rather than raise when no actor is bound.
create function core.current_actor_or_null() returns uuid
language sql stable
as $$ select core.sealed_setting('kf.actor', true)::uuid $$;

create function core.current_acting_role() returns uuid
language sql stable
as $$ select core.sealed_setting('kf.acting_role', true)::uuid $$;

grant execute on function core.current_actor_or_null(), core.current_acting_role()
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup, kf_ml_promoter;

-- Whether a person holds an assignment live in an organization. SECURITY DEFINER, and it binds
-- its own provisional context for the lookup: `core.object` forces row security on its owner
-- too, so the assignment's envelope is invisible without one. The previous context is restored
-- before returning, so the provisional one never reaches the caller.
create function core.assignment_is_live(p_subject uuid, p_assignment uuid, p_organization uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org
as $$
declare
  v_org   text := core.sealed_setting('kf.organization', true);
  v_class text := core.sealed_setting('kf.max_classification', true);
  v_live  boolean;
begin
  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', 'restricted', true);
  select exists (
    select 1
      from org.role_assignment ra
      join core.object o on o.id = ra.id
     where ra.id = p_assignment
       and ra.subject_id = p_subject
       and o.organization_id = p_organization
       and o.lifecycle_state = 'active'
       and ra.valid_from <= now()
       and (ra.valid_to is null or ra.valid_to > now())
  ) into v_live;
  perform core.seal_setting('kf.organization', v_org, true);
  perform core.seal_setting('kf.max_classification', v_class, true);
  return v_live;
end
$$;

revoke all on function core.assignment_is_live(uuid, uuid, uuid) from public;

-- The resolvers bind their own provisional context, for the same reason and in the same way.
-- Callers used to do it for them — at `restricted`, before they knew who the caller was — and
-- that is precisely the unbounded bind this migration removes from the application.
create or replace function org.resolve_effective_classification(
  p_subject uuid,
  p_organization uuid,
  p_assignment uuid,
  p_requested text
) returns table (
  subject_id uuid,
  organization_id uuid,
  assignment_id uuid,
  person_clearance text,
  assignment_ceiling text,
  effective_classification text,
  requested_classification text
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, org, registry, core
as $$
declare
  v_org   text := core.sealed_setting('kf.organization', true);
  v_class text := core.sealed_setting('kf.max_classification', true);
  v_person text;
  v_assignment text;
  v_requested text;
  v_person_rank integer;
  v_requested_rank integer;
begin
  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', 'restricted', true);

  select pc.max_classification, ra.classification_ceiling
    into v_person, v_assignment
    from org.person_clearance pc
    join org.role_assignment ra
      on ra.id = p_assignment
     and ra.subject_id = p_subject
     and ra.valid_from <= now()
     and (ra.valid_to is null or ra.valid_to > now())
    join core.object assignment_object
      on assignment_object.id = ra.id
     and assignment_object.organization_id = p_organization
   where pc.subject_id = p_subject
     and pc.organization_id = p_organization
     and pc.valid_from <= now()
     and (pc.valid_to is null or pc.valid_to > now())
     and not exists (
       select 1 from org.person_clearance_retirement retired
        where retired.clearance_id = pc.id
     )
   order by pc.valid_from desc
   limit 1;

  perform core.seal_setting('kf.organization', v_org, true);
  perform core.seal_setting('kf.max_classification', v_class, true);

  if v_person is null then
    raise exception 'classification clearance is not granted for this person and organization'
      using errcode = 'insufficient_privilege';
  end if;

  v_person_rank := (select c.rank from registry.classification c where c.id = v_person);

  v_requested := coalesce(nullif(btrim(p_requested), ''), v_person);
  select c.rank into v_requested_rank
    from registry.classification c where c.id = v_requested;
  if v_requested_rank is null then
    raise exception 'unknown classification %', v_requested
      using errcode = 'invalid_parameter_value';
  end if;
  if v_requested_rank > v_person_rank then
    raise exception 'requested classification % exceeds clearance %', v_requested, v_person
      using errcode = 'insufficient_privilege';
  end if;

  return query select p_subject, p_organization, p_assignment, v_person, v_assignment,
                      v_person, v_requested;
end;
$$;

create or replace function org.resolve_identity_role(
  p_issuer text,
  p_subject text,
  p_organization uuid,
  p_assignment uuid
) returns table (
  person_id uuid,
  identity_revoked boolean,
  role_held boolean
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, org, registry, core
as $$
declare
  v_person  uuid;
  v_revoked boolean;
begin
  select identity.person_id, identity.revoked_at is not null
    into v_person, v_revoked
    from org.external_identity identity
   where identity.issuer = p_issuer
     and identity.subject = p_subject
   order by (identity.revoked_at is null) desc, identity.linked_at desc
   limit 1;
  if v_person is null then
    return;
  end if;
  return query select v_person, v_revoked,
                      core.assignment_is_live(v_person, p_assignment, p_organization);
end
$$;

-- Bind the reader. The organization and the ceiling are DERIVED from a person's live assignment
-- and clearance; the request may only narrow the ceiling. Returns the ceiling bound.
create function core.bind_principal(
  p_subject uuid,
  p_assignment uuid,
  p_organization uuid,
  p_requested text
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

  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', v_ceiling, true);
  perform core.seal_setting('kf.principal', p_subject::text, true);
  perform core.seal_setting('kf.principal_organization', p_organization::text, true);
  perform core.seal_setting('kf.principal_assignment', p_assignment::text, true);
  perform core.seal_setting('kf.principal_ceiling', v_ceiling, true);
  return v_ceiling;
end
$$;

revoke all on function core.bind_principal(uuid, uuid, uuid, text) from public;
grant execute on function core.bind_principal(uuid, uuid, uuid, text) to kf_app, kf_worker;

create or replace function core.set_access_context(p_organization uuid, p_max_classification text)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, registry
as $$
declare
  v_rank      integer;
  v_principal text := core.sealed_setting('kf.principal', true);
begin
  select rank into v_rank from registry.classification where id = p_max_classification;
  if v_rank is null then
    raise exception 'unknown classification %', p_max_classification
      using errcode = 'invalid_parameter_value';
  end if;

  -- `public` is the one ceiling the application may bind with no principal behind it: it is
  -- the level that is, by definition, anyone's to read, and the public-projection loader reads
  -- nothing else. Once a principal IS bound the exception is gone — otherwise a principal could
  -- step into another tenant at `public` and then act there as themselves.
  if core.session_is_application() and (v_rank > 0 or v_principal is not null) then
    if v_principal is null then
      raise exception 'the application binds a principal, not an organization'
        using errcode = 'insufficient_privilege',
              hint = 'Call core.bind_principal(person, assignment, organization, ceiling) first.';
    end if;
    if p_organization::text is distinct from core.sealed_setting('kf.principal_organization', true) then
      raise exception 'the bound principal acts in organization %, not %',
        core.sealed_setting('kf.principal_organization', true), p_organization
        using errcode = 'insufficient_privilege';
    end if;
    if v_rank > (select rank from registry.classification
                  where id = core.sealed_setting('kf.principal_ceiling', true)) then
      raise exception 'classification % exceeds the principal''s ceiling %',
        p_max_classification, core.sealed_setting('kf.principal_ceiling', true)
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  perform core.seal_setting('kf.organization', p_organization::text, true);
  perform core.seal_setting('kf.max_classification', p_max_classification, true);
end
$$;

create or replace function core.set_transaction_context(
  p_actor uuid,
  p_acting_role uuid,
  p_action_id uuid,
  p_request_id text
) returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_existing  text := core.sealed_setting('kf.actor', true);
  v_org       text := core.sealed_setting('kf.organization', true);
  v_principal text := core.sealed_setting('kf.principal', true);
  v_effective text;
begin
  if v_existing is not null and v_existing <> p_actor::text then
    raise exception 'transaction context already set to a different actor'
      using errcode = 'insufficient_privilege',
            hint = 'One transaction, one actor. Start a new transaction for a different one.';
  end if;

  if not core.session_is_administrator() then
    if v_org is null then
      raise exception 'no organization is bound: an act happens somewhere'
        using errcode = 'insufficient_privilege';
    end if;
    if core.session_is_application() then
      if v_principal is distinct from p_actor::text
         or core.sealed_setting('kf.principal_assignment', true) is distinct from p_acting_role::text
         or core.sealed_setting('kf.principal_organization', true) is distinct from v_org then
        raise exception 'the actor must be the bound principal, acting under the bound assignment'
          using errcode = 'insufficient_privilege';
      end if;
    else
      if not core.assignment_is_live(p_actor, p_acting_role, v_org::uuid) then
        raise exception 'role assignment % is not held live by % in organization %',
          p_acting_role, p_actor, v_org
          using errcode = 'insufficient_privilege';
      end if;
      -- A service writes as a person; it reads no wider than that person may.
      select effective_classification into v_effective
        from org.resolve_effective_classification(p_actor, v_org::uuid, p_acting_role, null);
      if (select rank from registry.classification where id = v_effective)
         < core.current_classification_rank() then
        perform core.seal_setting('kf.max_classification', v_effective, true);
      end if;
    end if;
  end if;

  perform core.seal_setting('kf.actor', p_actor::text, true);
  perform core.seal_setting('kf.acting_role', p_acting_role::text, true);
  perform core.seal_setting('kf.action_id', p_action_id::text, true);
  perform core.seal_setting('kf.request_id', coalesce(p_request_id, ''), true);
end
$$;

-- A shared master-record link binds its OWN organization and ceiling, and nothing else. The
-- route serving `/l/<token>` has no principal — the bearer of a link is nobody the system
-- knows — so it used to bind the link's organization and ceiling through `set_access_context`
-- directly, which is the unbounded bind. Now the database resolves the token digest itself and
-- binds exactly what that link was issued for. A revoked or expired link still binds, so its
-- refusal can be logged against it; the route refuses to serve it.
create function content.bind_master_record_link(p_token_digest text) returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, core, content
as $$
declare
  v_org   uuid;
  v_class text;
begin
  select organization_id, effective_classification into v_org, v_class
    from content.resolve_master_record_link(p_token_digest);
  if v_org is null then
    return false;
  end if;
  perform core.seal_setting('kf.organization', v_org::text, true);
  perform core.seal_setting('kf.max_classification', v_class, true);
  perform core.seal_setting('kf.link_token_digest', p_token_digest, true);
  return true;
end
$$;

revoke all on function content.bind_master_record_link(text) from public;
grant execute on function content.bind_master_record_link(text) to kf_app;

-- Every other reader and writer of a kf.* setting goes through the seal. Rewritten from the
-- live definitions rather than retyped: the bodies are long, and a retyped body is a second
-- copy that can drift from the first. The rewrite is mechanical — two function names — and
-- the assertion after it is the control: afterwards NO function but the seal's own reads or
-- writes a kf.* setting directly.
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema')
       and p.prosrc ~ $re$(current_setting|set_config)\(\s*'kf\.$re$
       and p.oid not in ('core.seal_setting(text,text,boolean)'::regprocedure,
                         'core.sealed_setting(text,boolean)'::regprocedure)
  loop
    v_def := pg_get_functiondef(r.oid);
    v_def := regexp_replace(v_def, $re$current_setting\(\s*'kf\.$re$, 'core.sealed_setting(''kf.', 'g');
    v_def := regexp_replace(v_def, $re$set_config\(\s*'kf\.$re$, 'core.seal_setting(''kf.', 'g');
    execute v_def;
  end loop;
end
$$;

-- The two policies that read the actor directly.
drop policy compilation_basis_finalize on content.compilation_basis;
create policy compilation_basis_finalize on content.compilation_basis
  for update
  using (finalized_at is null and created_by = core.current_actor_or_null())
  with check (
    finalized_at is not null
    and effective_classification is not null
    and effective_classification in (
      select classification.id from registry.classification
       where classification.rank <= core.current_classification_rank()));

drop policy compilation_basis_read on content.compilation_basis;
create policy compilation_basis_read on content.compilation_basis
  for select
  using (
    exists (select 1 from content.composition_revision r
             where r.id = compilation_basis.root_composition_revision_id)
    and (
      (finalized_at is not null
        and effective_classification in (
          select classification.id from registry.classification
           where classification.rank <= core.current_classification_rank()))
      or (finalized_at is null and created_by = core.current_actor_or_null())));

do $$
declare
  v_offenders text;
begin
  select string_agg(p.oid::regprocedure::text, ', ')
    into v_offenders
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema')
     and p.prosrc ~ $re$(current_setting|set_config)\(\s*'kf\.$re$
     and p.oid not in ('core.seal_setting(text,text,boolean)'::regprocedure,
                       'core.sealed_setting(text,boolean)'::regprocedure);
  if v_offenders is not null then
    raise exception 'functions still read or write kf.* settings unsealed: %', v_offenders;
  end if;

  select string_agg(polrelid::regclass::text || '.' || polname, ', ')
    into v_offenders
    from pg_policy
   where coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')
         ~ $re$current_setting\('kf\.$re$;
  if v_offenders is not null then
    raise exception 'policies still read kf.* settings unsealed: %', v_offenders;
  end if;
end
$$;

-- migrate:down
-- kf:forward-only reverting the seal would return the transaction context to whoever can call set_config, which is every role
