-- migrate:up

-- KF stores only policy/provenance records for externally held objects. Protected bytes,
-- locators, subject/session identity, reidentification maps and private keys remain inside
-- Secure Object Authority (SOA).

create extension if not exists pgcrypto;

alter table ops.recovery_objective
  add column rto_seconds integer check (rto_seconds is null or rto_seconds > 0);

comment on column ops.recovery_objective.rto_seconds is
  'Declared recovery time objective. Null is permitted only for pre-migration rows; '
  'readiness fails closed until a new objective includes a target.';

alter table ops.restore_drill
  add column recovery_seconds integer check (recovery_seconds is null or recovery_seconds > 0);

comment on column ops.restore_drill.recovery_seconds is
  'Measured elapsed recovery time. Null marks legacy or unmeasured evidence and cannot '
  'satisfy an RTO readiness check.';

create table ops.physical_failure_domain_evidence (
  domain_ref text primary key
    check (length(domain_ref) between 1 and 255 and domain_ref = btrim(domain_ref)),
  evidence_ref text not null unique
    check (length(evidence_ref) between 1 and 512 and evidence_ref = btrim(evidence_ref)),
  approved_by uuid not null references org.person (id),
  approved_at timestamptz not null,
  valid_until timestamptz,
  constraint physical_domain_evidence_window
    check (valid_until is null or valid_until > approved_at)
);

create trigger physical_failure_domain_evidence_append_only
  after update or delete or truncate on ops.physical_failure_domain_evidence
  for each statement execute function core.refuse_mutation();

create table ops.encrypted_backup_evidence (
  backup_copy_id uuid primary key references ops.backup_copy (id),
  failure_domain_ref text not null references ops.physical_failure_domain_evidence (domain_ref),
  evidence_ref text not null unique
    check (length(evidence_ref) between 1 and 512 and evidence_ref = btrim(evidence_ref)),
  encrypted boolean not null,
  separate_from_primary boolean not null,
  approved_by uuid not null references org.person (id),
  approved_at timestamptz not null,
  valid_until timestamptz,
  constraint encrypted_backup_evidence_window
    check (valid_until is null or valid_until > approved_at)
);

create trigger encrypted_backup_evidence_append_only
  after update or delete or truncate on ops.encrypted_backup_evidence
  for each statement execute function core.refuse_mutation();

grant select on ops.physical_failure_domain_evidence, ops.encrypted_backup_evidence
  to kf_app, kf_worker, kf_readonly, kf_auditor;

create schema if not exists secure_object;
grant usage on schema secure_object to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;

create type secure_object.safe_purpose as enum (
  'ml_training',
  'ml_evaluation',
  'data_quality_validation',
  'authorized_erasure'
);

create type secure_object.key_revocation_reason as enum (
  'key_rotation',
  'key_compromise',
  'authority_retirement',
  'administrative'
);

-- Validate active action as authority, not merely as an actor-shaped UUID. Every secure
-- insert must name one exact ontology action, target only owning organization, carry exact
-- semantic parameters, and exercise a live role assignment scoped to that organization.
create function secure_object.require_exact_action(
  p_action_type text,
  p_organization_id uuid,
  p_parameters jsonb
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, org, secure_object
as $$
declare
  v_actor uuid := core.current_actor();
  v_action_id uuid := core.current_action_id();
  v_role_id uuid := nullif(current_setting('kf.acting_role', true), '')::uuid;
  v_action core.action%rowtype;
begin
  if v_action_id is null or v_role_id is null then
    raise exception 'secure-object write requires exact secure-object action context'
      using errcode = 'insufficient_privilege';
  end if;

  select a.* into v_action from core.action a where a.id = v_action_id;
  if not found or v_action.actor_id <> v_actor or v_action.acting_role_id <> v_role_id then
    raise exception 'secure-object action context does not match recorded actor and role'
      using errcode = 'insufficient_privilege';
  end if;
  if v_action.action_type <> p_action_type then
    raise exception 'secure-object write requires action %, got %',
      p_action_type, v_action.action_type
      using errcode = 'insufficient_privilege';
  end if;
  if v_action.target_ids <> array[p_organization_id]::uuid[] then
    raise exception 'secure-object action target must be exactly owning organization %',
      p_organization_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_action.parameters <> p_parameters then
    raise exception 'secure-object action parameters do not exactly match ledger semantics'
      using errcode = 'insufficient_privilege';
  end if;
  if v_action.result_status <> 'applied' then
    raise exception 'secure-object action is not applied'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- Effects run after core.action is inserted but before audit/outbox in the dispatcher.
  -- Requiring the action row to have been born in this transaction prevents a caller from
  -- replaying a previously committed action id as fresh mutation authority.
  if not exists (
    select 1 from core.action a
     where a.id = v_action_id
       and a.xmin::text = pg_current_xact_id()::text
  ) then
    raise exception 'secure-object action must be applied in its creating transaction'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from core.audit_event e where e.action_id = v_action_id) then
    raise exception 'secure-object action effect must precede its audit event'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if core.current_organization() <> p_organization_id or not exists (
    select 1
      from core.object o
      join org.organization organization on organization.id = o.id
     where o.id = p_organization_id
       and o.object_type = 'organization'
       and o.organization_id = p_organization_id
       and (select rank from registry.classification where id = o.classification)
           <= core.current_classification_rank()
  ) then
    raise exception 'secure-object target organization does not exist or is not visible'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from org.role_assignment ra
     where ra.id = v_role_id
       and ra.subject_id = v_actor
       and ra.scope_id = p_organization_id
       and ra.valid_from <= v_action.effective_at
       and (ra.valid_to is null or ra.valid_to > v_action.effective_at)
  ) then
    raise exception 'secure-object action role is not active for owning organization'
      using errcode = 'insufficient_privilege';
  end if;
  return v_action_id;
end
$$;

revoke execute on function secure_object.require_exact_action(text, uuid, jsonb) from public;
-- The application may preflight an externally visible signer call. This function performs
-- no mutation; triggers repeat the same check when the receipt is inserted.
grant execute on function secure_object.require_exact_action(text, uuid, jsonb) to kf_app;

create function secure_object.action_effective_at(p_action_id uuid) returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog, core
as $$ select effective_at from core.action where id = p_action_id $$;

revoke execute on function secure_object.action_effective_at(uuid) from public;

create function secure_object.iso8601(p_value timestamptz) returns text
language sql
immutable
strict
as $$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

revoke execute on function secure_object.iso8601(timestamptz) from public;

-- Public-key registry. Public SPKI material is safe to preserve; private signing material is
-- neither accepted nor stored. Digest and SPKI prefix checks prevent a key row whose identity
-- does not match its bytes or whose algorithm is not Ed25519.
create table secure_object.authority_signing_key (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references org.organization (id),
  external_authority_ref text not null
    check (length(external_authority_ref) between 1 and 512
           and external_authority_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]*$'),
  key_id text not null
    check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'),
  algorithm text not null check (algorithm = 'Ed25519'),
  public_key_spki_der_base64 text not null
    check (public_key_spki_der_base64 ~ '^[A-Za-z0-9+/]{59}=$'),
  public_key_sha256 text not null check (public_key_sha256 ~ '^[0-9a-f]{64}$'),
  rotates_key_registry_id uuid,
  valid_from timestamptz not null,
  valid_until timestamptz,
  actor_id uuid not null references org.person (id),
  action_id uuid not null references core.action (id),
  registered_at timestamptz not null,
  constraint authority_signing_key_window
    check (valid_until is null or valid_until > valid_from),
  constraint authority_signing_key_material_digest check (
    public_key_sha256 = encode(digest(decode(public_key_spki_der_base64, 'base64'), 'sha256'), 'hex')
  ),
  constraint authority_signing_key_ed25519_spki check (
    octet_length(decode(public_key_spki_der_base64, 'base64')) = 44
    and encode(substring(decode(public_key_spki_der_base64, 'base64') from 1 for 12), 'hex')
      = '302a300506032b6570032100'
  ),
  unique (organization_id, external_authority_ref, key_id),
  unique (id, key_id),
  unique (id, organization_id, external_authority_ref),
  constraint authority_signing_key_rotation_same_authority
    foreign key (rotates_key_registry_id, organization_id, external_authority_ref)
    references secure_object.authority_signing_key
      (id, organization_id, external_authority_ref)
);

create table secure_object.authority_signing_key_revocation (
  signing_key_registry_id uuid primary key
    references secure_object.authority_signing_key (id),
  reason_code secure_object.key_revocation_reason not null,
  actor_id uuid not null references org.person (id),
  action_id uuid not null references core.action (id),
  revoked_at timestamptz not null
);

create table secure_object.capability_request (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references org.organization (id),
  classification_id text not null references registry.classification (id),
  external_authority_ref text not null
    check (length(external_authority_ref) between 1 and 512
           and external_authority_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]*$'),
  external_revision_ref text not null
    check (length(external_revision_ref) between 1 and 512
           and external_revision_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]*$'),
  external_content_sha256 text not null check (external_content_sha256 ~ '^[0-9a-f]{64}$'),
  purpose secure_object.safe_purpose not null,
  workload_identity_ref text not null
    check (workload_identity_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'),
  policy_decision_ref text not null
    check (policy_decision_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'),
  idempotency_key text not null
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{7,127}$'),
  ttl_seconds integer not null check (ttl_seconds between 1 and 300),
  actor_id uuid not null references org.person (id),
  action_id uuid not null references core.action (id),
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  constraint capability_request_short_lived check (
    expires_at > requested_at
    and expires_at = requested_at + make_interval(secs => ttl_seconds)
  ),
  unique (organization_id, idempotency_key),
  unique (
    id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref
  )
);

create table secure_object.capability_issue (
  id uuid primary key default uuidv7(),
  request_id uuid not null unique,
  external_content_sha256 text not null check (external_content_sha256 ~ '^[0-9a-f]{64}$'),
  purpose secure_object.safe_purpose not null,
  workload_identity_ref text not null,
  policy_decision_ref text not null,
  access_mode text not null default 'read_exact_revision'
    check (access_mode = 'read_exact_revision'),
  actor_id uuid not null references org.person (id),
  action_id uuid not null references core.action (id),
  issued_at timestamptz not null,
  constraint capability_issue_exact_request
    foreign key (
      request_id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref
    ) references secure_object.capability_request
      (id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref),
  unique (
    id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref
  )
);

create table secure_object.capability_revocation (
  capability_id uuid primary key,
  external_content_sha256 text not null check (external_content_sha256 ~ '^[0-9a-f]{64}$'),
  purpose secure_object.safe_purpose not null,
  workload_identity_ref text not null,
  policy_decision_ref text not null,
  actor_id uuid not null references org.person (id),
  action_id uuid not null references core.action (id),
  revoked_at timestamptz not null,
  constraint capability_revocation_exact_issue
    foreign key (
      capability_id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref
    ) references secure_object.capability_issue
      (id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref)
);

create table secure_object.capability_consumption (
  capability_id uuid primary key,
  external_content_sha256 text not null check (external_content_sha256 ~ '^[0-9a-f]{64}$'),
  purpose secure_object.safe_purpose not null,
  workload_identity_ref text not null,
  policy_decision_ref text not null,
  actor_id uuid not null references org.person (id),
  action_id uuid not null references core.action (id),
  consumed_at timestamptz not null,
  constraint capability_consumption_exact_issue
    foreign key (
      capability_id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref
    ) references secure_object.capability_issue
      (id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref)
);

create table secure_object.erasure_request (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references org.organization (id),
  classification_id text not null references registry.classification (id),
  external_authority_ref text not null
    check (length(external_authority_ref) between 1 and 512
           and external_authority_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]*$'),
  external_revision_ref text not null
    check (length(external_revision_ref) between 1 and 512
           and external_revision_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]*$'),
  external_content_sha256 text not null check (external_content_sha256 ~ '^[0-9a-f]{64}$'),
  purpose secure_object.safe_purpose not null check (purpose = 'authorized_erasure'),
  workload_identity_ref text not null
    check (workload_identity_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'),
  policy_decision_ref text not null
    check (policy_decision_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$'),
  actor_id uuid not null references org.person (id),
  action_id uuid not null references core.action (id),
  requested_at timestamptz not null,
  unique (organization_id, external_authority_ref, external_revision_ref),
  unique (
    id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref
  )
);

create table secure_object.erasure_tombstone (
  id uuid primary key default uuidv7(),
  erasure_request_id uuid not null unique,
  external_content_sha256 text not null check (external_content_sha256 ~ '^[0-9a-f]{64}$'),
  purpose secure_object.safe_purpose not null check (purpose = 'authorized_erasure'),
  workload_identity_ref text not null,
  policy_decision_ref text not null,
  tombstone_version text not null
    check (tombstone_version = 'kf-secure-object-erasure-tombstone/v1'),
  erased_at timestamptz not null,
  actor_id uuid not null references org.person (id),
  action_id uuid not null references core.action (id),
  signing_key_registry_id uuid not null,
  signing_key_id text not null,
  signature text not null check (signature ~ '^[A-Za-z0-9+/]{86}==$'),
  recorded_at timestamptz not null default now(),
  constraint erasure_tombstone_exact_request
    foreign key (
      erasure_request_id, external_content_sha256, purpose,
      workload_identity_ref, policy_decision_ref
    ) references secure_object.erasure_request
      (id, external_content_sha256, purpose, workload_identity_ref, policy_decision_ref),
  constraint erasure_tombstone_registered_key
    foreign key (signing_key_registry_id, signing_key_id)
    references secure_object.authority_signing_key (id, key_id)
);

-- ── Exact typed-action triggers ─────────────────────────────────────────────────────────

create function secure_object.enforce_key_registration_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare
  v_action uuid;
begin
  select secure_object.require_exact_action(
    'register_secure_object_authority_key',
    new.organization_id,
    jsonb_build_object(
      'organizationId', new.organization_id,
      'authorityRef', new.external_authority_ref,
      'keyId', new.key_id,
      'publicKeySpkiDerBase64', new.public_key_spki_der_base64,
      'publicKeySha256', new.public_key_sha256,
      'rotatesKeyRegistryId', new.rotates_key_registry_id,
      'validUntil', case when new.valid_until is null then null
                         else secure_object.iso8601(new.valid_until) end
    )
  ) into v_action;
  new.actor_id := core.current_actor();
  new.action_id := v_action;
  new.valid_from := secure_object.action_effective_at(v_action);
  new.registered_at := clock_timestamp();
  return new;
end
$$;

create function secure_object.enforce_key_revocation_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare
  v_key secure_object.authority_signing_key%rowtype;
  v_action uuid;
begin
  select k.* into v_key from secure_object.authority_signing_key k
   where k.id = new.signing_key_registry_id;
  select secure_object.require_exact_action(
    'revoke_secure_object_authority_key',
    v_key.organization_id,
    jsonb_build_object(
      'signingKeyRegistryId', new.signing_key_registry_id,
      'reasonCode', new.reason_code
    )
  ) into v_action;
  new.actor_id := core.current_actor();
  new.action_id := v_action;
  new.revoked_at := secure_object.action_effective_at(v_action);
  return new;
end
$$;

create function secure_object.enforce_capability_request_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare v_action uuid;
begin
  select secure_object.require_exact_action(
    'request_secure_object_access',
    new.organization_id,
    jsonb_build_object(
      'organizationId', new.organization_id,
      'classificationId', new.classification_id,
      'authorityRef', new.external_authority_ref,
      'revisionRef', new.external_revision_ref,
      'externalContentSha256', new.external_content_sha256,
      'purpose', new.purpose,
      'workloadIdentityRef', new.workload_identity_ref,
      'policyDecisionRef', new.policy_decision_ref,
      'idempotencyKey', new.idempotency_key,
      'ttlSeconds', new.ttl_seconds
    )
  ) into v_action;
  new.actor_id := core.current_actor();
  new.action_id := v_action;
  new.requested_at := secure_object.action_effective_at(v_action);
  new.expires_at := new.requested_at + make_interval(secs => new.ttl_seconds);
  return new;
end
$$;

create function secure_object.enforce_capability_issue_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare
  v_organization_id uuid;
  v_request_id uuid;
  v_authority_ref text;
  v_revision_ref text;
  v_content_sha256 text;
  v_purpose secure_object.safe_purpose;
  v_workload_identity_ref text;
  v_policy_decision_ref text;
  v_expires_at timestamptz;
  v_action uuid;
begin
  select r.organization_id, r.id, r.external_authority_ref, r.external_revision_ref,
         r.external_content_sha256, r.purpose, r.workload_identity_ref,
         r.policy_decision_ref, r.expires_at
    into v_organization_id, v_request_id, v_authority_ref, v_revision_ref,
         v_content_sha256, v_purpose, v_workload_identity_ref,
         v_policy_decision_ref, v_expires_at
    from secure_object.capability_request r where r.id = new.request_id;
  select secure_object.require_exact_action(
    'issue_secure_object_capability',
    v_organization_id,
    jsonb_build_object(
      'requestId', v_request_id,
      'authorityRef', v_authority_ref,
      'revisionRef', v_revision_ref,
      'externalContentSha256', v_content_sha256,
      'purpose', v_purpose,
      'workloadIdentityRef', v_workload_identity_ref,
      'policyDecisionRef', v_policy_decision_ref
    )
  ) into v_action;
  new.actor_id := core.current_actor();
  new.action_id := v_action;
  new.issued_at := secure_object.action_effective_at(v_action);
  if new.issued_at >= v_expires_at then
    raise exception 'secure-object capability request is expired'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return new;
end
$$;

create function secure_object.enforce_capability_revocation_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare
  v_issue secure_object.capability_issue%rowtype;
  v_request secure_object.capability_request%rowtype;
  v_action uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.capability_id::text, 0));
  select i.* into v_issue from secure_object.capability_issue i where i.id = new.capability_id;
  select r.* into v_request from secure_object.capability_request r where r.id = v_issue.request_id;
  select secure_object.require_exact_action(
    'revoke_secure_object_capability',
    v_request.organization_id,
    jsonb_build_object(
      'capabilityId', v_issue.id,
      'authorityRef', v_request.external_authority_ref,
      'revisionRef', v_request.external_revision_ref,
      'externalContentSha256', v_issue.external_content_sha256,
      'purpose', v_issue.purpose,
      'workloadIdentityRef', v_issue.workload_identity_ref,
      'policyDecisionRef', v_issue.policy_decision_ref
    )
  ) into v_action;
  if exists (
    select 1 from secure_object.capability_consumption c where c.capability_id = new.capability_id
  ) then
    raise exception 'secure-object capability is already consumed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  new.actor_id := core.current_actor();
  new.action_id := v_action;
  new.revoked_at := secure_object.action_effective_at(v_action);
  return new;
end
$$;

create function secure_object.enforce_capability_consumption_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare
  v_issue secure_object.capability_issue%rowtype;
  v_request secure_object.capability_request%rowtype;
  v_action uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.capability_id::text, 0));
  select i.* into v_issue from secure_object.capability_issue i where i.id = new.capability_id;
  select r.* into v_request from secure_object.capability_request r where r.id = v_issue.request_id;
  select secure_object.require_exact_action(
    'consume_secure_object_capability',
    v_request.organization_id,
    jsonb_build_object(
      'capabilityId', v_issue.id,
      'authorityRef', v_request.external_authority_ref,
      'revisionRef', v_request.external_revision_ref,
      'externalContentSha256', v_issue.external_content_sha256,
      'purpose', v_issue.purpose,
      'workloadIdentityRef', v_issue.workload_identity_ref,
      'policyDecisionRef', v_issue.policy_decision_ref
    )
  ) into v_action;
  if exists (
    select 1 from secure_object.capability_revocation r where r.capability_id = new.capability_id
  ) then
    raise exception 'secure-object capability is revoked'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  new.consumed_at := secure_object.action_effective_at(v_action);
  if new.consumed_at >= v_request.expires_at then
    raise exception 'secure-object capability is expired'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  new.actor_id := core.current_actor();
  new.action_id := v_action;
  return new;
end
$$;

create function secure_object.enforce_erasure_request_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare v_action uuid;
begin
  select secure_object.require_exact_action(
    'request_secure_object_erasure',
    new.organization_id,
    jsonb_build_object(
      'organizationId', new.organization_id,
      'classificationId', new.classification_id,
      'authorityRef', new.external_authority_ref,
      'revisionRef', new.external_revision_ref,
      'externalContentSha256', new.external_content_sha256,
      'purpose', new.purpose,
      'workloadIdentityRef', new.workload_identity_ref,
      'policyDecisionRef', new.policy_decision_ref
    )
  ) into v_action;
  new.actor_id := core.current_actor();
  new.action_id := v_action;
  new.requested_at := secure_object.action_effective_at(v_action);
  return new;
end
$$;

create function secure_object.enforce_erasure_tombstone_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare
  v_request secure_object.erasure_request%rowtype;
  v_key secure_object.authority_signing_key%rowtype;
  v_action uuid;
  v_effective_at timestamptz;
begin
  select r.* into v_request from secure_object.erasure_request r
   where r.id = new.erasure_request_id;
  select k.* into v_key from secure_object.authority_signing_key k
   where k.id = new.signing_key_registry_id;

  select secure_object.require_exact_action(
    'record_secure_object_erasure',
    v_request.organization_id,
    jsonb_build_object(
      'requestId', v_request.id,
      'authorityRef', v_request.external_authority_ref,
      'revisionRef', v_request.external_revision_ref,
      'externalContentSha256', v_request.external_content_sha256,
      'purpose', v_request.purpose,
      'workloadIdentityRef', v_request.workload_identity_ref,
      'policyDecisionRef', v_request.policy_decision_ref,
      'signingKeyRegistryId', v_key.id
    )
  ) into v_action;
  v_effective_at := secure_object.action_effective_at(v_action);
  if v_key.organization_id <> v_request.organization_id
     or v_key.external_authority_ref <> v_request.external_authority_ref
     or v_key.valid_from > v_effective_at
     or (v_key.valid_until is not null and v_key.valid_until <= v_effective_at)
     or exists (
       select 1 from secure_object.authority_signing_key_revocation r
        where r.signing_key_registry_id = v_key.id
     ) then
    raise exception 'SOA signing key is not registered and active for exact authority'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  new.actor_id := core.current_actor();
  new.action_id := v_action;
  new.erased_at := v_effective_at;
  new.signing_key_id := v_key.key_id;
  return new;
end
$$;

revoke execute on function secure_object.enforce_key_registration_action() from public;
revoke execute on function secure_object.enforce_key_revocation_action() from public;
revoke execute on function secure_object.enforce_capability_request_action() from public;
revoke execute on function secure_object.enforce_capability_issue_action() from public;
revoke execute on function secure_object.enforce_capability_revocation_action() from public;
revoke execute on function secure_object.enforce_capability_consumption_action() from public;
revoke execute on function secure_object.enforce_erasure_request_action() from public;
revoke execute on function secure_object.enforce_erasure_tombstone_action() from public;

create trigger authority_signing_key_1_action
  before insert on secure_object.authority_signing_key
  for each row execute function secure_object.enforce_key_registration_action();
create trigger authority_signing_key_revocation_1_action
  before insert on secure_object.authority_signing_key_revocation
  for each row execute function secure_object.enforce_key_revocation_action();
create trigger capability_request_1_action
  before insert on secure_object.capability_request
  for each row execute function secure_object.enforce_capability_request_action();
create trigger capability_issue_1_action
  before insert on secure_object.capability_issue
  for each row execute function secure_object.enforce_capability_issue_action();
create trigger capability_revocation_1_action
  before insert on secure_object.capability_revocation
  for each row execute function secure_object.enforce_capability_revocation_action();
create trigger capability_consumption_1_action
  before insert on secure_object.capability_consumption
  for each row execute function secure_object.enforce_capability_consumption_action();
create trigger erasure_request_1_action
  before insert on secure_object.erasure_request
  for each row execute function secure_object.enforce_erasure_request_action();
create trigger erasure_tombstone_1_action
  before insert on secure_object.erasure_tombstone
  for each row execute function secure_object.enforce_erasure_tombstone_action();

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'authority_signing_key', 'authority_signing_key_revocation',
    'capability_request', 'capability_issue', 'capability_revocation',
    'capability_consumption', 'erasure_request', 'erasure_tombstone'
  ] loop
    execute format(
      'create trigger %I after update or delete or truncate on secure_object.%I '
      'for each statement execute function core.refuse_mutation()',
      v_table || '_append_only', v_table
    );
  end loop;
end
$$;

-- ── Organization/classification RLS ────────────────────────────────────────────────────

alter table secure_object.authority_signing_key enable row level security;
alter table secure_object.authority_signing_key force row level security;
create policy authority_signing_key_read on secure_object.authority_signing_key
  for select using (organization_id = core.current_organization());
create policy authority_signing_key_insert on secure_object.authority_signing_key
  for insert with check (organization_id = core.current_organization());

alter table secure_object.authority_signing_key_revocation enable row level security;
alter table secure_object.authority_signing_key_revocation force row level security;
create policy authority_signing_key_revocation_read
  on secure_object.authority_signing_key_revocation for select using (
    exists (
      select 1 from secure_object.authority_signing_key k
       where k.id = signing_key_registry_id
    )
  );
create policy authority_signing_key_revocation_insert
  on secure_object.authority_signing_key_revocation for insert with check (
    exists (
      select 1 from secure_object.authority_signing_key k
       where k.id = signing_key_registry_id
    )
  );

alter table secure_object.capability_request enable row level security;
alter table secure_object.capability_request force row level security;
create policy capability_request_read on secure_object.capability_request
  for select using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );
create policy capability_request_insert on secure_object.capability_request
  for insert with check (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );

alter table secure_object.capability_issue enable row level security;
alter table secure_object.capability_issue force row level security;
create policy capability_issue_read on secure_object.capability_issue for select using (
  exists (select 1 from secure_object.capability_request r where r.id = request_id)
);
create policy capability_issue_insert on secure_object.capability_issue for insert with check (
  exists (select 1 from secure_object.capability_request r where r.id = request_id)
);

alter table secure_object.capability_revocation enable row level security;
alter table secure_object.capability_revocation force row level security;
create policy capability_revocation_read on secure_object.capability_revocation for select using (
  exists (select 1 from secure_object.capability_issue i where i.id = capability_id)
);
create policy capability_revocation_insert on secure_object.capability_revocation
  for insert with check (
    exists (select 1 from secure_object.capability_issue i where i.id = capability_id)
  );

alter table secure_object.capability_consumption enable row level security;
alter table secure_object.capability_consumption force row level security;
create policy capability_consumption_read on secure_object.capability_consumption
  for select using (
    exists (select 1 from secure_object.capability_issue i where i.id = capability_id)
  );
create policy capability_consumption_insert on secure_object.capability_consumption
  for insert with check (
    exists (select 1 from secure_object.capability_issue i where i.id = capability_id)
  );

alter table secure_object.erasure_request enable row level security;
alter table secure_object.erasure_request force row level security;
create policy erasure_request_read on secure_object.erasure_request for select using (
  organization_id = core.current_organization()
  and (select rank from registry.classification where id = classification_id)
    <= core.current_classification_rank()
);
create policy erasure_request_insert on secure_object.erasure_request for insert with check (
  organization_id = core.current_organization()
  and (select rank from registry.classification where id = classification_id)
    <= core.current_classification_rank()
);

alter table secure_object.erasure_tombstone enable row level security;
alter table secure_object.erasure_tombstone force row level security;
create policy erasure_tombstone_read on secure_object.erasure_tombstone for select using (
  exists (select 1 from secure_object.erasure_request r where r.id = erasure_request_id)
);
create policy erasure_tombstone_insert on secure_object.erasure_tombstone for insert with check (
  exists (select 1 from secure_object.erasure_request r where r.id = erasure_request_id)
);

-- Preservation is deliberately cross-organization and cross-classification. kf_backup is
-- SELECT-only: it can copy the append-only ledger but cannot mint authority or receipts.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'authority_signing_key', 'authority_signing_key_revocation',
    'capability_request', 'capability_issue', 'capability_revocation',
    'capability_consumption', 'erasure_request', 'erasure_tombstone'
  ] loop
    execute format(
      'create policy %I on secure_object.%I for select to kf_backup using (true)',
      v_table || '_backup_read', v_table
    );
  end loop;
end
$$;

grant select, insert on secure_object.authority_signing_key,
                        secure_object.authority_signing_key_revocation,
                        secure_object.capability_request,
                        secure_object.capability_issue,
                        secure_object.capability_revocation,
                        secure_object.capability_consumption,
                        secure_object.erasure_request,
                        secure_object.erasure_tombstone
  to kf_app;
grant select on all tables in schema secure_object to kf_worker, kf_readonly, kf_auditor;
grant select on all tables in schema secure_object to kf_backup;

-- migrate:down

drop schema if exists secure_object cascade;
drop table if exists ops.encrypted_backup_evidence;
drop table if exists ops.physical_failure_domain_evidence;
alter table ops.restore_drill drop column if exists recovery_seconds;
alter table ops.recovery_objective drop column if exists rto_seconds;
