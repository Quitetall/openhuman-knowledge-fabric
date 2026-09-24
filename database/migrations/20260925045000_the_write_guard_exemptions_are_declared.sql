-- migrate:up

-- The row-security reconciliation (20260925040000) and the act write guard (20260925011000) were
-- built on sibling branches, so the guard's own configuration table, core.write_guard_exemption,
-- carries no row security and was declared nowhere: readiness named it. It is schema
-- configuration — which tables are exempt from the act requirement, and why — written only by
-- migrations and holding no record content, so it joins the declared list rather than gaining
-- policies nothing would ever evaluate.

create or replace function core.readiness_row_security_exemptions()
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
    ('public.schema_migrations', 'dbmate bookkeeping'),
    -- Which writes the act guard exempts, and why (20260925011000). Schema configuration written
    -- only by migrations; it names tables, not records, and belongs to no organization.
    ('core.write_guard_exemption', 'write-guard configuration; written only by migrations')
$$;

-- migrate:down

create or replace function core.readiness_row_security_exemptions()
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
