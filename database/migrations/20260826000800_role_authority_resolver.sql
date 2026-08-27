-- migrate:up

-- OW-WAR-0054 OBL-010. Role ownership is an authority fact, not a classified record. The
-- dispatcher must be able to reject an invalid assignment before resolving and binding the
-- caller's requested reader ceiling, so this helper cannot depend on caller RLS context.
create or replace function org.holds_role(p_person uuid, p_role_assignment uuid) returns boolean
language sql stable
security definer
set search_path = pg_catalog, org
as $$
  select exists (
    select 1 from org.role_assignment
     where id = p_role_assignment
       and subject_id = p_person
       and valid_from <= now()
       and (valid_to is null or valid_to > now())
  )
$$;

revoke all on function org.holds_role(uuid, uuid) from public;
grant execute on function org.holds_role(uuid, uuid) to kf_app, kf_worker;

-- migrate:down
-- kf:forward-only classification-independent role authority is required by OBL-010
