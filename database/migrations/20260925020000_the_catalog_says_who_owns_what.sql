-- migrate:up

-- The catalog states what the SAS states (KF-SAS-RQ-071, RQ-074, RQ-077).
--
-- 1. EVERY SCHEMA NAMES ITS AUTHORITY DOMAIN. §36 calls the schemas authority boundaries, not
--    folders, and gives a table of what each owns. Four schemas carried a comment saying so
--    (registry, core, search, ml); ten carried none, so "which system may write this" was
--    answerable from the SAS and not from the database a reader was connected to. Each comment
--    below opens with the owning domain in §36's words. `tests/database/catalog-authority.test.ts`
--    holds the schema set to §36's table, so a schema added without a row there — or without a
--    comment here — fails.
--
-- 2. ROW SECURITY ON ml.run_lineage_{input,output,parent_model} IS DECLARED LITERALLY. It was
--    enabled inside a `format()` loop in 20260814000200, which the boundary registry's static
--    scan (§38, docs/architecture/master-record-boundary.json) cannot see: three tables under
--    row security that the registry did not know existed. Re-stating it as literal statements
--    changes nothing in the database — the tables already enable and force it — and makes the
--    static set equal the running one, which the same test asserts.
--
-- 3. A VERIFICATION IS APPEND-ONLY. core.object_verification records that somebody checked a
--    record (§48A). Its migration says "nothing here deletes" and grants the application only
--    select and insert — a privilege, which can be re-granted by accident, and which binds
--    nobody holding the owner. Every other event record in core carries the refuse_mutation
--    trigger alongside its privileges for exactly that reason (20260811000300: "a trigger has
--    to be dropped deliberately"). A withdrawn verification is another record, not an edit.

comment on schema registry is
  'Authority: the ontology, mirrored from the YAML sources under ontology/. Domain tables '
  'reference it, so an unknown state or action token fails a foreign key rather than an '
  'application check.';
comment on schema core is
  'Authority: object identity, typed relations, actions, approvals, snapshots, audit, outbox, '
  'verification, the context seal and attestations.';
comment on schema org is
  'Authority: people, organizations, engagements, roles, clearance and grants.';
comment on schema product is
  'Authority: products, configuration items and baselines.';
comment on schema work is
  'Authority: projects, work packages, work orders, execution and warrants.';
comment on schema engineering is
  'Authority: decisions, changes, requirements, risks and tests.';
comment on schema content is
  'Authority: artifacts, versions, locations, documents, publications and orphan collection.';
comment on schema finance is
  'Authority: invoices, payments and allocations.';
comment on schema quality is
  'Authority: controlled documents, CAPA, suppliers and training.';
comment on schema ops is
  'Authority: backup runs and copies, recovery objectives, restore drills and readiness '
  'evidence. Operational facts about the installation, not governed records.';
comment on schema search is
  'Derived, not an authority: a disposable index. Nothing here is a source of truth; '
  'search.rebuild() reconstructs every row from core.object and the typed tables.';
comment on schema retrieval is
  'Derived, not an authority: the retrieval index''s band version (§64A). Band membership is '
  're-derived from core.object on every mask build; the version only says when to re-derive.';
comment on schema ml is
  'Authority: append-only privacy-minimal ML lineage, typed metrics, run seals and signed '
  'promotions.';
comment on schema secure_object is
  'Authority: secure-object capabilities, authority keys and erasure.';

alter table ml.run_lineage_input enable row level security;
alter table ml.run_lineage_input force row level security;
alter table ml.run_lineage_output enable row level security;
alter table ml.run_lineage_output force row level security;
alter table ml.run_lineage_parent_model enable row level security;
alter table ml.run_lineage_parent_model force row level security;

create trigger object_verification_append_only
  before update or delete or truncate on core.object_verification
  for each statement execute function core.refuse_mutation();

-- migrate:down

drop trigger if exists object_verification_append_only on core.object_verification;

-- The row-security statements are left as they are: the up section restated what
-- 20260814000200 had already done, so there is nothing of this migration's to undo, and
-- disabling it here would undo that migration's work instead.

comment on schema registry is
  'The ontology, mirrored from ontology/*.yaml. Domain tables reference it, so an unknown '
  'state or action token fails a foreign key rather than an application check.';
comment on schema core is
  'Object identity, typed relations, actions, approvals, snapshots, audit and outbox.';
comment on schema search is
  'Derived, disposable index. Nothing here is a source of truth; search.rebuild() reconstructs '
  'every row from core.object and the typed tables.';
comment on schema ml is
  'Append-only privacy-minimal ML lineage, typed metrics, run seals, and signed promotions.';
comment on schema org is null;
comment on schema product is null;
comment on schema work is null;
comment on schema engineering is null;
comment on schema content is null;
comment on schema finance is null;
comment on schema quality is null;
comment on schema ops is null;
comment on schema retrieval is null;
comment on schema secure_object is null;
