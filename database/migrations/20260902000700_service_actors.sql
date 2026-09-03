-- migrate:up

-- ADR 0020. Scheduled work — replicating artifact copies, re-verifying them — is a set of
-- typed actions, and a typed action needs an actor who holds a role. Until now the only
-- actors were humans with logins, so a timer had two bad choices: act as a human at 03:00
-- every night, or bypass the dispatcher. A SERVICE PERSON is the third: a person of kind
-- `service`, declared by an operator, holding an organization-scoped role like any other
-- principal, and never linkable to a login. Every copy and every verification is then an
-- audited act by a named principal that a reader can tell from a human.

alter table org.person
  add column person_kind text not null default 'human'
    check (person_kind in ('human', 'service'));

comment on column org.person.person_kind is
  'ADR 0020: `service` is a declared automation principal. It holds roles like anyone; it can never hold a login.';

-- A service person is not a login. The link table is where a login becomes a person, so the
-- refusal lives there: whatever path tries to link one is refused by the database.
create or replace function org.external_identity_human_only() returns trigger
language plpgsql
set search_path = pg_catalog, org
as $$
declare
  v_kind text;
begin
  select p.person_kind into v_kind from org.person p where p.id = new.person_id;
  if v_kind = 'service' then
    raise exception 'person % is a service actor and cannot be linked to a login (ADR 0020)',
      new.person_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger external_identity_human_only
  before insert or update on org.external_identity
  for each row execute function org.external_identity_human_only();

-- migrate:down

drop trigger external_identity_human_only on org.external_identity;
drop function org.external_identity_human_only();
alter table org.person drop column person_kind;
