-- migrate:up

-- What a person IS — human or service, and which organization they belong to — is written by the
-- owner credential and by nothing that runs as the application (KF-SAS-RQ-035, RQ-046, RQ-236).
--
-- 20260923000200 took INSERT on `org.person` from `kf_app` and left the table-level UPDATE that
-- `20260811000700_org.sql` granted with it. No trigger guarded the row, so a compromised API
-- holding a bound principal could rewrite `person_kind` on any person its organization could see:
--
--   * relabel the storage steward `human`, and the service-actor bar on institutional acts
--     (`core.action_requires_act_authority`, 20260924000100) no longer recognises it;
--   * relabel a human `service`, and the storage sweep's login (`kf_service_actor`, which binds
--     service persons WITHOUT an attestation, 20260924001000) may bind that human with no token;
--   * move a person to another `organization`, which the identity resolver and the attestor read.
--
-- The application never updates a person. `grep -rn 'update org.person ' packages apps` finds
-- nothing but `org.person_clearance`; people are created and relabelled by `kf:grant-authority`
-- and `kf:declare-service-actor`, on the owner connection. So the application keeps NO column:
-- a later feature that needs to edit a display name grants that one column, by name, in its own
-- migration.
--
-- The trigger is the second line, for whichever role is granted a column later: outside an
-- ADMINISTRATOR session (`core.session_is_administrator`, as everywhere since 20260923000200)
-- nobody creates a person, and nobody changes a person's id, kind or organization.

revoke update on org.person from kf_app;

create function org.person_identity_is_the_owners() returns trigger
language plpgsql
set search_path = pg_catalog, core
as $$
begin
  if core.session_is_administrator() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'a person is created by the owner credential (kf:grant-authority, kf:declare-service-actor), not by %',
      session_user
      using errcode = 'insufficient_privilege';
  end if;
  if new.id is distinct from old.id
     or new.person_kind is distinct from old.person_kind
     or new.organization is distinct from old.organization then
    raise exception 'person %: kind and organization are the owner credential''s to change', old.id
      using errcode = 'insufficient_privilege',
            hint = 'A service actor relabelled human escapes the act bar; a human relabelled service '
                   || 'is bound without an attestation. Neither is an application edit.';
  end if;
  return new;
end
$$;

revoke all on function org.person_identity_is_the_owners() from public;
grant execute on function org.person_identity_is_the_owners() to kf_app, kf_worker;

create trigger person_identity_is_the_owners
  before insert or update on org.person
  for each row execute function org.person_identity_is_the_owners();

-- migrate:down

-- Reversible, as 20260924000100 is: no release before this one updates a person, so rolling
-- back past it costs nothing but re-opening exactly the gap described above.
drop trigger person_identity_is_the_owners on org.person;
drop function org.person_identity_is_the_owners();
grant update on org.person to kf_app;
