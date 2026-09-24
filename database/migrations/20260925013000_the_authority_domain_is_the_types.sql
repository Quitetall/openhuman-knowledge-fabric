-- migrate:up

-- A record's authority domain is its type's, not its writer's (KF-SAS-RQ-001, RQ-010).
--
-- `core.object.authority_domain` names the canonical owner of the class of facts a record belongs
-- to ("one fact, one domain", ontology/meta.yaml). The ontology fixes it per object type —
-- `registry.object_type.authority_domain` — and until now nothing held a record to it: the column
-- was whatever string the inserting code supplied. A CAPA could be filed under `finance`, and a
-- test fixture routinely filed controlled documents under `quality`, a domain that does not exist.
--
-- The composite key makes the pair structural: `(object_type, authority_domain)` on every record
-- must be a pair the registry declares. `registry.object_type (id, authority_domain)` is unique
-- because `id` is; the constraint exists so the key can reference it.
--
-- THE CODE WAS WRONG TOO, which is why the key is added NOT VALID. Five materializers filed
-- records under a domain the ontology does not give their type — work orders, work executions,
-- acceptance records and work-order amendments under `project` (declared `commercial`), change
-- records under `engineering` (declared `configuration`) — so a database that has run those acts
-- holds rows the key would refuse, and a migration that refused them would stop a deploy on data
-- nobody chose. The code is corrected in the same change. The key then holds for every row
-- written or re-keyed from now on, and is VALIDATED here when no existing row breaks it, which is
-- every fresh database. Where rows do, the migration says how many and leaves the key
-- unvalidated; the runbook ("A migration refuses or warns …") finds them, and
-- `alter table core.object validate constraint object_authority_domain_is_the_types` finishes
-- the job once they are corrected by a recorded act. The declared domain is the answer: the
-- recorded one was a copy of the type's, made wrongly.
--
-- The ontology seed upserts `registry.object_type`. Moving a type to another domain while records
-- of that type exist is now refused by the key, which is the right answer: re-homing a class of
-- facts is a records decision, not a seed side effect.

alter table registry.object_type
  add constraint object_type_id_authority_domain_key unique (id, authority_domain);

alter table core.object
  add constraint object_authority_domain_is_the_types
  foreign key (object_type, authority_domain)
  references registry.object_type (id, authority_domain)
  not valid;

do $$
declare
  v_mislabelled bigint;
begin
  select count(*) into v_mislabelled
    from core.object o
    join registry.object_type t on t.id = o.object_type
   where o.authority_domain is distinct from t.authority_domain;
  if v_mislabelled = 0 then
    alter table core.object validate constraint object_authority_domain_is_the_types;
  else
    raise warning '% record(s) carry an authority domain their type does not declare; '
                  'object_authority_domain_is_the_types holds for new rows and stays unvalidated '
                  'until they are corrected (runbook: "A migration refuses or warns")', v_mislabelled;
  end if;
end
$$;

-- migrate:down

alter table core.object drop constraint object_authority_domain_is_the_types;
alter table registry.object_type drop constraint object_type_id_authority_domain_key;
