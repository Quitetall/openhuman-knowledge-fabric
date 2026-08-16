-- migrate:up

-- Same-transaction authorship was proved by comparing two different-width transaction ids.
--
-- `require_exact_action` and its siblings refuse a caller who replays a previously committed
-- action id as fresh mutation authority. The test was:
--
--     and a.xmin::text = pg_current_xact_id()::text
--
-- `xmin` is a 32-bit `xid`. `pg_current_xact_id()` returns a 64-bit `xid8` carrying an epoch
-- in its high bits. Their text forms agree only while that epoch is zero — that is, for the
-- first ~4 billion transactions of a cluster's life. After the first wraparound `xmin::text`
-- still reads e.g. "4" while `pg_current_xact_id()::text` reads "4294967300", the comparison
-- can never hold again, and every secure-object write, every typed ML metric action, every ML
-- registry registration and every ML promotion decision starts raising.
--
-- Fail-closed, so nothing is disclosed and nothing is forged — but the subsystem stops, at a
-- moment nobody chose, for a reason nobody would find quickly.
--
-- The fix is to compare at one width. `xid8::xid` is a built-in cast that keeps the low 32
-- bits, which is exactly what `xmin` holds, so `a.xmin = pg_current_xact_id()::xid` is the
-- same test with no epoch to disagree about. (An xid comparison wraps correctly by
-- construction; that is what the type is for.)
--
-- Five sites in four functions, replaced verbatim apart from that one expression. The bodies
-- below are the deployed definitions; the only difference from what was deployed is the
-- comparison. The contract test in `tests/database/fresh-install.test.ts` asserts the
-- PROPERTY — that no function body carries the text form — rather than naming these four,
-- because a sweep run against a dev database four migrations behind found only three of them
-- and that test found the fourth.


CREATE OR REPLACE FUNCTION secure_object.require_exact_action(p_action_type text, p_organization_id uuid, p_parameters jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'org', 'secure_object'
AS $function$
declare
  v_actor uuid := core.current_actor();
  v_action_id uuid := core.current_action_id();
  v_role_id uuid := nullif(current_setting('kf.acting_role', true), '')::uuid;
  v_action core.action%rowtype;
  v_allowed_roles text[];
begin
  case
    when p_action_type = any(array[
      'request_secure_object_access',
      'issue_secure_object_capability',
      'revoke_secure_object_capability',
      'consume_secure_object_capability'
    ]::text[]) then
      v_allowed_roles := array['technical_authority']::text[];
    when p_action_type = any(array[
      'request_secure_object_erasure',
      'record_secure_object_erasure'
    ]::text[]) then
      v_allowed_roles := array['quality_authority']::text[];
    when p_action_type = any(array[
      'register_secure_object_authority_key',
      'revoke_secure_object_authority_key'
    ]::text[]) then
      v_allowed_roles := array['system_administrator']::text[];
    else
      raise exception 'secure-object action % has no role-category policy', p_action_type
        using errcode = 'insufficient_privilege';
  end case;

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
  if not exists (
    select 1 from core.action a
     where a.id = v_action_id
       and a.xmin = pg_current_xact_id()::xid
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
       and ra.role_id = any(v_allowed_roles)
       and ra.valid_from <= v_action.effective_at
       and (ra.valid_to is null or ra.valid_to > v_action.effective_at)
  ) then
    raise exception 'secure-object action role category is not authorized for %; requires %',
      p_action_type, array_to_string(v_allowed_roles, ' or ')
      using errcode = 'insufficient_privilege';
  end if;
  return v_action_id;
end
$function$;

CREATE OR REPLACE FUNCTION ml.require_exact_metric_action(p_action_type text, p_organization_id uuid, p_parameters jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'org', 'registry', 'ml'
AS $function$
declare
  v_actor uuid := core.current_actor();
  v_action_id uuid := core.current_action_id();
  v_role_setting text := nullif(current_setting('kf.acting_role', true), '');
  v_request_id text := nullif(current_setting('kf.request_id', true), '');
  v_role_id uuid;
  v_action core.action%rowtype;
begin
  if p_action_type not in ('authorize_ml_metric_stream', 'append_ml_metric_event') then
    raise exception 'ML action % has no typed-action policy', p_action_type
      using errcode = 'insufficient_privilege';
  end if;
  if v_action_id is null or v_role_setting is null then
    raise exception 'ML write requires exact open typed-action context'
      using errcode = 'insufficient_privilege';
  end if;
  begin
    v_role_id := v_role_setting::uuid;
  exception when invalid_text_representation then
    raise exception 'ML write has an invalid acting-role context'
      using errcode = 'insufficient_privilege';
  end;

  select action.* into v_action from core.action action where action.id = v_action_id;
  if not found
     or v_action.action_type is distinct from p_action_type
     or v_action.result_status is distinct from 'applied'
     or v_action.actor_id is distinct from v_actor
     or v_action.acting_role_id is distinct from v_role_id
     or v_action.request_id is distinct from v_request_id then
    raise exception 'ML write context does not match its exact recorded action, actor, role and request'
      using errcode = 'insufficient_privilege';
  end if;
  if v_action.target_ids is distinct from array[p_organization_id]::uuid[] then
    raise exception 'ML action target must be exactly owning organization %', p_organization_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_action.parameters is distinct from p_parameters then
    raise exception 'ML action parameters do not exactly match ledger semantics'
      using errcode = 'integrity_constraint_violation';
  end if;
  if not exists (
    select 1 from core.action action
     where action.id = v_action_id
       and action.xmin = pg_current_xact_id()::xid
  ) then
    raise exception 'ML action must be applied in its creating transaction'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if exists (select 1 from core.audit_event event where event.action_id = v_action_id) then
    raise exception 'ML action effect must precede its audit event'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if core.current_organization() is distinct from p_organization_id or not exists (
    select 1
      from core.object object
      join org.organization organization on organization.id = object.id
     where object.id = p_organization_id
       and object.object_type = 'organization'
       and object.organization_id = p_organization_id
       and (select classification.rank
              from registry.classification classification
             where classification.id = object.classification)
           <= core.current_classification_rank()
  ) then
    raise exception 'ML target organization does not exist or is not visible'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from org.role_assignment assignment
     where assignment.id = v_role_id
       and assignment.subject_id = v_actor
       and assignment.scope_id = p_organization_id
       and assignment.valid_from <= v_action.effective_at
       and (assignment.valid_to is null or assignment.valid_to > v_action.effective_at)
       and (
         p_action_type = 'append_ml_metric_event'
         or assignment.role_id = 'technical_authority'
       )
  ) then
    raise exception 'ML action role is not authorized for % in the owning organization',
      p_action_type using errcode = 'insufficient_privilege';
  end if;
  return v_action_id;
end
$function$;

CREATE OR REPLACE FUNCTION ml.authorize_promotion_decision_action(p_decision_object_id uuid)
 RETURNS TABLE(decision_object_id uuid, approval_id uuid, evidence_ref_id uuid, decision_claim_sha256 text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'org', 'registry', 'ml', 'public'
AS $function$
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
       and action.xmin = pg_current_xact_id()::xid
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
          and object.xmin = pg_current_xact_id()::xid
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
$function$;


-- The fourth site, from 20260815000200. It was missed by a sweep run against a dev
-- database four migrations behind; the fresh-install contract test below caught it,
-- which is the argument for asserting the property rather than the three known names.
create or replace function ml.require_exact_registry_action(
  p_action_type text,
  p_organization_id uuid,
  p_parameters jsonb
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, org, registry, ml
as $$
declare
  v_actor uuid := core.current_actor();
  v_action_id uuid := core.current_action_id();
  v_role_setting text := nullif(current_setting('kf.acting_role', true), '');
  v_request_id text := nullif(current_setting('kf.request_id', true), '');
  v_role_id uuid;
  v_action core.action%rowtype;
begin
  if p_action_type not in (
    'register_ml_aggregate_reference', 'register_ml_run_lineage',
    'register_ml_metric_definition', 'register_ml_metric_segment'
  ) then
    raise exception 'ML action % has no registry-registration policy', p_action_type
      using errcode = 'insufficient_privilege';
  end if;
  if v_action_id is null or v_role_setting is null then
    raise exception 'ML registry write requires exact open typed-action context'
      using errcode = 'insufficient_privilege';
  end if;
  begin
    v_role_id := v_role_setting::uuid;
  exception when invalid_text_representation then
    raise exception 'ML registry write has an invalid acting-role context'
      using errcode = 'insufficient_privilege';
  end;
  select action.* into v_action from core.action action where action.id = v_action_id;
  if not found
     or v_action.action_type is distinct from p_action_type
     or v_action.result_status is distinct from 'applied'
     or v_action.actor_id is distinct from v_actor
     or v_action.acting_role_id is distinct from v_role_id
     or v_action.request_id is distinct from v_request_id
     or v_action.target_ids is distinct from array[p_organization_id]::uuid[]
     or v_action.parameters is distinct from p_parameters then
    raise exception 'ML registry write context does not match its exact recorded action semantics'
      using errcode = 'integrity_constraint_violation';
  end if;
  if not exists (
    select 1 from core.action action
     where action.id = v_action_id
       and action.xmin = pg_current_xact_id()::xid
  ) or exists (select 1 from core.audit_event event where event.action_id = v_action_id) then
    raise exception 'ML registry action must run before audit in its creating transaction'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if core.current_organization() is distinct from p_organization_id or not exists (
    select 1 from core.object object
     where object.id = p_organization_id
       and object.object_type = 'organization'
       and object.organization_id = p_organization_id
       and (select classification.rank from registry.classification classification
             where classification.id = object.classification)
           <= core.current_classification_rank()
  ) then
    raise exception 'ML target organization does not exist or is not visible'
      using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from org.role_assignment assignment
    join core.object assignment_object on assignment_object.id = assignment.id
    join core.object person_object on person_object.id = assignment.subject_id
     where assignment.id = v_role_id
       and assignment.subject_id = v_actor
       and assignment.scope_id = p_organization_id
       and assignment.role_id in ('performer', 'technical_authority')
       and assignment.valid_from <= v_action.effective_at
       and (assignment.valid_to is null or assignment.valid_to > v_action.effective_at)
       and assignment_object.lifecycle_state = 'active'
       and person_object.lifecycle_state = 'active'
  ) then
    raise exception 'ML registry action requires an active performer or technical authority'
      using errcode = 'insufficient_privilege';
  end if;
  return v_action_id;
end
$$;

-- migrate:down

-- Forward-only. Reverting would restore a comparison that stops working after the first
-- transaction-id wraparound.
