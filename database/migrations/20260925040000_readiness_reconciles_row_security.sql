-- migrate:up

-- Readiness reconciles row-level security against what the migrations declare (KF-SAS-RQ-186).
--
-- 20260924000200 forced row security on every table that enabled it and said what was left
-- without it, and `tests/database/row-security-forced.test.ts` holds a test database to that.
-- Nothing held a RUNNING database to it. A table created by hand on a host, or an
-- `alter table … no force row level security` typed to make one query work, was invisible to
-- every check that runs where the data is. This is the check that runs there.
--
-- The exemption list lives here, in a migration, because "derivable from the migrations" is the
-- requirement: the set of tables that may carry no row security is declared by the same reviewed
-- sequence that creates them, and a change to it is a new migration that says why.

create function core.readiness_row_security_exemptions()
returns table (table_name text, reason text)
language sql
immutable
set search_path = pg_catalog
as $$
  values
    -- Reference data mirrored from the ontology. Read by everyone, written only by migrations and
    -- the seed; nothing in it belongs to an organization.
    ('registry.action_type', 'ontology reference data'),
    ('registry.classification', 'ontology reference data'),
    ('registry.identifier_namespace', 'deployment reference data (ADR 0006)'),
    ('registry.object_state', 'ontology reference data'),
    ('registry.object_type', 'ontology reference data'),
    ('registry.relation_type', 'ontology reference data'),
    ('registry.retention_class', 'ontology reference data'),
    ('registry.rule_definition', 'ontology reference data'),
    ('registry.schema_release', 'ontology reference data'),
    ('registry.state_machine', 'ontology reference data'),
    ('registry.state_transition', 'ontology reference data'),
    ('org.role', 'role vocabulary; assignments are governed, the vocabulary is not'),
    ('quality.federated_source', 'the list of federated systems; citations of them are governed'),
    -- Guarded by grants: no application login reads the rows, only a definer seam does.
    ('core.audit_chain_head', 'chain bookkeeping; kf_app reads the digest column only'),
    ('core.audit_checkpoint', 'signed checkpoints; read through core.readiness_checkpoint_coverage'),
    ('core.context_seal_key', 'seal key; no application grant'),
    ('core.principal_attestation', 'attestations; written and read only through definer seams'),
    ('core.migration030_rollback_state', 'migration bookkeeping'),
    ('content.compiler_runtime_lease', 'worker lease; no record content'),
    ('content.document_basis_classifier_lease', 'worker lease; no record content'),
    ('public.schema_migrations', 'dbmate bookkeeping')
$$;

comment on function core.readiness_row_security_exemptions() is
  'Tables declared to carry no row-level security, besides the whole ops schema. Replaced by a '
  'new migration, with its reason, when a table joins or leaves the list (KF-SAS-RQ-186).';

-- Definer, so the answer does not depend on which catalog rows the calling login can see.
create function core.readiness_unforced_row_security()
returns table (table_name text, problem text)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select format('%I.%I', n.nspname, c.relname) as table_name,
         case when c.relrowsecurity then 'enabled_not_forced'
              else 'undeclared_without_row_security' end as problem
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and n.nspname not in ('pg_catalog', 'information_schema')
     and n.nspname !~ '^pg_'
     and (
       (c.relrowsecurity and not c.relforcerowsecurity)
       or (
         not c.relrowsecurity
         -- ops.*: operational facts about the installation — backup runs, copies, drills, the
         -- recovery objective — naming no organization (20260924000200).
         and n.nspname <> 'ops'
         and format('%I.%I', n.nspname, c.relname) not in (
           select e.table_name from core.readiness_row_security_exemptions() e
         )
       )
     )
   order by 1
$$;

revoke all on function core.readiness_row_security_exemptions() from public;
revoke all on function core.readiness_unforced_row_security() from public;
grant execute on function core.readiness_row_security_exemptions() to kf_app, kf_worker;
grant execute on function core.readiness_unforced_row_security() to kf_app, kf_worker;

comment on function core.readiness_unforced_row_security() is
  'Every table whose row security differs from what the migrations declare: enabled but not '
  'forced, or absent and not exempt. Empty is the only ready answer (KF-SAS-RQ-186).';

-- migrate:down

drop function core.readiness_unforced_row_security();
drop function core.readiness_row_security_exemptions();
