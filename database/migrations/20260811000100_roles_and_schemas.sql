-- migrate:up

-- Roles and schemas.
--
-- Separation of duty starts in the database, not in the application. An application that
-- owns its own tables can alter the structure meant to constrain it, and one that can
-- delete audit rows leaves no evidence that it did. So the roles are split by what they are
-- allowed to do, and the application connects as the most limited one that can do its job.
--
-- These are NOLOGIN GROUP roles. Nothing connects as them, and `alter role kf_app with
-- password ...` would NOT make one connectable — a password does not confer LOGIN. To give
-- something access, create a login role that inherits the group:
--
--   create role kf_api login password '<from the secret manager>' inherit;
--   grant kf_app to kf_api;
--
-- Privileges attach to the group, so adding a person or a service never means re-granting a
-- hundred table privileges. Passwords stay out of band: a password in a migration is a
-- password in git forever.

do $$
begin
  -- NOLOGIN group roles. Privileges attach here; login roles inherit them, so granting a
  -- new person access never means re-granting a hundred table privileges.
  if not exists (select from pg_roles where rolname = 'kf_owner_role') then
    create role kf_owner_role nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'kf_migrator') then
    create role kf_migrator nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'kf_app') then
    create role kf_app nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'kf_worker') then
    create role kf_worker nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'kf_checkpoint') then
    create role kf_checkpoint nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'kf_readonly') then
    create role kf_readonly nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'kf_auditor') then
    create role kf_auditor nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'kf_backup') then
    create role kf_backup nologin;
  end if;
end
$$;

-- Schemas are authority boundaries, not folders. Each names the domain that owns the facts
-- inside it (spec §4.1), so "which system may write this" is answerable from the table name.
create schema if not exists registry;    -- the ontology, mirrored into the database
create schema if not exists core;        -- identity, relations, actions, audit
create schema if not exists org;         -- people, organizations, engagements, roles
create schema if not exists product;     -- products, configuration items, baselines
create schema if not exists work;        -- projects, work packages, orders, execution
create schema if not exists engineering; -- decisions, changes, requirements, risks, tests
create schema if not exists content;     -- artifacts and their versions
create schema if not exists finance;     -- invoices, payments, allocations
create schema if not exists quality;     -- controlled documents, CAPA, suppliers, training

comment on schema registry is
  'The ontology, mirrored from ontology/*.yaml. Domain tables reference it, so an unknown '
  'state or action token fails a foreign key rather than an application check.';
comment on schema core is
  'Object identity, typed relations, actions, approvals, snapshots, audit and outbox.';

-- Read access is broad; write access is not. Every role can traverse the schemas, which is
-- separate from being able to select or modify anything in them.
grant usage on schema registry, core, org, product, work, engineering, content, finance, quality
  to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

-- Only the migrator changes structure. The application cannot create, alter or drop, so a
-- compromised application cannot quietly add a column that bypasses a constraint.
grant create on schema registry, core, org, product, work, engineering, content, finance, quality
  to kf_migrator;

-- Sequences: the application needs nextval, nothing more.
alter default privileges for role kf_migrator in schema
  core, org, product, work, engineering, content, finance, quality
  grant usage, select on sequences to kf_app, kf_worker;

comment on role kf_migrator is 'Owns structure. The only role permitted DDL.';
comment on role kf_app is 'The API. Reads and writes domain rows through actions only.';
comment on role kf_worker is 'Background jobs. Outbox delivery and projections.';
comment on role kf_checkpoint is
  'Audit checkpoint signer. Reads audit rows, writes checkpoints, and nothing else — it '
  'runs where the signing key is, so its blast radius must be minimal.';
comment on role kf_auditor is 'Read-only including audit history. Cannot write anything.';
comment on role kf_backup is 'pg_dump only.';

-- migrate:down

drop schema if exists quality cascade;
drop schema if exists finance cascade;
drop schema if exists content cascade;
drop schema if exists engineering cascade;
drop schema if exists work cascade;
drop schema if exists product cascade;
drop schema if exists org cascade;
drop schema if exists core cascade;
drop schema if exists registry cascade;

-- Roles are NOT dropped: they may own objects in other databases on the same cluster, and a
-- dropped role takes its grants with it silently.
