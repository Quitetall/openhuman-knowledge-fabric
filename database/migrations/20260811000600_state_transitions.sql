-- migrate:up

-- Lifecycle transitions.
--
-- The registry held states but not the moves between them, which left the dispatcher with
-- no database-side source for "may this action take this object from here to there". A
-- transition table closes that: the permitted moves are seeded from the ontology, so an
-- action's authority is whatever the reviewed ontology says and never a constant in code.

create table registry.state_transition (
  object_type text not null references registry.state_machine (id) on delete cascade,
  from_state  text not null,
  to_state    text not null,
  action_id   text not null references registry.action_type (id),
  primary key (object_type, from_state, to_state, action_id),

  -- Both endpoints must be states the machine actually declares.
  constraint state_transition_from_defined
    foreign key (object_type, from_state) references registry.object_state (object_type, state),
  constraint state_transition_to_defined
    foreign key (object_type, to_state) references registry.object_state (object_type, state),

  -- A transition to itself is not a lifecycle move; it is an update pretending to be one.
  constraint state_transition_not_self check (from_state <> to_state)
);

create index state_transition_by_action on registry.state_transition (action_id);
create index state_transition_by_source on registry.state_transition (object_type, from_state);

grant select on registry.state_transition
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor;

-- Terminal means terminal. This is R01-DEFECT-003 and -005 made structurally impossible:
-- the database will not store a transition that leaves a state declared terminal, so the
-- contradiction the R01 draft carried cannot be reintroduced by a future seed.
create or replace function registry.refuse_transition_from_terminal() returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from registry.object_state
     where object_type = new.object_type and state = new.from_state and is_terminal
  ) then
    raise exception
      'transition %.% -> % leaves a terminal state', new.object_type, new.from_state, new.to_state
      using errcode = 'check_violation',
            hint = 'Either the state is not terminal, or the transition should not exist.';
  end if;
  return new;
end
$$;

create trigger state_transition_not_from_terminal
  before insert or update on registry.state_transition
  for each row execute function registry.refuse_transition_from_terminal();

comment on table registry.state_transition is
  'Permitted lifecycle moves, seeded from ontology/state-machines.yaml. The dispatcher '
  'reads these; an action cannot move an object along a path the ontology does not define.';
comment on trigger state_transition_not_from_terminal on registry.state_transition is
  'Refuses a transition out of a terminal state — the contradiction R01-DEFECT-003 and -005 '
  'carried, now structurally unreachable.';

-- migrate:down

drop trigger if exists state_transition_not_from_terminal on registry.state_transition;
drop function if exists registry.refuse_transition_from_terminal();
drop table if exists registry.state_transition;
