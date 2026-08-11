-- migrate:up

-- Controlled value sets and the ontology seed.
--
-- Classifications and retention classes are declared here rather than compiled, because the
-- ranks encode an access ORDER that the ontology's flat list does not carry, and retention
-- periods are a legal determination rather than a modelling one.
--
-- Everything else in `registry` is loaded from generated/sql-registry/001-ontology-seed.sql,
-- which the ontology compiler emits. A follow-up migration applies it; the two are separate
-- so that re-seeding after an ontology change does not rewrite these.

insert into registry.classification (id, rank) values
  ('public', 0),
  ('internal', 1),
  ('confidential', 2),
  ('restricted', 3);

-- `years = null` means no defined end. Device lifetime is currently UNDEFINED, so every
-- lifetime-based period is unbounded, and the schema says so rather than guessing a number
-- that would later look like a decision someone made.
insert into registry.retention_class (id, description, years) values
  ('device_lifetime', 'ISO 13485 §4.2.5 — at least the device lifetime as the organization '
                      'defines it. Device lifetime is currently undefined, so unbounded.', null),
  ('commercial_record', 'Contracts, work orders, invoices and payments.', 7),
  ('quality_record', 'Controlled QMS records subject to §4.2.5 retention.', null),
  ('project_record', 'Project management records with no independent retention obligation.', 7),
  ('transient', 'Working material with no retention obligation.', 1);

comment on table registry.retention_class is
  'Retention periods. A null year count means no defined end, which is the honest state '
  'while device lifetime is undefined — not a value to be filled in with a guess.';

-- migrate:down

delete from registry.retention_class;
delete from registry.classification;
