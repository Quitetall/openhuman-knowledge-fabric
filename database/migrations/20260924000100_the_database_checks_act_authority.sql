-- migrate:up

-- Which acts a principal may perform is decided in the database too, not only in the dispatcher.
--
-- ADR 0016: an action type that declares `requires: act` (`registry.action_type
-- .requires_capability = 'act'`) is an institutional act — authorizing, approving, accepting,
-- issuing, making effective — and needs a live `act` grant reaching every target, or the
-- organization. ADR 0020: a service actor never performs one, whatever grants reach it. Until now
-- both were checked only by `assertActCovered` in `packages/actions`. 20260923000200 made an
-- action row name the sealed principal, so a compromised API can no longer credit an act to
-- somebody else; it could still write a row crediting an act to the principal it bound, for an
-- act that principal has no authority to perform, and the database recorded it. That is the
-- first "Not mitigated" bullet of threat model T2.
--
-- THE SAME DECISION, NOT A SECOND ONE. The trigger below asks exactly what the dispatcher asks,
-- in the same order, through the same function (`org.act_grant_reaches`) and under the same
-- bound context: it runs as the invoker, so row-level security on every grant source applies
-- to it as it does to the dispatcher's call a moment earlier. A second implementation of
-- coverage would be a second answer that could disagree with the first; this cannot. The
-- targets are the row's own `target_ids`, which the dispatcher writes from the same list it
-- checked (`state.targetIds`, created objects included).
--
-- The dispatcher's check stays. It runs first and refuses with `act_not_granted` and a message
-- a person can act on; this one is for a caller that did not go through it.
--
-- ADMINISTRATOR sessions are exempt, as everywhere in 20260923000200: bootstrap, grant-authority
-- and fixtures write through the owner credential, which could rewrite the ledger anyway.

create function core.action_requires_act_authority() returns trigger
language plpgsql
set search_path = pg_catalog, core, org, registry
as $$
declare
  v_requires text;
  v_kind     text;
begin
  if core.session_is_administrator() then
    return new;
  end if;

  select requires_capability into v_requires
    from registry.action_type where id = new.action_type;
  if v_requires is distinct from 'act' then
    return new;
  end if;

  select person_kind into v_kind from org.person where id = new.actor_id;
  if v_kind = 'service' then
    raise exception '% is an institutional act; a service actor cannot perform one (ADR 0020)',
      new.action_type
      using errcode = 'insufficient_privilege';
  end if;

  if not org.act_grant_reaches(new.actor_id, new.organization_id, new.target_ids) then
    raise exception '% requires act authority at the target''s scope, and no live act grant reaches this actor there',
      new.action_type
      using errcode = 'insufficient_privilege',
            hint = 'The dispatcher refuses this first as act_not_granted; a refusal here means '
                   || 'the row did not come through it.';
  end if;
  return new;
end
$$;

revoke all on function core.action_requires_act_authority() from public;
grant execute on function core.action_requires_act_authority() to kf_app;

create trigger action_requires_act_authority
  before insert on core.action
  for each row execute function core.action_requires_act_authority();

-- migrate:down

drop trigger action_requires_act_authority on core.action;
drop function core.action_requires_act_authority();
