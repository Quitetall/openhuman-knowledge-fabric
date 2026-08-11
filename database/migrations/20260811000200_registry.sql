-- migrate:up

-- The registry schema: the ontology, mirrored into the database.
--
-- Domain tables reference these tables, so a state or action token the ontology does not
-- define fails a FOREIGN KEY. That is the difference between a rule the database enforces
-- and a rule the application remembers to check.
--
-- Rows are loaded from generated/sql-registry/001-ontology-seed.sql, which the ontology
-- compiler emits. Nothing hand-inserts here.

create table registry.schema_release (
  version           text primary key,
  ontology_digest   text not null check (ontology_digest ~ '^[0-9a-f]{64}$'),
  applied_at        timestamptz not null default now(),
  -- Which release the running database believes it is on. A mismatch against the compiled
  -- ontology means the code and the data disagree about what the words mean.
  is_current        boolean not null default true
);

-- Exactly one release may be current. Without this, two rows could both claim to be, and
-- every consistency check downstream would silently pick one.
create unique index schema_release_one_current
  on registry.schema_release ((true)) where is_current;

create table registry.object_type (
  id                    text primary key,
  title                 text not null,
  authority_domain      text not null,
  enterprise_namespace  text,
  first_class           boolean not null
);

create table registry.relation_type (
  id             text primary key,
  inverse_label  text not null,
  acyclic        boolean not null,
  -- `symmetric` alone is a PostgreSQL reserved word (BETWEEN SYMMETRIC), so this one column
  -- carries the is_ prefix its neighbour does not.
  is_symmetric   boolean not null,
  -- A symmetric relation is a two-node cycle by definition, so it cannot also be acyclic.
  constraint relation_type_not_symmetric_and_acyclic check (not (is_symmetric and acyclic))
);

create table registry.action_type (
  id             text primary key,
  audited        boolean not null,
  transactional  boolean not null,
  -- Every controlled write is audited. An unaudited action has no place in this system, so
  -- the database refuses to store the definition of one.
  constraint action_type_must_be_audited check (audited)
);

-- Every object type declares states. Only some declare TRANSITIONS between them: 13 of the
-- 21 types are things like Person and Organization, which have a status but no lifecycle
-- anyone drives. Keying states to the object type rather than to a machine is what lets
-- both exist without inventing an empty machine for the ones that have none.
create table registry.object_state (
  object_type  text not null references registry.object_type (id) on delete cascade,
  state        text not null,
  is_terminal  boolean not null,
  primary key (object_type, state)
);

-- A lifecycle: an object type whose states are connected by actions.
create table registry.state_machine (
  id             text primary key references registry.object_type (id) on delete cascade,
  initial_state  text not null,
  constraint state_machine_initial_declared
    foreign key (id, initial_state) references registry.object_state (object_type, state)
);

create table registry.rule_definition (
  id              text primary key check (id ~ '^KF-[A-Z]+-[0-9]{3}$'),
  severity        text not null check (severity in ('error', 'warning')),
  description     text not null check (length(btrim(description)) > 0),
  -- Where the rule is enforced. Spec §27.1: a rule that exists only in prose is
  -- nonconforming, so an empty list is rejected rather than stored.
  implementation  text[] not null check (cardinality(implementation) > 0),
  constraint rule_implementation_known check (
    implementation <@ array['database_constraint', 'action_precondition', 'validator']::text[]
  )
);

create table registry.classification (
  id     text primary key,
  -- Ordering matters for comparison: restricted data must not flow into a public view.
  rank   integer not null unique
);

create table registry.retention_class (
  id           text primary key,
  description  text not null,
  -- Null means "no defined end". Device lifetime is currently undefined, so lifetime-based
  -- retention is unbounded and the schema has to be able to say so rather than guess.
  years        integer check (years is null or years > 0)
);

-- The registry is read by everyone and written only by migrations.
grant select on all tables in schema registry to kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor;

comment on table registry.object_type is
  'Object types from ontology/object-types.yaml. Loaded by migration, never by hand.';
comment on table registry.rule_definition is
  'Machine-enforceable invariants and where each is enforced. An entry with an empty '
  'implementation list is rejected: spec §27.1 calls a prose-only rule nonconforming.';
comment on index registry.schema_release_one_current is
  'At most one release may be current. Two rows claiming currency would make every '
  'downstream version check pick one arbitrarily.';

-- migrate:down

drop table if exists registry.retention_class;
drop table if exists registry.classification;
drop table if exists registry.rule_definition;
drop table if exists registry.object_state;
drop table if exists registry.state_machine;
drop table if exists registry.action_type;
drop table if exists registry.relation_type;
drop table if exists registry.object_type;
drop table if exists registry.schema_release;
