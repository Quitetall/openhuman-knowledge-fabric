-- migrate:up

-- The quality schema, and the federation boundary.
--
-- `openhuman-quality` already owns the controlled documents, requirements, hazards, controls
-- and protocols. It has a registry, a fail-closed index tool, and reviewers who work in it.
-- Copying that content here would create a second authority, and the second one is always
-- the one that drifts — six months later two systems disagree about a hazard control and
-- nobody can say which is current.
--
-- So the Fabric holds IDENTITY, LOCATION and DIGEST. The document lives where it lives; what
-- is recorded here is enough to find it, cite it, and detect that it changed underneath us.

create table quality.federated_source (
  id            text primary key check (id ~ '^[a-z][a-z0-9-]{1,63}$'),
  description   text not null,
  -- Where the truth is. A git remote, a document system, an accounting package.
  repository    text not null,
  -- Whether this system may ever write there. Always false today, and a column rather than a
  -- convention so that changing it is a migration somebody reviews.
  writable      boolean not null default false,
  constraint federated_source_read_only check (writable = false)
);

insert into quality.federated_source (id, description, repository) values
  ('openhuman-quality',
   'The QMS: controlled documents, requirements, hazards, controls and protocols.',
   'openhuman-quality'),
  ('lamquant',
   'Engineering: architecture decision records, specifications, benchmarks.',
   'LamQuant');

-- A reference to something another system owns.
--
-- Pinned to a COMMIT, not a branch. A reference to `main` describes whatever that branch says
-- today, which means a decision citing it cites a moving target — and the audit question is
-- always "what did it say when we approved it".
create table quality.federated_reference (
  id            uuid primary key default uuidv7(),
  source_id     text not null references quality.federated_source (id) on delete restrict,
  -- The other system's identifier, in its own vocabulary: OH-DOC-SOP-QMS-001, ADR-0139.
  external_id   text not null check (length(btrim(external_id)) between 1 and 128),
  commit_sha    text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  path          text not null check (length(btrim(path)) between 1 and 512),
  -- SHA-256 of the referenced bytes AS WE SAW THEM. This is what makes drift detectable
  -- rather than merely possible to worry about.
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  title          text not null,
  -- When we last confirmed the digest still matched. Null means never re-checked since it
  -- was recorded, which is different from "checked and fine".
  verified_at    timestamptz,
  recorded_at    timestamptz not null default now(),
  recorded_by    uuid not null,

  -- One row per (source, external id, commit). The same document at two commits is two
  -- references, deliberately: that is how "it changed" is representable at all.
  unique (source_id, external_id, commit_sha)
);

create index federated_reference_by_external on quality.federated_reference (source_id, external_id);

-- What in the Fabric points at what over there. Separate from core.relation because the
-- target is not a row in this database and never will be.
create table quality.federated_link (
  id            uuid primary key default uuidv7(),
  object_id     uuid not null references core.object (id) on delete restrict,
  reference_id  uuid not null references quality.federated_reference (id) on delete restrict,
  link_kind     text not null check (link_kind in (
    'governed_by', 'satisfies', 'verifies', 'mitigates', 'implements', 'cites'
  )),
  created_at    timestamptz not null default now(),
  created_by    uuid not null,
  authorizing_action uuid references core.action (id),

  unique (object_id, reference_id, link_kind)
);

create index federated_link_by_object on quality.federated_link (object_id);

-- ── quality records the Fabric DOES own ────────────────────────────────────────────────

-- A controlled document held here, as opposed to one federated from the QMS. Both exist:
-- documents that govern Fabric-native work (a work instruction for recording an execution)
-- belong here; the QMS keeps its own.
create table quality.controlled_document (
  id              uuid primary key references core.object (id) on delete restrict,
  document_class  text not null check (document_class in (
    'policy', 'procedure', 'work_instruction', 'form', 'record', 'specification', 'plan', 'report'
  )),
  document_number text not null,
  revision        text not null,
  owning_role     text not null references org.role (id),
  effective_from  timestamptz,
  -- Where the content is. A controlled document with no content is a title.
  content_version uuid references content.artifact_version (id) on delete restrict,

  unique (document_number, revision)
);

create table quality.nonconformity (
  id           uuid primary key references core.object (id) on delete restrict,
  severity     text not null check (severity in ('minor', 'major', 'critical')),
  detected_on  timestamptz not null,
  description  text not null check (length(btrim(description)) between 1 and 8000),
  -- What was decided about the affected material. Null until dispositioned, which the
  -- lifecycle enforces separately.
  disposition  text check (disposition in (
    'use_as_is', 'rework', 'repair', 'scrap', 'return_to_supplier'
  )),
  -- What it was found against: a configuration item, a physical binding, a supplier.
  subject_id   uuid references core.object (id) on delete restrict,
  containment  text
);

create index nonconformity_by_subject on quality.nonconformity (subject_id);

create table quality.capa (
  id                      uuid primary key references core.object (id) on delete restrict,
  capa_kind               text not null check (capa_kind in ('corrective', 'preventive', 'both')),
  problem_statement       text not null check (length(btrim(problem_statement)) between 1 and 8000),
  root_cause              text,
  -- Agreed BEFORE the work starts. A CAPA whose effectiveness criterion is written at the
  -- end is a CAPA that always succeeds.
  effectiveness_criterion text not null check (length(btrim(effectiveness_criterion)) between 1 and 4000),
  effectiveness_evidence  text,
  closed_at               timestamptz
);

-- Which nonconformities a CAPA answers. Many to many: one CAPA usually addresses a pattern.
create table quality.capa_nonconformity (
  capa_id         uuid not null references quality.capa (id) on delete restrict,
  nonconformity_id uuid not null references quality.nonconformity (id) on delete restrict,
  primary key (capa_id, nonconformity_id)
);

create table quality.supplier (
  id              uuid primary key references core.object (id) on delete restrict,
  organization    uuid not null references org.organization (id) on delete restrict,
  criticality     text not null check (criticality in ('critical', 'significant', 'standard')),
  qualified_until date,
  scope_of_supply text not null,

  unique (organization)
);

create table quality.supplier_qualification (
  id            uuid primary key default uuidv7(),
  supplier_id   uuid not null references quality.supplier (id) on delete restrict,
  method        text not null check (method in (
    'audit', 'questionnaire', 'sample_evaluation', 'certification_review', 'history'
  )),
  performed_on  date not null,
  outcome       text not null check (outcome in ('qualified', 'conditional', 'rejected')),
  evidence_version uuid references content.artifact_version (id) on delete restrict,
  recorded_by   uuid not null,
  recorded_at   timestamptz not null default now()
);

create index supplier_qualification_by_supplier
  on quality.supplier_qualification (supplier_id, performed_on desc);

create table quality.equipment (
  id              uuid primary key references core.object (id) on delete restrict,
  asset_number    text not null unique,
  equipment_kind  text not null check (equipment_kind in (
    'measurement', 'production', 'test', 'environmental', 'computing'
  )),
  calibration_due date,
  location        text
);

create table quality.calibration (
  id            uuid primary key default uuidv7(),
  equipment_id  uuid not null references quality.equipment (id) on delete restrict,
  performed_on  date not null,
  due_on        date not null,
  outcome       text not null check (outcome in ('in_tolerance', 'out_of_tolerance', 'adjusted')),
  -- The standard it was calibrated against, and where that standard's traceability comes
  -- from. Calibration with no traceable reference is a measurement, not a calibration.
  reference_standard text not null,
  certificate_version uuid references content.artifact_version (id) on delete restrict,
  recorded_by   uuid not null,
  recorded_at   timestamptz not null default now(),

  constraint calibration_due_after_performed check (due_on >= performed_on)
);

create index calibration_by_equipment on quality.calibration (equipment_id, performed_on desc);

create table quality.complaint (
  id                      uuid primary key references core.object (id) on delete restrict,
  received_on             timestamptz not null,
  summary                 text not null check (length(btrim(summary)) between 1 and 8000),
  -- Deliberately NOT the complainant's name, contact details or any clinical detail. A
  -- complaint record is about the product; identifying a person here would put personal data
  -- into a system that has no lawful basis to hold it.
  reporter_reference      text,
  affected_binding        uuid references product.physical_binding (id) on delete restrict,
  -- A reportability decision is a DECISION, with its rationale, not a flag. "We concluded it
  -- was not reportable, and here is why" is the answer a regulator asks for, and a bare false
  -- cannot give it.
  reportable              boolean,
  reportability_rationale text,
  closed_at               timestamptz,

  constraint complaint_reportability_reasoned
    check (reportable is null or (reportability_rationale is not null
                                  and length(btrim(reportability_rationale)) > 0))
);

-- Which documents a role must be trained on. The pair IS the fact, so it is the key.
create table quality.training_requirement (
  role_id       text not null references org.role (id),
  document_id   uuid not null references quality.controlled_document (id) on delete restrict,
  primary key (role_id, document_id)
);

create table quality.training_record (
  id             uuid primary key default uuidv7(),
  person_id      uuid not null references org.person (id) on delete restrict,
  document_id    uuid not null references quality.controlled_document (id) on delete restrict,
  completed_on   date not null,
  -- Which revision they were trained on. Training on a superseded revision is not training
  -- on the current one, and a record without the revision cannot tell the difference.
  revision       text not null,
  recorded_by    uuid not null,
  recorded_at    timestamptz not null default now(),

  unique (person_id, document_id, revision)
);

create index training_record_by_person on quality.training_record (person_id);

grant select on all tables in schema quality
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on quality.federated_reference, quality.federated_link,
                quality.controlled_document, quality.nonconformity, quality.capa,
                quality.capa_nonconformity, quality.supplier, quality.supplier_qualification,
                quality.equipment, quality.calibration, quality.complaint,
                quality.training_requirement, quality.training_record
  to kf_app;
-- Re-verifying a federated digest records WHEN it was checked, and nothing else about the
-- reference may move: a changed commit or digest is a new reference.
grant update (verified_at) on quality.federated_reference to kf_app, kf_worker;
grant update (disposition, containment) on quality.nonconformity to kf_app;
grant update (root_cause, effectiveness_evidence, closed_at) on quality.capa to kf_app;
grant update (qualified_until) on quality.supplier to kf_app;
grant update (calibration_due, location) on quality.equipment to kf_app;
grant update (reportable, reportability_rationale, closed_at) on quality.complaint to kf_app;
grant update (effective_from, content_version) on quality.controlled_document to kf_app;
grant usage, select on all sequences in schema quality to kf_app, kf_worker;

-- migrate:down

drop table quality.training_record;
drop table quality.training_requirement;
drop table quality.complaint;
drop table quality.calibration;
drop table quality.equipment;
drop table quality.supplier_qualification;
drop table quality.supplier;
drop table quality.capa_nonconformity;
drop table quality.capa;
drop table quality.nonconformity;
drop table quality.controlled_document;
drop table quality.federated_link;
drop table quality.federated_reference;
drop table quality.federated_source;
