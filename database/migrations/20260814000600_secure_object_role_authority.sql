-- migrate:up

-- Secure-object actions carry organization scope, exact semantic parameters and one live
-- role assignment. Role ownership alone is insufficient: each authority surface also
-- requires its narrow human authority category.
create or replace function secure_object.require_exact_action(
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
$$;

revoke execute on function secure_object.require_exact_action(text, uuid, jsonb) from public;
grant execute on function secure_object.require_exact_action(text, uuid, jsonb) to kf_app;

-- migrate:down

create or replace function secure_object.require_exact_action(
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
grant execute on function secure_object.require_exact_action(text, uuid, jsonb) to kf_app;
