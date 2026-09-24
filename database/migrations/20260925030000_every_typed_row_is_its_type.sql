-- migrate:up

-- Exactly one object row per governed record, of the type the record's table is about
-- (KF-SAS-RQ-030).
--
-- Every typed table keyed on `core.object (id)` carries a constant `object_type` column and a
-- composite foreign key `(id, object_type) → core.object (id, object_type)`, so a supplier row
-- cannot hang on a person (tests/database/typed-identity.test.ts). Two governed records were
-- added after that pattern and missed it: `work.warrant` (20260902000400) and
-- `ml.promotion_authority_decision`. Each referenced `core.object (id)` alone, so a warrant row
-- could sit on a decision record, and a promotion decision on a person, and both satisfied the
-- key while making one object two records.
--
-- `core.object_id_type_unique (id, object_type)` already exists for the other typed tables. The
-- generated columns are STORED and constant, so the type cannot be written or changed; the rows
-- already present are checked when each constraint is added, so a database that holds a
-- mistyped row refuses the migration rather than carrying it forward.

alter table work.warrant
  add column object_type text generated always as ('warrant') stored;
alter table work.warrant
  add constraint warrant_is_warrant
  foreign key (id, object_type) references core.object (id, object_type);

alter table ml.promotion_authority_decision
  add column object_type text generated always as ('ml_promotion_decision') stored;
alter table ml.promotion_authority_decision
  add constraint promotion_authority_decision_is_ml_promotion_decision
  foreign key (object_id, object_type) references core.object (id, object_type);

-- migrate:down

alter table ml.promotion_authority_decision
  drop constraint promotion_authority_decision_is_ml_promotion_decision;
alter table ml.promotion_authority_decision drop column object_type;
alter table work.warrant drop constraint warrant_is_warrant;
alter table work.warrant drop column object_type;
