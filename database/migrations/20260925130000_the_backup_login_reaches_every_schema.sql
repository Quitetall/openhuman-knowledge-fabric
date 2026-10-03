-- migrate:up

-- A running host also has the separately worker-owned Graphile queue. The KF
-- migrator cannot grant another owner's sequences. Its owner commissions that
-- schema through the worker queue-backup CLI before this migration; verify the
-- read contract here, without taking ownership or silently omitting queue data.
do $$
declare
  v_schema oid;
begin
  select oid into v_schema from pg_namespace where nspname='graphile_worker';
  if v_schema is not null and (
    not has_schema_privilege('kf_backup',v_schema,'usage')
    or exists(select from pg_class c where c.relnamespace=v_schema
      and case when c.relkind='S' then not has_sequence_privilege('kf_backup',c.oid,'select')
        when c.relkind in ('r','p','v','m') then not has_table_privilege('kf_backup',c.oid,'select')
        else false end)
    or exists(select from pg_class c where c.relnamespace=v_schema
      and c.relkind in ('r','p') and c.relrowsecurity and not exists(
        select from pg_policy p where p.polrelid=c.oid and p.polpermissive
        and p.polcmd in ('r','*') and pg_get_expr(p.polqual,p.polrelid)='true'
        and 'kf_backup'::regrole=any(p.polroles)))
    or exists(select from pg_policy p join pg_class c on c.oid=p.polrelid
      where c.relnamespace=v_schema and p.polcmd in ('r','*') and not p.polpermissive
      and exists(select from unnest(p.polroles) role_id where
        case when role_id=0 then true else pg_has_role('kf_backup',role_id,'usage') end))
  ) then
    raise exception 'worker queue backup access must be provisioned by its owner';
  end if;
end $$;

-- The backup login reaches every table (KF-SAS-RQ-220, §88).
--
-- A deployed host runs scripts/backup.sh as a login holding kf_backup and nothing else
-- (provision-host.sh). pg_dump takes ACCESS SHARE on every table whose definition it dumps, in one
-- LOCK statement, and that needs SELECT or MAINTAIN. kf_backup had no USAGE on `search` or `retrieval`, which
-- were created after the grant that covered the first nine schemas, and no SELECT on thirteen
-- tables added since — so as that login the dump failed on its first statement, on every deployed
-- backup, while the restore drill, which ran the same script as the superuser, passed.
-- tests/backup-restore/drill.test.ts now runs the whole script as a kf_backup login and asserts
-- that no table is out of its reach.
--
-- A dump taken by a login row security binds reads rows only through policies, and pg_dump by
-- default refuses such a table outright (it runs with row_security off, so any applicable policy
-- is an error). The existing `*_backup_read` policies show the intended design: backup.sh now
-- passes `--enable-row-security`, and every table whose rows are dumped carries a policy letting
-- kf_backup read ALL of it. Seventeen did not — core.object, core.relation and core.audit_event
-- among them — so a dump or export taken as kf_backup would have held no records at all, which
-- is worse than failing. The drill test asserts, for every table with row security whose rows
-- backup.sh does not exclude, that such a policy exists and no restrictive policy narrows it,
-- and that the export taken as kf_backup holds every object.
--
-- What the dump holds, table by table, is a decision rather than whatever a grant allows:
--
--   AUTHORITATIVE or OPERATIONAL, rows included: core.object, core.relation, core.audit_event,
--     core.audit_chain_head (a restore without it cannot append), core.object_verification,
--     core.write_guard_exemption, core.migration030_rollback_state, ops.recovery_objective,
--     registry.identifier_namespace, the content, ml and org tables listed below, and the two
--     compiler leases. Each was in every superuser dump the drill restored; this keeps it there.
--
--   DERIVED, rows included: search.document, retrieval.band_version, retrieval.embed_pending.
--     Rebuildable, so excluding them would be permitted (§88) — but nothing in the restore path
--     rebuilds them (restore-verify.sh restores and verifies; it does not re-index), and a
--     restored host with an empty search index answers every query "no matches" rather than
--     failing. Included, a restore is usable as restored.
--
--   TRANSIENT, definitions included and rows EXCLUDED by `--exclude-table-data` in backup.sh:
--     search.recorded_query, search.demand_contribution, search.asker_key, retrieval.disclosure
--     (§64B), and core.principal_attestation, whose rows are sixty-second proofs a restored host
--     must never honour. kf_backup gets MAINTAIN, which is enough to take the lock (PostgreSQL 17+)
--     and reads nothing — not SELECT, which on core.principal_attestation, a table without row
--     security, would have handed the backup login every live attestation digest. Were an
--     exclusion ever dropped from the script, pg_dump would fail on the table with "permission
--     denied" instead of quietly keeping a query log past its window.

grant usage on schema search, retrieval to kf_backup;

do $$
declare
  v_table text;
  v_policy text;
begin
  foreach v_table in array array[
    'core.audit_chain_head', 'core.object_verification', 'core.write_guard_exemption',
    'core.migration030_rollback_state', 'ops.recovery_objective',
    'registry.identifier_namespace', 'content.compiler_runtime_lease',
    'content.document_basis_classifier_lease',
    'search.document', 'retrieval.band_version', 'retrieval.embed_pending',
    'core.object', 'core.relation', 'core.audit_event',
    'content.compilation_run_preimage', 'content.document_atom', 'content.document_parse',
    'content.person_entitlement_exclusion',
    'ml.metric_definition', 'ml.metric_event', 'ml.metric_segment', 'ml.run_lineage',
    'ml.run_lineage_input', 'ml.run_lineage_output', 'ml.run_lineage_parent_model', 'ml.run_seal',
    'org.person_clearance', 'org.person_clearance_retirement'
  ] loop
    execute format('grant select on %s to kf_backup', v_table);
    if (select c.relrowsecurity from pg_class c where c.oid = v_table::regclass) then
      v_policy := split_part(v_table, '.', 2) || '_backup_read';
      if not exists (select 1 from pg_policy p
                      where p.polrelid = v_table::regclass and p.polname = v_policy) then
        execute format('create policy %I on %s for select to kf_backup using (true)',
                       v_policy, v_table);
      end if;
    end if;
  end loop;
end
$$;

grant maintain on search.recorded_query, search.demand_contribution, search.asker_key,
  retrieval.disclosure, core.principal_attestation to kf_backup;

-- The seal key was granted SELECT for the same lock (20260923000100: "locking needs SELECT"),
-- which on PostgreSQL 17+ it does not. MAINTAIN takes the lock; the backup login no longer reads
-- the key whose row backup.sh already leaves out.
revoke select on core.context_seal_key from kf_backup;
grant maintain on core.context_seal_key to kf_backup;

-- pg_dump reads every sequence's state (`last_value`) to restore it, which needs SELECT; the
-- audit sequence alone stopped the dump once the tables were reachable. Every schema's, by the
-- same test, so an identity column added later is caught there rather than on a host.
do $$
declare
  v_schema name;
begin
  for v_schema in
    select n.nspname from pg_namespace n
     where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
       and n.nspname <> 'public'
       and n.nspname <> 'graphile_worker'
       and exists (select 1 from pg_class c where c.relnamespace = n.oid and c.relkind = 'S')
  loop
    execute format('grant select on all sequences in schema %I to kf_backup', v_schema);
  end loop;
end
$$;

-- migrate:down

revoke maintain on core.context_seal_key from kf_backup;
grant select on core.context_seal_key to kf_backup;

revoke maintain on search.recorded_query, search.demand_contribution, search.asker_key,
  retrieval.disclosure, core.principal_attestation from kf_backup;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'core.audit_chain_head', 'core.object_verification', 'core.write_guard_exemption',
    'core.migration030_rollback_state', 'ops.recovery_objective',
    'registry.identifier_namespace', 'content.compiler_runtime_lease',
    'content.document_basis_classifier_lease',
    'search.document', 'retrieval.band_version', 'retrieval.embed_pending',
    'core.object', 'core.relation', 'core.audit_event',
    'content.compilation_run_preimage', 'content.document_atom', 'content.document_parse',
    'content.person_entitlement_exclusion',
    'ml.metric_definition', 'ml.metric_event', 'ml.metric_segment', 'ml.run_lineage',
    'ml.run_lineage_input', 'ml.run_lineage_output', 'ml.run_lineage_parent_model', 'ml.run_seal',
    'org.person_clearance', 'org.person_clearance_retirement'
  ] loop
    execute format('drop policy if exists %I on %s',
                   split_part(v_table, '.', 2) || '_backup_read', v_table);
    execute format('revoke select on %s from kf_backup', v_table);
  end loop;
end
$$;

revoke usage on schema search, retrieval from kf_backup;
