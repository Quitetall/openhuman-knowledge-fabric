-- migrate:up

-- An edge may connect only the object types its relation declares (SAS §100.2, KF-SAS-RQ-070).
--
-- R01 declared no source or target types, so nothing constrained which objects a relation could
-- connect: `settles` from a risk to a supplier was as storable as `settles` from a payment to an
-- invoice. The compiler counted the gap on every run (ONT-012, a warning ×82) and nothing below it
-- noticed. The ontology now declares both ends of every relation, the seed mirrors them into
-- `registry.relation_type_endpoint`, and this trigger refuses an edge whose source or target type
-- is not declared for its end.
--
-- The ontology remains the authority, as for every registry table: an undeclared pair fails
-- against seeded data, not against a list written into this migration. A relation type with no
-- rows for an end admits nothing at that end — fail-closed, and the compiler refuses a relation
-- that omits either end (ONT-012 is an error from draft.8).
--
-- SECURITY DEFINER to read the two objects' types: the endpoint rule is structural, and a writer
-- who cannot see the target must still be refused an edge of the wrong shape rather than let
-- through by row security hiding the type. It reveals nothing a refusal does not: the message
-- names the relation and the two types, which the writer supplied or can see. A missing object
-- or an undeclared relation type is left to the foreign keys, which already refuse them.
--
-- Administrator sessions are NOT exempt. A restore or a bootstrap that writes an edge of the
-- wrong shape is writing a corrupt graph, and the owner credential should be refused it too.

create table registry.relation_type_endpoint (
  relation_type text not null references registry.relation_type (id) on delete cascade,
  endpoint      text not null check (endpoint in ('source', 'target')),
  object_type   text not null references registry.object_type (id) on delete cascade,
  primary key (relation_type, endpoint, object_type)
);

comment on table registry.relation_type_endpoint is
  'Which object types may sit at each end of each relation type. Seeded from '
  'ontology/relation-types.yaml source_types/target_types; core.relation refuses any other pair.';

-- Ontology reference data, like every registry.* table: no row security, written only by the seed,
-- and declared to the row-security reconciliation (20260925045000) with that reason.
grant select on registry.relation_type_endpoint
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create function core.relation_endpoint_declared() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, registry
as $$
declare
  v_source text;
  v_target text;
begin
  select object_type into v_source from core.object where id = new.source_id;
  select object_type into v_target from core.object where id = new.target_id;
  -- A missing object, or a relation type the registry does not declare, is the foreign keys'
  -- to refuse (KF-GRAPH-001, KF-SAS-RQ-070), with their own words; this guard judges only the
  -- shape of an edge between things that exist.
  if v_source is null or v_target is null
     or not exists (select 1 from registry.relation_type where id = new.relation_type) then
    return new;
  end if;
  if not exists (select 1 from registry.relation_type_endpoint
                  where relation_type = new.relation_type and endpoint = 'source'
                    and object_type = v_source) then
    raise exception '% may not start at a %', new.relation_type, v_source
      using errcode = 'check_violation',
            hint = 'relation-types.yaml declares which types may sit at each end of a relation.';
  end if;
  if not exists (select 1 from registry.relation_type_endpoint
                  where relation_type = new.relation_type and endpoint = 'target'
                    and object_type = v_target) then
    raise exception '% may not end at a %', new.relation_type, v_target
      using errcode = 'check_violation',
            hint = 'relation-types.yaml declares which types may sit at each end of a relation.';
  end if;
  return new;
end
$$;

revoke all on function core.relation_endpoint_declared() from public;

-- Sorts after relation_guard_1_context, so a context-free write is refused for that first.
create trigger relation_guard_2_endpoint
  before insert or update of relation_type, source_id, target_id on core.relation
  for each row execute function core.relation_endpoint_declared();

-- migrate:down

drop trigger relation_guard_2_endpoint on core.relation;
drop function core.relation_endpoint_declared();
drop table registry.relation_type_endpoint;
