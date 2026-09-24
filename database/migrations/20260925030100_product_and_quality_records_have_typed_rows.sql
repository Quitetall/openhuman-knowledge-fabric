-- migrate:up

-- The R01 product and quality records get typed rows, so their create acts have somewhere to put
-- what they say (KF-SAS-RQ-143).
--
-- product_system, requirement, risk, test, baseline and release are R01 types with declared,
-- required fields — a requirement's statement, a risk's description, a product's kind and its
-- responsible owner — and until now no table held any of them and no act created one. The only
-- way such a record came to exist was an owner-credential insert into core.object, carrying a
-- title and nothing else: the privileged path RQ-143 forbids, and a record whose substance was
-- never recorded anywhere.
--
-- Each table follows the Gate 6 typed tables exactly: the row IS the object (primary key and
-- foreign key to core.object), its visibility defers to the envelope, row security is forced
-- (20260924000200), and the application may insert and never update — these records carry no
-- lifecycle (R01 declares none), so there is nothing an act would change afterwards. Columns
-- mirror the ontology's fields; `controls` on a risk is not stored, because it is derived:
-- engineering.risk_control.mitigates already names the risk each control mitigates.
--
-- A baseline's and a release's `contained_nodes` are rows of the existing
-- product.baseline_item / product.release_item, written by the same act.

create table product.product_system (
  id                      uuid primary key references core.object (id) on delete restrict,
  product_kind            text not null
    check (product_kind in ('product', 'platform', 'subsystem', 'service', 'infrastructure')),
  responsible_owner       uuid not null references core.object (id) on delete restrict,
  configuration_authority uuid references core.object (id) on delete restrict
);

create table engineering.requirement (
  id                  uuid primary key references core.object (id) on delete restrict,
  statement           text not null check (length(btrim(statement)) between 1 and 8000),
  requirement_kind    text not null check (requirement_kind in
    ('stakeholder', 'system', 'subsystem', 'software', 'process', 'regulatory')),
  verification_method text check (verification_method is null or length(btrim(verification_method)) > 0)
);

create table engineering.risk (
  id          uuid primary key references core.object (id) on delete restrict,
  risk_kind   text not null check (risk_kind in
    ('hazard', 'project', 'technical', 'supplier', 'cybersecurity', 'business')),
  description text not null check (length(btrim(description)) between 1 and 8000),
  severity    text check (severity is null or length(btrim(severity)) > 0),
  probability text check (probability is null or length(btrim(probability)) > 0)
);

create table engineering.test (
  id                 uuid primary key references core.object (id) on delete restrict,
  test_kind          text not null check (test_kind in ('method', 'case', 'protocol', 'execution')),
  objective          text not null check (length(btrim(objective)) between 1 and 8000),
  procedure_artifact uuid references core.object (id) on delete restrict,
  result_artifact    uuid references core.object (id) on delete restrict
);

create table product.baseline (
  id            uuid primary key references core.object (id) on delete restrict,
  baseline_kind text not null check (baseline_kind in
    ('functional', 'allocated', 'product', 'project', 'manufacturing', 'verification')),
  approved_at   timestamptz
);

create table product.release (
  id           uuid primary key references core.object (id) on delete restrict,
  release_kind text not null check (release_kind in
    ('product', 'document', 'software', 'manufacturing', 'schema')),
  released_at  timestamptz
);

comment on table product.product_system is
  'R01 product_system: the typed row behind the envelope, created only by register_product_system.';
comment on table engineering.requirement is
  'R01 requirement: created only by define_requirement.';
comment on table engineering.risk is
  'R01 risk: created only by identify_risk. Its controls are engineering.risk_control rows.';
comment on table engineering.test is
  'R01 test: created only by register_test. Gate 6 test_definition/test_execution are separate.';
comment on table product.baseline is
  'R01 baseline: created only by define_baseline; its contents are product.baseline_item rows.';
comment on table product.release is
  'R01 release: created only by define_release; its contents are product.release_item rows.';

-- Visibility defers to the envelope, as for every typed table (20260816000300).
alter table product.product_system enable row level security;
alter table product.product_system force row level security;
create policy product_system_scoped_read on product.product_system for select using (
    exists (select 1 from core.object envelope where envelope.id = product_system.id)
  );
create policy product_system_scoped_insert on product.product_system for insert with check (
    exists (select 1 from core.object envelope where envelope.id = product_system.id)
  );
create policy product_system_backup_read on product.product_system
  for select to kf_backup using (true);

alter table engineering.requirement enable row level security;
alter table engineering.requirement force row level security;
create policy requirement_scoped_read on engineering.requirement for select using (
    exists (select 1 from core.object envelope where envelope.id = requirement.id)
  );
create policy requirement_scoped_insert on engineering.requirement for insert with check (
    exists (select 1 from core.object envelope where envelope.id = requirement.id)
  );
create policy requirement_backup_read on engineering.requirement
  for select to kf_backup using (true);

alter table engineering.risk enable row level security;
alter table engineering.risk force row level security;
create policy risk_scoped_read on engineering.risk for select using (
    exists (select 1 from core.object envelope where envelope.id = risk.id)
  );
create policy risk_scoped_insert on engineering.risk for insert with check (
    exists (select 1 from core.object envelope where envelope.id = risk.id)
  );
create policy risk_backup_read on engineering.risk for select to kf_backup using (true);

alter table engineering.test enable row level security;
alter table engineering.test force row level security;
create policy test_scoped_read on engineering.test for select using (
    exists (select 1 from core.object envelope where envelope.id = test.id)
  );
create policy test_scoped_insert on engineering.test for insert with check (
    exists (select 1 from core.object envelope where envelope.id = test.id)
  );
create policy test_backup_read on engineering.test for select to kf_backup using (true);

alter table product.baseline enable row level security;
alter table product.baseline force row level security;
create policy baseline_scoped_read on product.baseline for select using (
    exists (select 1 from core.object envelope where envelope.id = baseline.id)
  );
create policy baseline_scoped_insert on product.baseline for insert with check (
    exists (select 1 from core.object envelope where envelope.id = baseline.id)
  );
create policy baseline_backup_read on product.baseline for select to kf_backup using (true);

alter table product.release enable row level security;
alter table product.release force row level security;
create policy release_scoped_read on product.release for select using (
    exists (select 1 from core.object envelope where envelope.id = release.id)
  );
create policy release_scoped_insert on product.release for insert with check (
    exists (select 1 from core.object envelope where envelope.id = release.id)
  );
create policy release_backup_read on product.release for select to kf_backup using (true);

grant select on product.product_system, product.baseline, product.release,
                engineering.requirement, engineering.risk, engineering.test
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on product.product_system, product.baseline, product.release,
                engineering.requirement, engineering.risk, engineering.test
  to kf_app;

-- migrate:down

drop table product.release;
drop table product.baseline;
drop table engineering.test;
drop table engineering.risk;
drop table engineering.requirement;
drop table product.product_system;
