-- migrate:up

-- ADR 0019, second half. SAS §84 lists the records Knowledge Fabric should hold for a
-- Warrant beyond the contract; §83.5 says KF stores normalized query fields and immutable
-- snapshots, never the WAR only as a blob. Until now fourteen of §67's actions carried their
-- payload into the action log and wrote nothing typed. Each table below is shaped from
-- OpenWarrant's own structs (execution.rs, preflight.rs, deliverable.rs, epistemic.rs,
-- gate_run.rs, seam.rs) and the SAS clause it serves, and is written by exactly the action
-- §67 names for it. References into OpenWarrant's world (`*_ref`) are its identifiers, kept
-- as opaque text: KF is institutional authority, not the author.
--
-- Immutability follows the SAS: receipts, evidence, inferences, judgments, artifacts,
-- submissions, preflights and dispatches are append-only; a blocker and a deviation carry a
-- disposition that one later act may set once.

-- ── §32 preflight, §32.7 readiness ───────────────────────────────────────────────────────
create table work.warrant_preflight (
  id                 uuid primary key default uuidv7(),
  warrant_id         uuid not null references work.warrant (id) on delete restrict,
  receipt_digest     text not null check (receipt_digest ~ '^[0-9a-f]{64}$'),
  -- check name -> outcome, as PreflightReceipt.outcomes; absent means not_run, never passed.
  outcomes           jsonb not null,
  readiness          text not null check (readiness in ('ready', 'not_ready')),
  performed_at       timestamptz not null,
  recorded_by        uuid not null references org.person (id) on delete restrict,
  recorded_by_action uuid not null unique references core.action (id) on delete restrict,
  unique (warrant_id, receipt_digest)
);

-- ── dispatch authorization (§24.7 ready → executing) ──────────────────────────────────────
create table work.warrant_dispatch (
  id                   uuid primary key default uuidv7(),
  warrant_id           uuid not null references work.warrant (id) on delete restrict,
  -- The digest of what was dispatched — the authorized contract revision plus the prompt or
  -- plan IR — so a runtime receipt can be bound to it (§85, KatanaReceipt.dispatch_digest).
  dispatch_digest      text not null check (dispatch_digest ~ '^[0-9a-f]{64}$'),
  performer_ref        text not null check (length(btrim(performer_ref)) between 1 and 512),
  authorized_revision  integer not null check (authorized_revision > 0),
  authorized_by        uuid not null references org.person (id) on delete restrict,
  acting_role          uuid not null references org.role_assignment (id) on delete restrict,
  recorded_by_action   uuid not null unique references core.action (id) on delete restrict,
  recorded_at          timestamptz not null default now(),
  unique (warrant_id, dispatch_digest),
  foreign key (warrant_id, authorized_revision) references work.warrant_contract_revision (warrant_id, revision_no)
);

-- ── §85 runtime receipts ──────────────────────────────────────────────────────────────────
create table work.warrant_runtime_receipt (
  id                 uuid primary key default uuidv7(),
  warrant_id         uuid not null references work.warrant (id) on delete restrict,
  adapter            text not null check (adapter in
    ('oh.war/katana-receipt/v1', 'oh.war/blut-receipt/v1',
     'oh.war/liminal-compilation-receipt/v1', 'oh.war/gate-run-receipt/v1')),
  -- Binds the receipt to the dispatch it answers (§85: native identity preserved, log not
  -- reproduced).
  dispatch_digest    text not null check (dispatch_digest ~ '^[0-9a-f]{64}$'),
  receipt_digest     text not null check (receipt_digest ~ '^[0-9a-f]{64}$'),
  terminal_status    text not null check (length(btrim(terminal_status)) between 1 and 64),
  artifact_refs      text[] not null default '{}',
  receipt            jsonb not null,
  recorded_by        uuid not null references org.person (id) on delete restrict,
  recorded_by_action uuid not null unique references core.action (id) on delete restrict,
  recorded_at        timestamptz not null default now(),
  unique (warrant_id, receipt_digest),
  foreign key (warrant_id, dispatch_digest) references work.warrant_dispatch (warrant_id, dispatch_digest)
);

-- ── §37.4 performer submission ────────────────────────────────────────────────────────────
create table work.warrant_submission (
  id                     uuid primary key default uuidv7(),
  warrant_id             uuid not null references work.warrant (id) on delete restrict,
  submission_ref         text not null check (length(btrim(submission_ref)) between 1 and 200),
  artifact_refs          text[] not null default '{}',
  blocker_refs           text[] not null default '{}',
  deviation_refs         text[] not null default '{}',
  requested_next_action  text not null check (length(btrim(requested_next_action)) > 0),
  -- §37.4: normally not a deliverable; the exception is stated, never assumed.
  declared_as_deliverable boolean not null default false,
  recorded_by            uuid not null references org.person (id) on delete restrict,
  recorded_by_action     uuid not null unique references core.action (id) on delete restrict,
  recorded_at            timestamptz not null default now(),
  unique (warrant_id, submission_ref)
);

-- ── §53.1 blocker (opened by one act, resolved by another) ────────────────────────────────
create table work.warrant_blocker (
  id                  uuid primary key default uuidv7(),
  warrant_id          uuid not null references work.warrant (id) on delete restrict,
  blocker_ref         text not null check (length(btrim(blocker_ref)) between 1 and 200),
  condition_ref       text not null check (length(btrim(condition_ref)) > 0),
  reason              text not null check (length(btrim(reason)) > 0),
  owner_ref           text not null check (length(btrim(owner_ref)) > 0),
  required_to_unblock text not null check (length(btrim(required_to_unblock)) > 0),
  opened_by           uuid not null references org.person (id) on delete restrict,
  opened_by_action    uuid not null unique references core.action (id) on delete restrict,
  opened_at           timestamptz not null default now(),
  resolved_at         timestamptz,
  resolved_by         uuid references org.person (id) on delete restrict,
  resolved_by_action  uuid unique references core.action (id) on delete restrict,
  resolution          text,
  -- §24.7: "requires re-preflight where the underlying basis changed" — recorded, so the
  -- next preflight can be demanded rather than assumed.
  basis_changed       boolean,
  constraint warrant_blocker_resolution_complete check (
    (resolved_at is null and resolved_by is null and resolved_by_action is null
      and resolution is null and basis_changed is null)
    or (resolved_at is not null and resolved_by is not null and resolved_by_action is not null
      and length(btrim(resolution)) > 0 and basis_changed is not null)
  ),
  unique (warrant_id, blocker_ref)
);

-- ── §53.2 deviation (proposed by one act, dispositioned by one later act) ─────────────────
create table work.warrant_deviation (
  id                     uuid primary key default uuidv7(),
  warrant_id             uuid not null references work.warrant (id) on delete restrict,
  deviation_ref          text not null check (length(btrim(deviation_ref)) between 1 and 200),
  affected_contract_path text not null check (affected_contract_path ~ '^/'),
  proposed_change        jsonb not null,
  reason                 text not null check (length(btrim(reason)) > 0),
  -- §53.2's impact block: stated, or exception authority has no informed basis.
  impact                 jsonb not null,
  proposed_by            uuid not null references org.person (id) on delete restrict,
  proposed_by_action     uuid not null unique references core.action (id) on delete restrict,
  proposed_at            timestamptz not null default now(),
  disposition            text not null default 'proposed'
    check (disposition in ('proposed', 'approved', 'rejected')),
  decided_by             uuid references org.person (id) on delete restrict,
  decided_by_action      uuid unique references core.action (id) on delete restrict,
  decided_at             timestamptz,
  decision_reason        text,
  constraint warrant_deviation_decision_complete check (
    (disposition = 'proposed' and decided_by is null and decided_by_action is null
      and decided_at is null and decision_reason is null)
    or (disposition <> 'proposed' and decided_by is not null and decided_by_action is not null
      and decided_at is not null and length(btrim(decision_reason)) > 0)
  ),
  unique (warrant_id, deviation_ref)
);

-- ── §53.4 discovered gap ──────────────────────────────────────────────────────────────────
create table work.warrant_discovered_gap (
  id                 uuid primary key default uuidv7(),
  warrant_id         uuid not null references work.warrant (id) on delete restrict,
  gap_ref            text not null check (length(btrim(gap_ref)) between 1 and 200),
  statement          text not null check (length(btrim(statement)) > 0),
  under_specified    text not null check (under_specified in ('contract', 'sas', 'adr', 'gate', 'source')),
  -- §53.4: dispositioned through clarification, amendment, ADR, child WAR or supersession.
  disposition        text check (disposition is null or disposition in
    ('clarification', 'amendment', 'adr', 'child_warrant', 'supersession')),
  -- §53.4 forbids exactly this; it is a column so that it can be REFUSED, not assumed absent.
  repaired_in_place  boolean not null default false check (repaired_in_place = false),
  recorded_by        uuid not null references org.person (id) on delete restrict,
  recorded_by_action uuid not null unique references core.action (id) on delete restrict,
  recorded_at        timestamptz not null default now(),
  unique (warrant_id, gap_ref)
);

-- ── §37.2 artifact provenance ─────────────────────────────────────────────────────────────
create table work.warrant_artifact (
  id                 uuid primary key default uuidv7(),
  warrant_id         uuid not null references work.warrant (id) on delete restrict,
  artifact_ref       text not null check (length(btrim(artifact_ref)) between 1 and 200),
  producer_ref       text not null check (length(btrim(producer_ref)) > 0),
  producing_attempt  text not null check (length(btrim(producing_attempt)) > 0),
  contract_digest    text not null check (contract_digest ~ '^[0-9a-f]{64}$'),
  input_digests      text[] not null default '{}',
  tool_identity      text not null check (length(btrim(tool_identity)) > 0),
  creation_method    text not null check (length(btrim(creation_method)) > 0),
  content_digest     text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  media_type         text not null check (length(btrim(media_type)) > 0),
  classification     text not null references registry.classification (id),
  retention_class    text not null references registry.retention_class (id),
  -- §13 Source Holder kinds.
  source_holder      text not null check (source_holder in
    ('git', 'fabric_native', 'external', 'generated_projection', 'runtime_receipt')),
  -- When the bytes are in this fabric, the version they are.
  artifact_version_id uuid references content.artifact_version (id) on delete restrict,
  recorded_by        uuid not null references org.person (id) on delete restrict,
  recorded_by_action uuid not null unique references core.action (id) on delete restrict,
  recorded_at        timestamptz not null default now(),
  unique (warrant_id, artifact_ref)
);

-- ── §40.2 / §41 evidence item ─────────────────────────────────────────────────────────────
create table work.warrant_evidence (
  id                 uuid primary key default uuidv7(),
  warrant_id         uuid not null references work.warrant (id) on delete restrict,
  evidence_ref       text not null check (length(btrim(evidence_ref)) between 1 and 200),
  kind               text not null check (length(btrim(kind)) > 0),
  origin             text not null check (length(btrim(origin)) > 0),
  admissibility      text not null check (length(btrim(admissibility)) > 0),
  content_digest     text check (content_digest is null or content_digest ~ '^[0-9a-f]{64}$'),
  collection_method  text,
  -- §41.4: occurred_at is the actor's; recorded_at is this service's.
  occurred_at        timestamptz,
  recorded_by        uuid not null references org.person (id) on delete restrict,
  recorded_by_action uuid not null unique references core.action (id) on delete restrict,
  recorded_at        timestamptz not null default now(),
  unique (warrant_id, evidence_ref)
);

-- ── §44.6 gate receipt ────────────────────────────────────────────────────────────────────
create table work.warrant_gate_run (
  id                 uuid primary key default uuidv7(),
  warrant_id         uuid not null references work.warrant (id) on delete restrict,
  gate_run_ref       text not null check (length(btrim(gate_run_ref)) between 1 and 200),
  gate_ref           text not null check (length(btrim(gate_ref)) > 0),
  definition_digest  text not null check (definition_digest ~ '^[0-9a-f]{64}$'),
  binding_digest     text not null check (binding_digest ~ '^[0-9a-f]{64}$'),
  execution_status   text not null check (length(btrim(execution_status)) > 0),
  verdict            text not null check (length(btrim(verdict)) > 0),
  reason_code        text,
  receipt_digest     text not null check (receipt_digest ~ '^[0-9a-f]{64}$'),
  -- The §44.6 receipt itself: runner, environment, arguments, timings, refs, usage.
  receipt            jsonb not null,
  recorded_by        uuid not null references org.person (id) on delete restrict,
  recorded_by_action uuid not null unique references core.action (id) on delete restrict,
  recorded_at        timestamptz not null default now(),
  unique (warrant_id, gate_run_ref)
);

-- ── §40.4 inference, §40.5 judgment ──────────────────────────────────────────────────────
create table work.warrant_inference (
  id                 uuid primary key default uuidv7(),
  warrant_id         uuid not null references work.warrant (id) on delete restrict,
  inference_ref      text not null check (length(btrim(inference_ref)) between 1 and 200),
  kind               text not null check (length(btrim(kind)) > 0),
  statement          text not null check (length(btrim(statement)) > 0),
  premise_refs       text[] not null check (cardinality(premise_refs) >= 1),
  claim_ref          text not null check (length(btrim(claim_ref)) > 0),
  recorded_by        uuid not null references org.person (id) on delete restrict,
  recorded_by_action uuid not null unique references core.action (id) on delete restrict,
  recorded_at        timestamptz not null default now(),
  unique (warrant_id, inference_ref)
);

create table work.warrant_judgment (
  id                 uuid primary key default uuidv7(),
  warrant_id         uuid not null references work.warrant (id) on delete restrict,
  judgment_ref       text not null check (length(btrim(judgment_ref)) between 1 and 200),
  kind               text not null check (length(btrim(kind)) > 0),
  statement          text not null check (length(btrim(statement)) > 0),
  meaning            text not null check (length(btrim(meaning)) > 0),
  basis_refs         text[] not null check (cardinality(basis_refs) >= 1),
  authority          text not null check (length(btrim(authority)) > 0),
  limitations        text[] not null default '{}',
  -- The judge is the acting person and role of the act, never a payload claim.
  actor              uuid not null references org.person (id) on delete restrict,
  acting_role        uuid not null references org.role_assignment (id) on delete restrict,
  recorded_by_action uuid not null unique references core.action (id) on delete restrict,
  recorded_at        timestamptz not null default now(),
  unique (warrant_id, judgment_ref)
);

-- ── resolution request ────────────────────────────────────────────────────────────────────
create table work.warrant_resolution_request (
  id                 uuid primary key default uuidv7(),
  warrant_id         uuid not null references work.warrant (id) on delete restrict,
  requested_outcome  text not null check (requested_outcome in
    ('satisfied', 'not_satisfied', 'falsified', 'rejected', 'withdrawn', 'cancelled', 'inconclusive')),
  basis_refs         text[] not null check (cardinality(basis_refs) >= 1),
  recorded_by        uuid not null references org.person (id) on delete restrict,
  recorded_by_action uuid not null unique references core.action (id) on delete restrict,
  recorded_at        timestamptz not null default now()
);

-- ── immutability ──────────────────────────────────────────────────────────────────────────
create or replace function work.warrant_record_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only (SAS §83.5): % is not permitted', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['warrant_preflight', 'warrant_dispatch', 'warrant_runtime_receipt',
    'warrant_submission', 'warrant_discovered_gap', 'warrant_artifact', 'warrant_evidence',
    'warrant_gate_run', 'warrant_inference', 'warrant_judgment', 'warrant_resolution_request']
  loop
    execute format('create trigger %I_append_only before update or delete on work.%I '
                   'for each row execute function work.warrant_record_append_only()', t, t);
  end loop;
end;
$$;

-- A blocker and a deviation admit exactly one later change: their disposition.
create or replace function work.warrant_disposition_only() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% is append-only (SAS §83.5): DELETE is not permitted', tg_table_name
      using errcode = 'restrict_violation';
  end if;
  if tg_table_name = 'warrant_blocker' then
    if old.resolved_at is not null then
      raise exception 'blocker % is already resolved', old.blocker_ref using errcode = 'check_violation';
    end if;
    if (to_jsonb(new) - 'resolved_at' - 'resolved_by' - 'resolved_by_action' - 'resolution' - 'basis_changed')
       is distinct from
       (to_jsonb(old) - 'resolved_at' - 'resolved_by' - 'resolved_by_action' - 'resolution' - 'basis_changed') then
      raise exception 'only the resolution of a blocker may change' using errcode = 'check_violation';
    end if;
  else
    if old.disposition <> 'proposed' then
      raise exception 'deviation % is already %', old.deviation_ref, old.disposition using errcode = 'check_violation';
    end if;
    if (to_jsonb(new) - 'disposition' - 'decided_by' - 'decided_by_action' - 'decided_at' - 'decision_reason')
       is distinct from
       (to_jsonb(old) - 'disposition' - 'decided_by' - 'decided_by_action' - 'decided_at' - 'decision_reason') then
      raise exception 'only the disposition of a deviation may change' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger warrant_blocker_disposition_only before update or delete on work.warrant_blocker
  for each row execute function work.warrant_disposition_only();
create trigger warrant_deviation_disposition_only before update or delete on work.warrant_deviation
  for each row execute function work.warrant_disposition_only();

-- ── row-level security and grants ─────────────────────────────────────────────────────────
-- Written out per table, not looped: the boundary gate reads these statements literally,
-- and a reader auditing which tables carry the boundary should not have to unroll a loop.
alter table work.warrant_preflight enable row level security;
create policy warrant_preflight_scoped_read on work.warrant_preflight for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_preflight.warrant_id)
  );
create policy warrant_preflight_scoped_insert on work.warrant_preflight for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_preflight.warrant_id)
  );
create policy warrant_preflight_backup_read on work.warrant_preflight for select to kf_backup using (true);
grant select on work.warrant_preflight to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_preflight to kf_app;

alter table work.warrant_dispatch enable row level security;
create policy warrant_dispatch_scoped_read on work.warrant_dispatch for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_dispatch.warrant_id)
  );
create policy warrant_dispatch_scoped_insert on work.warrant_dispatch for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_dispatch.warrant_id)
  );
create policy warrant_dispatch_backup_read on work.warrant_dispatch for select to kf_backup using (true);
grant select on work.warrant_dispatch to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_dispatch to kf_app;

alter table work.warrant_runtime_receipt enable row level security;
create policy warrant_runtime_receipt_scoped_read on work.warrant_runtime_receipt for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_runtime_receipt.warrant_id)
  );
create policy warrant_runtime_receipt_scoped_insert on work.warrant_runtime_receipt for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_runtime_receipt.warrant_id)
  );
create policy warrant_runtime_receipt_backup_read on work.warrant_runtime_receipt for select to kf_backup using (true);
grant select on work.warrant_runtime_receipt to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_runtime_receipt to kf_app;

alter table work.warrant_submission enable row level security;
create policy warrant_submission_scoped_read on work.warrant_submission for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_submission.warrant_id)
  );
create policy warrant_submission_scoped_insert on work.warrant_submission for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_submission.warrant_id)
  );
create policy warrant_submission_backup_read on work.warrant_submission for select to kf_backup using (true);
grant select on work.warrant_submission to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_submission to kf_app;

alter table work.warrant_blocker enable row level security;
create policy warrant_blocker_scoped_read on work.warrant_blocker for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_blocker.warrant_id)
  );
create policy warrant_blocker_scoped_insert on work.warrant_blocker for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_blocker.warrant_id)
  );
create policy warrant_blocker_backup_read on work.warrant_blocker for select to kf_backup using (true);
grant select on work.warrant_blocker to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_blocker to kf_app;

alter table work.warrant_deviation enable row level security;
create policy warrant_deviation_scoped_read on work.warrant_deviation for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_deviation.warrant_id)
  );
create policy warrant_deviation_scoped_insert on work.warrant_deviation for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_deviation.warrant_id)
  );
create policy warrant_deviation_backup_read on work.warrant_deviation for select to kf_backup using (true);
grant select on work.warrant_deviation to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_deviation to kf_app;

alter table work.warrant_discovered_gap enable row level security;
create policy warrant_discovered_gap_scoped_read on work.warrant_discovered_gap for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_discovered_gap.warrant_id)
  );
create policy warrant_discovered_gap_scoped_insert on work.warrant_discovered_gap for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_discovered_gap.warrant_id)
  );
create policy warrant_discovered_gap_backup_read on work.warrant_discovered_gap for select to kf_backup using (true);
grant select on work.warrant_discovered_gap to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_discovered_gap to kf_app;

alter table work.warrant_artifact enable row level security;
create policy warrant_artifact_scoped_read on work.warrant_artifact for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_artifact.warrant_id)
  );
create policy warrant_artifact_scoped_insert on work.warrant_artifact for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_artifact.warrant_id)
  );
create policy warrant_artifact_backup_read on work.warrant_artifact for select to kf_backup using (true);
grant select on work.warrant_artifact to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_artifact to kf_app;

alter table work.warrant_evidence enable row level security;
create policy warrant_evidence_scoped_read on work.warrant_evidence for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_evidence.warrant_id)
  );
create policy warrant_evidence_scoped_insert on work.warrant_evidence for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_evidence.warrant_id)
  );
create policy warrant_evidence_backup_read on work.warrant_evidence for select to kf_backup using (true);
grant select on work.warrant_evidence to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_evidence to kf_app;

alter table work.warrant_gate_run enable row level security;
create policy warrant_gate_run_scoped_read on work.warrant_gate_run for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_gate_run.warrant_id)
  );
create policy warrant_gate_run_scoped_insert on work.warrant_gate_run for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_gate_run.warrant_id)
  );
create policy warrant_gate_run_backup_read on work.warrant_gate_run for select to kf_backup using (true);
grant select on work.warrant_gate_run to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_gate_run to kf_app;

alter table work.warrant_inference enable row level security;
create policy warrant_inference_scoped_read on work.warrant_inference for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_inference.warrant_id)
  );
create policy warrant_inference_scoped_insert on work.warrant_inference for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_inference.warrant_id)
  );
create policy warrant_inference_backup_read on work.warrant_inference for select to kf_backup using (true);
grant select on work.warrant_inference to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_inference to kf_app;

alter table work.warrant_judgment enable row level security;
create policy warrant_judgment_scoped_read on work.warrant_judgment for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_judgment.warrant_id)
  );
create policy warrant_judgment_scoped_insert on work.warrant_judgment for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_judgment.warrant_id)
  );
create policy warrant_judgment_backup_read on work.warrant_judgment for select to kf_backup using (true);
grant select on work.warrant_judgment to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_judgment to kf_app;

alter table work.warrant_resolution_request enable row level security;
create policy warrant_resolution_request_scoped_read on work.warrant_resolution_request for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_resolution_request.warrant_id)
  );
create policy warrant_resolution_request_scoped_insert on work.warrant_resolution_request for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_resolution_request.warrant_id)
  );
create policy warrant_resolution_request_backup_read on work.warrant_resolution_request for select to kf_backup using (true);
grant select on work.warrant_resolution_request to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on work.warrant_resolution_request to kf_app;

create policy warrant_blocker_scoped_update on work.warrant_blocker for update
  using (exists (select 1 from core.object envelope where envelope.id = warrant_blocker.warrant_id))
  with check (exists (select 1 from core.object envelope where envelope.id = warrant_blocker.warrant_id));
create policy warrant_deviation_scoped_update on work.warrant_deviation for update
  using (exists (select 1 from core.object envelope where envelope.id = warrant_deviation.warrant_id))
  with check (exists (select 1 from core.object envelope where envelope.id = warrant_deviation.warrant_id));
grant update on work.warrant_blocker, work.warrant_deviation to kf_app;

-- migrate:down

drop policy warrant_deviation_scoped_update on work.warrant_deviation;
drop policy warrant_blocker_scoped_update on work.warrant_blocker;
do $$
declare t text;
begin
  foreach t in array array['warrant_resolution_request', 'warrant_judgment', 'warrant_inference',
    'warrant_gate_run', 'warrant_evidence', 'warrant_artifact', 'warrant_discovered_gap',
    'warrant_deviation', 'warrant_blocker', 'warrant_submission', 'warrant_runtime_receipt',
    'warrant_dispatch', 'warrant_preflight']
  loop
    execute format('drop table work.%I', t);
  end loop;
end;
$$;
drop function work.warrant_disposition_only();
drop function work.warrant_record_append_only();
