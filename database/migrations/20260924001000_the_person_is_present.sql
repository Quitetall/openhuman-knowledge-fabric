-- migrate:up

-- The database binds a principal only when somebody vouched that the person is present.
--
-- 20260923000100 made the application name a PRINCIPAL rather than an organization, and the
-- database checks that the principal holds the role and the clearance. What it could not check
-- is that the person was there: `core.bind_principal` believed any real person the application
-- named, so a fully compromised API process could act as anyone, with their real authority
-- (ADR 0033, threat model T2 residual, open item 6). PostgreSQL cannot verify the bearer token
-- itself — pgcrypto has no RSA — so the verification moves to a SEPARATE process, the attestor,
-- which holds its own database login and is the only application-side party that may vouch.
--
-- THE ATTESTATION. The attestor verifies the token exactly as the API used to (issuer,
-- audience, RS256 pinned, expiry, keys over TLS), resolves the subject to a person, and calls
-- `core.issue_attestation`. That stores the SHA-256 of 32 random bytes against the person, the
-- assignment, the organization and the ceiling, expiring at the earlier of the token's own
-- expiry and one minute from now, and returns the bytes. The API carries them for the rest of
-- the request and hands them to `core.bind_principal` in every transaction it opens.
--
-- REUSE, NOT CONSUMPTION, and the window this leaves, stated plainly. An attestation is valid
-- for every bind of the same (person, assignment, organization) at or below its ceiling until it
-- expires, however many transactions the request needs. Consuming it on first use would buy
-- nothing against the adversary this exists for: an API process that is compromised sees every
-- bearer token passing through it, and can have a fresh attestation issued for any of them until
-- that TOKEN expires (Keycloak access tokens: 300 s). So the replay window is the token's
-- lifetime either way; single use would only have cost a socket round trip per transaction.
-- What the attestation does close is the step that mattered: the API can no longer bind a person
-- who has not presented a valid token to it in the last token lifetime.
--
-- TIERS. Administrator sessions (owner, migrator, fixtures) and service sessions (worker,
-- readiness, auditor, checkpoint, backup) bind exactly as before. Only APPLICATION sessions need
-- an attestation — with one exception, a login that is also a member of `kf_service_actor`: the
-- storage sweep acts as a declared service person (ADR 0020), which has no login and so can never
-- present a token. Such a session may bind only service persons, and binds them on the strength
-- of its own credential, as the worker does. The API's login must not be a member; the API
-- refuses to start as one under the dogfood profile.

do $$
begin
  if not exists (select from pg_roles where rolname = 'kf_attestor') then
    create role kf_attestor nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'kf_service_actor') then
    create role kf_service_actor nologin;
  end if;
end
$$;

-- kf_attestor: vouches that a person is present — may call core.issue_attestation after
--   verifying their bearer token. Held only by the kf-attestor process login, never by the API.
-- kf_service_actor: an application login whose principal is a declared service actor (ADR
--   0020); binds service persons without an attestation. Held by the storage sweep login, never
--   by the API.

-- The attestor resolves the subject through the same definer seams the API used to.
grant usage on schema core, org to kf_attestor;
grant execute on function org.resolve_identity_role(text, text, uuid, uuid) to kf_attestor;
grant execute on function org.resolve_effective_classification(uuid, uuid, uuid, text)
  to kf_attestor;

create table core.principal_attestation (
  digest          bytea primary key check (octet_length(digest) = 32),
  person_id       uuid not null,
  assignment_id   uuid not null,
  organization_id uuid not null,
  ceiling         text not null references registry.classification (id),
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  issued_by       name not null default session_user,
  check (expires_at > issued_at and expires_at <= issued_at + interval '60 seconds')
);

create index principal_attestation_expiry on core.principal_attestation (expires_at);

comment on table core.principal_attestation is
  'Short-lived proof that a person presented a verified bearer token. Stores the SHA-256 of the '
  'attestation only. Read and written by definer functions; no role reads it directly.';

revoke all on core.principal_attestation from public;

-- Vouch that a person is present. Executable ONLY by kf_attestor (and administrators, who could
-- rewrite the table anyway). Re-checks the assignment and clamps the ceiling itself rather than
-- trusting the caller's resolution: the attestor is trusted to have verified a token, not to
-- have decided authority.
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

  -- Housekeeping, bounded by the index: nothing reads an expired row.
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

-- Whether this session's login acts as a declared service actor. Asked as the definer so the
-- answer is about the LOGIN, as session_is_application's is.
create function core.session_is_service_actor() returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select core.session_is_application() and pg_has_role(session_user, 'kf_service_actor', 'MEMBER')
$$;

revoke all on function core.session_is_service_actor() from public;

-- The bind, now with the attestation. The old four-argument form is dropped rather than
-- overloaded: a call that names no attestation reaches this one with NULL, and an application
-- session is refused.
drop function core.bind_principal(uuid, uuid, uuid, text);

create function core.bind_principal(
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

revoke all on function core.bind_principal(uuid, uuid, uuid, text, text) from public;
grant execute on function core.bind_principal(uuid, uuid, uuid, text, text) to kf_app, kf_worker;

-- migrate:down

-- Reversible on purpose, so a release can be rolled back past this one: the previous API calls
-- the four-argument bind and would be refused by every application-tier bind otherwise. Rolling
-- back re-opens exactly the gap described above, and nothing wider. Roles are cluster-global and
-- retained, as every migration here retains them.

drop function core.bind_principal(uuid, uuid, uuid, text, text);

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

drop function core.session_is_service_actor();
drop function core.issue_attestation(uuid, uuid, uuid, text, timestamptz);
drop table core.principal_attestation;
revoke execute on function org.resolve_effective_classification(uuid, uuid, uuid, text)
  from kf_attestor;
revoke execute on function org.resolve_identity_role(text, text, uuid, uuid) from kf_attestor;
revoke usage on schema core, org from kf_attestor;
