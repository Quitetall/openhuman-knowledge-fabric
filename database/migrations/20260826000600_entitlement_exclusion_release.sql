-- migrate:up

-- OW-WAR-0054 OBL-011. Exclusions are default-open and subtractive. Releasing one is a
-- one-time, append-only state transition carried by a named action; callers cannot rewrite
-- the original reason, authorizer, or creation evidence.
alter table content.person_entitlement_exclusion
  add constraint person_entitlement_exclusion_release_pair check (
    (released_at is null and released_by_action is null)
    or (released_at is not null and released_by_action is not null)
  );

create or replace function content.enforce_entitlement_exclusion_release()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_action_id uuid := core.current_action_id();
  v_action core.action%rowtype;
begin
  if tg_op <> 'UPDATE'
     or old.released_at is not null
     or old.released_by_action is not null
     or new.released_at is null
     or new.released_by_action is null
     or (to_jsonb(new) - 'released_at' - 'released_by_action')
          is distinct from (to_jsonb(old) - 'released_at' - 'released_by_action') then
    raise exception 'person entitlement exclusions are append-only; release is the only permitted update'
      using errcode = 'insufficient_privilege';
  end if;
  if v_action_id is null then
    raise exception 'entitlement exclusion release requires an action context'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_action from core.action where id = v_action_id;
  if v_action.id is null
     or v_action.action_type <> 'release_person_entitlement_exclusion'
     or cardinality(v_action.target_ids) <> 1
     or v_action.target_ids[1] is distinct from old.object_id
     or v_action.parameters ->> 'exclusion_id' is distinct from old.id::text
     or v_action.actor_id is distinct from core.current_actor()
     or v_action.organization_id is distinct from old.organization_id
     or new.released_by_action is distinct from v_action.id
     or new.released_at is distinct from v_action.effective_at then
    raise exception 'entitlement exclusion release does not match its recorded action'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger person_entitlement_exclusion_release_guard
  before update on content.person_entitlement_exclusion
  for each row execute function content.enforce_entitlement_exclusion_release();

-- SECURITY DEFINER is narrow: it is callable only by the typed action effect and validates the
-- action's target, parameters, actor, organization and server-assigned effective time itself.
create or replace function content.release_person_entitlement_exclusion(p_exclusion_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_exclusion content.person_entitlement_exclusion%rowtype;
  v_action core.action%rowtype;
begin
  select * into v_exclusion
    from content.person_entitlement_exclusion
   where id = p_exclusion_id
   for update;
  if not found then
    raise exception 'person entitlement exclusion does not exist'
      using errcode = 'foreign_key_violation';
  end if;
  if v_exclusion.released_at is not null or v_exclusion.released_by_action is not null then
    raise exception 'person entitlement exclusion is already released'
      using errcode = 'integrity_constraint_violation';
  end if;

  select * into v_action from core.action where id = core.current_action_id();
  if v_action.id is null
     or v_action.action_type <> 'release_person_entitlement_exclusion'
     or cardinality(v_action.target_ids) <> 1
     or v_action.target_ids[1] is distinct from v_exclusion.object_id
     or v_action.parameters ->> 'exclusion_id' is distinct from p_exclusion_id::text
     or v_action.actor_id is distinct from core.current_actor()
     or v_action.organization_id is distinct from v_exclusion.organization_id then
    raise exception 'entitlement exclusion release does not match its recorded action'
      using errcode = 'integrity_constraint_violation';
  end if;

  update content.person_entitlement_exclusion
     set released_at = v_action.effective_at,
         released_by_action = v_action.id
   where id = p_exclusion_id;
end
$$;

revoke all on function content.enforce_entitlement_exclusion_release() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;
revoke all on function content.release_person_entitlement_exclusion(uuid) from public;
grant execute on function content.release_person_entitlement_exclusion(uuid) to kf_app;

comment on table content.person_entitlement_exclusion is
  'Subtractive entitlement. Empty rows mean every permission-set member remains visible; '
  'release is one append-only action-bound transition.';

-- migrate:down
-- kf:forward-only releasing an exclusion is audited evidence; removing its guard would allow silent re-withholding
