-- migrate:up

-- A governed promotion is downstream of human decisions. Historical promotion receipts
-- carried opaque evidence references, so there is no truthful way to infer who decided,
-- which role they exercised, or what exact candidate/policy tuple they approved.
do $$
begin
  if exists (select 1 from ml.promotion_receipt) then
    raise exception 'ML human-authority migration requires an empty promotion receipt ledger'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'Export and independently disposition opaque historical decision references before migration.';
  end if;
end
$$;

alter table ml.promotion_receipt
  add constraint promotion_quality_authority_always_required
  check (quality_authority_decision_ref_id is not null);

-- One first-class, append-only decision. UUID object identity is sufficient; no enterprise
-- namespace or identifier is allocated by this action.
create table ml.promotion_authority_decision (
  object_id             uuid primary key references core.object (id) on delete restrict,
  organization_id       uuid not null references org.organization (id) on delete restrict,
  action_id             uuid not null unique references core.action (id) on delete restrict,
  approval_id           uuid not null unique references core.approval (id) on delete restrict,
  evidence_ref_id       uuid not null unique references ml.aggregate_reference (id)
    on delete restrict,
  approver_id           uuid not null references org.person (id) on delete restrict,
  approver_role_id      uuid not null references org.role_assignment (id) on delete restrict,
  authority_kind        text not null check (authority_kind in ('technical', 'quality')),
  alias_id              text not null check (alias_id ~ '^[a-z][a-z0-9._:-]{0,127}$'),
  candidate_ref_id      uuid not null references ml.aggregate_reference (id) on delete restrict,
  run_seal_id           uuid not null references ml.run_seal (id) on delete restrict,
  policy_ref_id         uuid not null references ml.aggregate_reference (id) on delete restrict,
  risk_tier             text not null check (risk_tier in ('research', 'regulated', 'high_risk')),
  decision_claim_sha256 text not null unique check (decision_claim_sha256 ~ '^[0-9a-f]{64}$'),
  effective_at          timestamptz not null,
  valid_until           timestamptz,
  recorded_at           timestamptz not null default now(),
  constraint promotion_authority_decision_window
    check (valid_until is null or valid_until > effective_at),
  unique (
    object_id, organization_id, authority_kind, alias_id, candidate_ref_id,
    run_seal_id, policy_ref_id, risk_tier
  )
);

create trigger promotion_authority_decision_append_only
  before update or delete or truncate on ml.promotion_authority_decision
  for each statement execute function ml.refuse_mutation();

alter table ml.promotion_authority_decision enable row level security;
alter table ml.promotion_authority_decision force row level security;
create policy promotion_authority_decision_preservation
  on ml.promotion_authority_decision for select to kf_auditor, kf_backup using (true);
create policy promotion_authority_decision_scoped_read
  on ml.promotion_authority_decision for select
  using (
    organization_id = core.current_organization()
    and exists (select 1 from core.object object where object.id = object_id)
    and exists (select 1 from ml.aggregate_reference reference where reference.id = evidence_ref_id)
  );
create policy promotion_authority_decision_typed_insert
  on ml.promotion_authority_decision for insert to kf_app
  with check (
    organization_id = core.current_organization()
    and action_id = core.current_action_id()
    and approver_id = core.current_actor()
  );

grant select on ml.promotion_authority_decision
  to kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;
revoke insert, update, delete, truncate on ml.promotion_authority_decision
  from public, kf_app, kf_worker, kf_ml_promoter, kf_readonly, kf_auditor, kf_backup;

-- Single write seam for a decision action. It accepts only the server-created object id;
-- every other semantic comes from the exact fresh core.action row in current transaction.
create function ml.authorize_promotion_decision_action(
  p_decision_object_id uuid
) returns table (
  decision_object_id uuid,
  approval_id uuid,
  evidence_ref_id uuid,
  decision_claim_sha256 text
)
language plpgsql
security definer
set search_path = pg_catalog, core, org, registry, ml, public
as $$
declare
  v_actor uuid := core.current_actor();
  v_action_id uuid := core.current_action_id();
  v_role_setting text := nullif(current_setting('kf.acting_role', true), '');
  v_request_id text := nullif(current_setting('kf.request_id', true), '');
  v_role_id uuid;
  v_action core.action%rowtype;
  v_object core.object%rowtype;
  v_alias_id text;
  v_authority_kind text;
  v_candidate_ref_id uuid;
  v_run_seal_id uuid;
  v_policy_ref_id uuid;
  v_risk_tier text;
  v_valid_until_text text;
  v_valid_until timestamptz;
  v_required_role text;
  v_run_organization_id uuid;
  v_candidate_organization_id uuid;
  v_policy_organization_id uuid;
  v_policy_id text;
  v_run_seal_sha256 text;
  v_derived_classification text;
  v_meaning text;
  v_effective_at_text text;
  v_valid_until_json text;
  v_claim text;
  v_claim_sha256 text;
  v_approval_id uuid;
  v_evidence_ref_id uuid;
begin
  if v_action_id is null or v_role_setting is null then
    raise exception 'ML promotion decision requires exact open typed-action context'
      using errcode = 'insufficient_privilege';
  end if;
  begin
    v_role_id := v_role_setting::uuid;
  exception when invalid_text_representation then
    raise exception 'ML promotion decision has an invalid acting-role context'
      using errcode = 'insufficient_privilege';
  end;

  select action.* into v_action
    from core.action action where action.id = v_action_id;
  if not found
     or v_action.action_type is distinct from 'authorize_ml_promotion'
     or v_action.result_status is distinct from 'applied'
     or v_action.actor_id is distinct from v_actor
     or v_action.acting_role_id is distinct from v_role_id
     or v_action.request_id is distinct from v_request_id
     or v_action.target_ids is distinct from array[p_decision_object_id]::uuid[]
     or v_action.reason is null
     or btrim(v_action.reason) = '' then
    raise exception 'ML promotion decision does not match exact action, actor, role, request, target, and reason'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from core.action action
     where action.id = v_action_id
       and action.xmin::text = pg_current_xact_id()::text
  ) or exists (
    select 1 from core.audit_event event where event.action_id = v_action_id
  ) then
    raise exception 'ML promotion decision must materialize in its action transaction before audit'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_action.effective_at is distinct from date_trunc('milliseconds', v_action.effective_at) then
    raise exception 'ML promotion decision effective time must have canonical millisecond precision'
      using errcode = 'invalid_parameter_value';
  end if;

  if not (
    v_action.parameters ?& array[
      'aliasId', 'authorityKind', 'candidateRefId', 'policyRefId', 'riskTier', 'runSealId'
    ]
  ) or v_action.parameters - array[
    'aliasId', 'authorityKind', 'candidateRefId', 'policyRefId',
    'riskTier', 'runSealId', 'validUntil'
  ] <> '{}'::jsonb or exists (
    select 1
      from jsonb_each(v_action.parameters) parameter
     where jsonb_typeof(parameter.value) <> 'string'
  ) then
    raise exception 'ML promotion decision action has non-closed parameters'
      using errcode = 'invalid_parameter_value';
  end if;

  v_alias_id := v_action.parameters ->> 'aliasId';
  v_authority_kind := v_action.parameters ->> 'authorityKind';
  v_risk_tier := v_action.parameters ->> 'riskTier';
  if v_alias_id !~ '^[a-z][a-z0-9._:-]{0,127}$'
     or v_authority_kind not in ('technical', 'quality')
     or v_risk_tier not in ('research', 'regulated', 'high_risk') then
    raise exception 'ML promotion decision has unsafe alias, authority kind, or risk tier'
      using errcode = 'invalid_parameter_value';
  end if;
  begin
    v_candidate_ref_id := (v_action.parameters ->> 'candidateRefId')::uuid;
    v_run_seal_id := (v_action.parameters ->> 'runSealId')::uuid;
    v_policy_ref_id := (v_action.parameters ->> 'policyRefId')::uuid;
  exception when invalid_text_representation then
    raise exception 'ML promotion decision references must be canonical UUIDs'
      using errcode = 'invalid_parameter_value';
  end;
  if v_action.parameters ->> 'candidateRefId' <> v_candidate_ref_id::text
     or v_action.parameters ->> 'runSealId' <> v_run_seal_id::text
     or v_action.parameters ->> 'policyRefId' <> v_policy_ref_id::text then
    raise exception 'ML promotion decision references must be canonical UUIDs'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_action.parameters ? 'validUntil' then
    v_valid_until_text := v_action.parameters ->> 'validUntil';
    if v_valid_until_text !~
         '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
      raise exception 'ML promotion decision validUntil must be canonical RFC 3339 milliseconds'
        using errcode = 'invalid_parameter_value';
    end if;
    begin
      v_valid_until := v_valid_until_text::timestamptz;
    exception when others then
      raise exception 'ML promotion decision validUntil is not a valid timestamp'
        using errcode = 'invalid_parameter_value';
    end;
    if to_char(
         v_valid_until at time zone 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) <> v_valid_until_text or v_valid_until <= v_action.effective_at then
      raise exception 'ML promotion decision validUntil must be canonical and later than effective time'
        using errcode = 'check_violation';
    end if;
  end if;

  select object.* into strict v_object
    from core.object object where object.id = p_decision_object_id;
  if v_object.object_type <> 'ml_promotion_decision'
     or v_object.lifecycle_state <> 'recorded'
     or v_object.authority_domain <> 'qms'
     or v_object.retention_class <> 'quality_record'
     or v_object.enterprise_id is not null
     or v_object.organization_id is distinct from core.current_organization()
     or v_object.created_by is distinct from v_actor
     or not exists (
       select 1 from core.object object
        where object.id = p_decision_object_id
          and object.xmin::text = pg_current_xact_id()::text
     ) then
    raise exception 'ML promotion decision target is not exact fresh first-class object'
      using errcode = 'integrity_constraint_violation';
  end if;

  select run_ref.organization_id, candidate.organization_id, policy.organization_id,
         policy.policy_id, seal.seal_sha256,
         (array_agg(reference.classification_id order by classification.rank desc))[1]
    into strict v_run_organization_id, v_candidate_organization_id,
                v_policy_organization_id, v_policy_id, v_run_seal_sha256,
                v_derived_classification
    from ml.run_seal seal
    join ml.run_lineage lineage on lineage.id = seal.run_lineage_id
    join ml.aggregate_reference run_ref on run_ref.id = lineage.run_ref_id
    join ml.run_lineage_output output
      on output.run_lineage_id = lineage.id
     and output.aggregate_ref_id = v_candidate_ref_id
    join ml.aggregate_reference candidate
      on candidate.id = output.aggregate_ref_id
     and candidate.aggregate_kind = 'candidate'
    join ml.aggregate_reference policy
      on policy.id = lineage.metric_policy_ref_id
     and policy.id = v_policy_ref_id
     and policy.aggregate_kind = 'metric_policy'
    cross join lateral (values (run_ref.id), (candidate.id), (policy.id)) ids(reference_id)
    join ml.aggregate_reference reference on reference.id = ids.reference_id
    join registry.classification classification
      on classification.id = reference.classification_id
   where seal.id = v_run_seal_id
   group by seal.seal_sha256, run_ref.id, candidate.id, policy.id, policy.policy_id;
  if v_run_organization_id is distinct from v_object.organization_id
     or v_candidate_organization_id is distinct from v_object.organization_id
     or v_policy_organization_id is distinct from v_object.organization_id
     or v_object.classification is distinct from v_derived_classification then
    raise exception 'ML promotion decision references or derived classification do not match target'
      using errcode = 'check_violation';
  end if;

  v_required_role := v_authority_kind || '_authority';
  if not exists (
    select 1
      from org.person person
      join org.role_assignment assignment on assignment.subject_id = person.id
      join core.object person_object on person_object.id = person.id
      join core.object role_object on role_object.id = assignment.id
     where person.id = v_actor
       and person.organization = v_object.organization_id
       and person_object.object_type = 'person'
       and person_object.lifecycle_state = 'active'
       and person_object.organization_id = v_object.organization_id
       and role_object.object_type = 'role_assignment'
       and role_object.lifecycle_state = 'active'
       and role_object.organization_id = v_object.organization_id
       and assignment.id = v_role_id
       and assignment.role_id = v_required_role
       and assignment.scope_id = v_object.organization_id
       and assignment.valid_from <= v_action.effective_at
       and (assignment.valid_to is null or assignment.valid_to > v_action.effective_at)
  ) then
    raise exception 'ML promotion decision requires active % held by a real organization person',
      v_required_role using errcode = 'insufficient_privilege';
  end if;

  v_meaning := 'Authorize exact ' || v_authority_kind || ' governed ML promotion decision';
  insert into core.approval (
    object_id, action_id, approver_id, approver_role, meaning, effective_at
  ) values (
    p_decision_object_id, v_action_id, v_actor, v_role_id, v_meaning, v_action.effective_at
  ) returning id into v_approval_id;

  v_effective_at_text := to_char(
    v_action.effective_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_valid_until_json := case
    when v_valid_until is null then 'null'
    else to_jsonb(v_valid_until_text)::text
  end;
  -- ASCII field names are emitted in RFC 8785 lexical order. Aggregate references use the
  -- shared canonical function, so TypeScript and SQL commit to identical evidence bytes.
  v_claim := '{'
    || '"actionId":' || to_jsonb(v_action_id::text)::text
    || ',"actorId":' || to_jsonb(v_actor::text)::text
    || ',"aliasId":' || to_jsonb(v_alias_id)::text
    || ',"authorityKind":' || to_jsonb(v_authority_kind)::text
    || ',"candidate":' || ml.canonical_aggregate_reference(v_candidate_ref_id)
    || ',"decisionObjectId":' || to_jsonb(p_decision_object_id::text)::text
    || ',"effectiveAt":' || to_jsonb(v_effective_at_text)::text
    || ',"organizationId":' || to_jsonb(v_object.organization_id::text)::text
    || ',"policy":' || ml.canonical_aggregate_reference(v_policy_ref_id)
    || ',"reason":' || to_jsonb(v_action.reason)::text
    || ',"riskTier":' || to_jsonb(v_risk_tier)::text
    || ',"roleAssignmentId":' || to_jsonb(v_role_id::text)::text
    || ',"runSealDigest":' || to_jsonb(v_run_seal_sha256)::text
    || ',"schemaVersion":"kf.ml.promotion-decision.v1"'
    || ',"validUntil":' || v_valid_until_json
    || '}';
  v_claim_sha256 := encode(public.digest(convert_to(v_claim, 'UTF8'), 'sha256'), 'hex');

  insert into ml.aggregate_reference (
    organization_id, aggregate_kind, authority_id, revision_id, sha256,
    classification_id, policy_id
  ) values (
    v_object.organization_id, 'evidence', p_decision_object_id::text, v_action_id::text,
    v_claim_sha256, v_derived_classification, v_policy_id
  ) returning id into v_evidence_ref_id;

  insert into ml.promotion_authority_decision (
    object_id, organization_id, action_id, approval_id, evidence_ref_id,
    approver_id, approver_role_id, authority_kind, alias_id, candidate_ref_id,
    run_seal_id, policy_ref_id, risk_tier, decision_claim_sha256,
    effective_at, valid_until
  ) values (
    p_decision_object_id, v_object.organization_id, v_action_id, v_approval_id,
    v_evidence_ref_id, v_actor, v_role_id, v_authority_kind, v_alias_id,
    v_candidate_ref_id, v_run_seal_id, v_policy_ref_id, v_risk_tier,
    v_claim_sha256, v_action.effective_at, v_valid_until
  );

  return query select p_decision_object_id, v_approval_id, v_evidence_ref_id, v_claim_sha256;
exception
  when no_data_found then
    raise exception 'ML promotion decision references are unavailable or not exact sealed lineage'
      using errcode = 'insufficient_privilege';
end
$$;

revoke execute on function ml.authorize_promotion_decision_action(uuid) from public;
grant execute on function ml.authorize_promotion_decision_action(uuid) to kf_app;

-- The effect runs before the dispatcher writes its audit and outbox rows. Check at commit so
-- a direct function call cannot leave a promotion-capable decision outside that envelope.
create function ml.require_promotion_decision_action_envelope() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if (
    select count(*)
      from core.audit_event event
     where event.action_id = new.action_id
       and event.actor_id = new.approver_id
       and event.acting_role_id = new.approver_role_id
       and event.action_type = 'authorize_ml_promotion'
       and event.object_id = new.object_id
       and event.effective_at = new.effective_at
       and event.request_id is not distinct from (
         select action.request_id from core.action action where action.id = new.action_id
       )
       and event.reason is not distinct from (
         select action.reason from core.action action where action.id = new.action_id
       )
  ) <> 1 then
    raise exception 'ML promotion decision requires exactly one matching dispatcher audit event'
      using errcode = 'integrity_constraint_violation';
  end if;
  if (
    select count(*)
      from core.outbox outbox
     where outbox.action_id = new.action_id
       and outbox.topic = 'kf.authorize_ml_promotion'
       and outbox.payload = jsonb_build_object(
         'action_id', new.action_id::text,
         'targets', to_jsonb(array[new.object_id]::uuid[])
       )
  ) <> 1 then
    raise exception 'ML promotion decision requires exactly one matching dispatcher outbox event'
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end
$$;

create constraint trigger promotion_authority_decision_action_envelope
  after insert on ml.promotion_authority_decision
  deferrable initially deferred
  for each row execute function ml.require_promotion_decision_action_envelope();

-- Receipt admission resolves authority decisions by typed row, not by evidence-shaped
-- references. Until an immutable organization-owned risk binding exists, risk_tier is
-- descriptive only and every promotion requires independent Technical and Quality decisions.
create function ml.require_effective_promotion_authority_decision(
  p_evidence_ref_id uuid,
  p_authority_kind text,
  p_organization_id uuid,
  p_alias_id text,
  p_candidate_ref_id uuid,
  p_run_seal_id uuid,
  p_policy_ref_id uuid,
  p_risk_tier text,
  p_promoted_at timestamptz
) returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, core, org, ml
as $$
declare v_approver_id uuid;
begin
  select decision.approver_id into v_approver_id
    from ml.promotion_authority_decision decision
    join core.object object on object.id = decision.object_id
    join core.action action on action.id = decision.action_id
    join core.approval approval on approval.id = decision.approval_id
    join ml.aggregate_reference evidence on evidence.id = decision.evidence_ref_id
    join org.role_assignment assignment on assignment.id = decision.approver_role_id
   where decision.evidence_ref_id = p_evidence_ref_id
     and decision.authority_kind = p_authority_kind
     and decision.organization_id = p_organization_id
     and decision.alias_id = p_alias_id
     and decision.candidate_ref_id = p_candidate_ref_id
     and decision.run_seal_id = p_run_seal_id
     and decision.policy_ref_id = p_policy_ref_id
     and decision.risk_tier = p_risk_tier
     and decision.effective_at <= p_promoted_at
     and (decision.valid_until is null or decision.valid_until > p_promoted_at)
     and object.object_type = 'ml_promotion_decision'
     and object.lifecycle_state = 'recorded'
     and object.organization_id = p_organization_id
     and object.enterprise_id is null
     and action.action_type = 'authorize_ml_promotion'
     and action.actor_id = decision.approver_id
     and action.acting_role_id = decision.approver_role_id
     and action.target_ids = array[decision.object_id]::uuid[]
     and action.result_status = 'applied'
     and action.reason is not null and btrim(action.reason) <> ''
     and approval.object_id = decision.object_id
     and approval.action_id = decision.action_id
     and approval.approver_id = decision.approver_id
     and approval.approver_role = decision.approver_role_id
     and approval.effective_at = decision.effective_at
     and approval.meaning =
       'Authorize exact ' || decision.authority_kind || ' governed ML promotion decision'
     and assignment.subject_id = decision.approver_id
     and assignment.role_id = decision.authority_kind || '_authority'
     and assignment.scope_id = p_organization_id
     and assignment.valid_from <= decision.effective_at
     and (assignment.valid_to is null or assignment.valid_to > decision.effective_at)
     and evidence.organization_id = p_organization_id
     and evidence.aggregate_kind = 'evidence'
     and evidence.authority_id = decision.object_id::text
     and evidence.revision_id = decision.action_id::text
     and evidence.sha256 = decision.decision_claim_sha256
     and evidence.classification_id = object.classification
     and exists (
       select 1 from core.audit_event event
        where event.action_id = decision.action_id
          and event.actor_id = decision.approver_id
          and event.acting_role_id = decision.approver_role_id
          and event.action_type = 'authorize_ml_promotion'
          and event.object_id = decision.object_id
          and event.effective_at = decision.effective_at
          and event.request_id is not distinct from action.request_id
          and event.reason is not distinct from action.reason
     )
     and exists (
       select 1 from core.outbox outbox
        where outbox.action_id = decision.action_id
          and outbox.topic = 'kf.authorize_ml_promotion'
          and outbox.payload = jsonb_build_object(
            'action_id', decision.action_id::text,
            'targets', to_jsonb(array[decision.object_id]::uuid[])
          )
     );
  if not found then
    raise exception '% promotion authority reference is not a matching effective typed human decision',
      p_authority_kind using errcode = 'check_violation';
  end if;
  return v_approver_id;
end
$$;

create function ml.enforce_typed_promotion_authority() returns trigger
language plpgsql
set search_path = pg_catalog, ml
as $$
declare
  v_technical_approver uuid;
  v_quality_approver uuid;
begin
  v_technical_approver := ml.require_effective_promotion_authority_decision(
    new.technical_authority_decision_ref_id, 'technical', new.organization_id,
    new.alias_id, new.candidate_ref_id, new.run_seal_id, new.policy_ref_id,
    new.risk_tier, new.promoted_at
  );
  if new.quality_authority_decision_ref_id is null then
    raise exception 'every promotion requires a matching Quality Authority decision until authoritative risk binding exists'
      using errcode = 'check_violation';
  end if;
  v_quality_approver := ml.require_effective_promotion_authority_decision(
    new.quality_authority_decision_ref_id, 'quality', new.organization_id,
    new.alias_id, new.candidate_ref_id, new.run_seal_id, new.policy_ref_id,
    new.risk_tier, new.promoted_at
  );
  if v_quality_approver = v_technical_approver then
    raise exception 'technical and quality promotion decisions require distinct humans'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger promotion_receipt_typed_authority_validate
  before insert on ml.promotion_receipt
  for each row execute function ml.enforce_typed_promotion_authority();

revoke execute on function ml.require_effective_promotion_authority_decision(
  uuid, text, uuid, text, uuid, uuid, uuid, text, timestamptz
) from public;
revoke execute on function ml.enforce_typed_promotion_authority() from public;

-- Revocation and admission synchronize on one advisory lock. A repeatable-read or
-- serializable snapshot cannot refresh after waiting, so reject it after lock acquisition
-- instead of accepting authority state that may have been withdrawn while waiting.
create or replace function ml.active_promotion_signing_public_key(
  p_organization_id uuid,
  p_signing_key_id text,
  p_effective_at timestamptz
) returns bytea
language plpgsql
security definer
set search_path = pg_catalog, ml
as $$
declare
  v_key_registry_id uuid;
  v_public_key_spki_der bytea;
begin
  select key.id into v_key_registry_id
    from ml.promotion_signing_key key
   where key.organization_id = p_organization_id
     and key.key_id = p_signing_key_id;
  if not found then
    raise exception 'governed promotion requires an active owner-registered signing key'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('kf:ml:promotion-signing-key:' || v_key_registry_id::text, 0)
  );
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'promotion signing-key admission requires READ COMMITTED isolation'
      using errcode = 'object_not_in_prerequisite_state',
            hint = 'Retry the signed append in a READ COMMITTED transaction so revocation state refreshes after the authority lock.';
  end if;
  select decode(key.public_key_spki_der_base64, 'base64')
    into v_public_key_spki_der
    from ml.promotion_signing_key key
   where key.id = v_key_registry_id
     and key.valid_from <= p_effective_at
     and (key.valid_until is null or key.valid_until > p_effective_at)
     and key.valid_from <= clock_timestamp()
     and (key.valid_until is null or key.valid_until > clock_timestamp())
     and not exists (
       select 1 from ml.promotion_signing_key_revocation revoked
        where revoked.signing_key_registry_id = key.id
     );
  if not found then
    raise exception 'governed promotion requires an active owner-registered signing key'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return v_public_key_spki_der;
end
$$;

comment on table ml.promotion_authority_decision is
  'First-class append-only human ML promotion authority. Exact actor, role, action, candidate, sealed run, policy, risk and effectivity are bound to one approval and canonical evidence reference.';
comment on column ml.promotion_authority_decision.risk_tier is
  'Descriptive claim only. It grants no authorization until an immutable organization-scoped candidate, run-seal and policy risk binding exists; every promotion therefore requires independent Technical and Quality decisions.';
comment on constraint promotion_quality_authority_always_required on ml.promotion_receipt is
  'Fail-closed interim: every promotion requires Quality Authority because risk_tier is descriptive, not an authoritative risk classification.';
comment on function ml.authorize_promotion_decision_action(uuid) is
  'Only ML promotion-decision write seam. Reads complete semantics from exact fresh authorize_ml_promotion action and emits typed decision, approval and canonical evidence in one transaction before audit.';

-- migrate:down

create or replace function ml.active_promotion_signing_public_key(
  p_organization_id uuid,
  p_signing_key_id text,
  p_effective_at timestamptz
) returns bytea
language plpgsql
security definer
set search_path = pg_catalog, ml
as $$
declare
  v_key_registry_id uuid;
  v_public_key_spki_der bytea;
begin
  select key.id into v_key_registry_id
    from ml.promotion_signing_key key
   where key.organization_id = p_organization_id
     and key.key_id = p_signing_key_id;
  if not found then
    raise exception 'governed promotion requires an active owner-registered signing key'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('kf:ml:promotion-signing-key:' || v_key_registry_id::text, 0)
  );
  select decode(key.public_key_spki_der_base64, 'base64')
    into v_public_key_spki_der
    from ml.promotion_signing_key key
   where key.id = v_key_registry_id
     and key.valid_from <= p_effective_at
     and (key.valid_until is null or key.valid_until > p_effective_at)
     and key.valid_from <= clock_timestamp()
     and (key.valid_until is null or key.valid_until > clock_timestamp())
     and not exists (
       select 1 from ml.promotion_signing_key_revocation revoked
        where revoked.signing_key_registry_id = key.id
     );
  if not found then
    raise exception 'governed promotion requires an active owner-registered signing key'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  return v_public_key_spki_der;
end
$$;

alter table ml.promotion_receipt
  drop constraint if exists promotion_quality_authority_always_required;
drop trigger if exists promotion_receipt_typed_authority_validate on ml.promotion_receipt;
drop function if exists ml.enforce_typed_promotion_authority();
drop function if exists ml.require_effective_promotion_authority_decision(
  uuid, text, uuid, text, uuid, uuid, uuid, text, timestamptz
);
drop trigger if exists promotion_authority_decision_action_envelope
  on ml.promotion_authority_decision;
drop function if exists ml.require_promotion_decision_action_envelope();
drop function if exists ml.authorize_promotion_decision_action(uuid);
drop table if exists ml.promotion_authority_decision;
