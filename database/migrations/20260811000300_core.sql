-- migrate:up

-- The core schema: identity, relations, actions, approvals, snapshots, audit and outbox.
--
-- Two ideas carry most of the weight here.
--
-- First, transaction context. Every controlled write must know who is acting and under what
-- authority. Rather than trusting each statement to pass that along, the action service sets
-- it once per transaction and triggers read it. A write with no context is refused, so
-- "forgot to record the actor" is impossible rather than merely discouraged.
--
-- Second, the audit chain. `core.audit_event` is append-only and each row commits to its
-- predecessor's digest. Revoking UPDATE and DELETE stops the application from rewriting
-- history; the chain makes a rewrite by anyone else — including a superuser — detectable by
-- recomputation.

-- ── transaction context ─────────────────────────────────────────────────────────────────

create or replace function core.set_transaction_context(
  p_actor uuid,
  p_acting_role uuid,
  p_action_id uuid,
  p_request_id text
) returns void
language plpgsql
as $$
begin
  -- LOCAL: scoped to this transaction, so context can never leak into the next statement on
  -- a pooled connection.
  perform set_config('kf.actor', p_actor::text, true);
  perform set_config('kf.acting_role', p_acting_role::text, true);
  perform set_config('kf.action_id', p_action_id::text, true);
  perform set_config('kf.request_id', coalesce(p_request_id, ''), true);
end
$$;

create or replace function core.current_actor() returns uuid
language plpgsql stable
as $$
declare v text := current_setting('kf.actor', true);
begin
  if v is null or v = '' then
    raise exception 'no transaction context: this write must go through the action service'
      using errcode = 'insufficient_privilege',
            hint = 'Call core.set_transaction_context() first. Direct writes are not permitted.';
  end if;
  return v::uuid;
end
$$;

create or replace function core.current_action_id() returns uuid
language sql stable
as $$ select nullif(current_setting('kf.action_id', true), '')::uuid $$;

-- ── object identity ─────────────────────────────────────────────────────────────────────

create table core.object (
  id                uuid primary key default uuidv7(),
  -- Human-facing business identity, allocated by the Identifier Registry. Null until
  -- allocated: spec §7.1 makes the UUID sufficient on its own until then.
  enterprise_id     text unique,
  object_type       text not null references registry.object_type (id),
  authority_domain  text not null,
  lifecycle_state   text not null,
  classification    text not null references registry.classification (id),
  retention_class   text not null references registry.retention_class (id),
  schema_version    text not null references registry.schema_release (version),
  organization_id   uuid not null,
  -- Optimistic concurrency. An action states the version it read; if it moved, the action
  -- fails rather than overwriting a decision someone else made in between.
  row_version       bigint not null default 1,
  title             text not null check (length(btrim(title)) between 1 and 240),
  created_at        timestamptz not null default now(),
  created_by        uuid not null,
  updated_at        timestamptz not null default now(),
  updated_by        uuid not null,

  -- The state must exist in the machine this type uses. Enforced against the registry, so a
  -- typo becomes a foreign-key failure and not a record parked in a state nothing handles.
  constraint object_state_defined
    foreign key (object_type, lifecycle_state)
    references registry.state_definition (machine_id, state)
    deferrable initially immediate
);

create index object_by_type_state on core.object (object_type, lifecycle_state);
create index object_by_org on core.object (organization_id);
create index object_by_enterprise_id on core.object (enterprise_id) where enterprise_id is not null;

-- ── typed relations ─────────────────────────────────────────────────────────────────────

create table core.relation (
  id                  uuid primary key default uuidv7(),
  relation_type       text not null references registry.relation_type (id),
  source_id           uuid not null references core.object (id),
  target_id           uuid not null references core.object (id),
  state               text not null default 'active'
                        check (state in ('active', 'inactive', 'superseded')),
  properties          jsonb not null default '{}'::jsonb,
  -- Effectivity. `valid_to` null means open-ended.
  valid_from          timestamptz not null default now(),
  valid_to            timestamptz,
  created_at          timestamptz not null default now(),
  created_by          uuid not null,
  -- An edge carrying a material assertion records the action that authorized it, so
  -- authority attaches to the relationship and not only to its endpoints.
  authorizing_action  uuid,
  constraint relation_interval_ordered check (valid_to is null or valid_to > valid_from),
  -- A relation from a thing to itself is a modelling error for every type we have.
  constraint relation_not_self check (source_id <> target_id)
);

create index relation_by_source on core.relation (source_id, relation_type) where state = 'active';
create index relation_by_target on core.relation (target_id, relation_type) where state = 'active';

-- One active edge of a given type between the same pair at the same time. Without this,
-- "contains" could be asserted twice and any count over it would double.
create unique index relation_unique_active
  on core.relation (relation_type, source_id, target_id)
  where state = 'active' and valid_to is null;

-- ── actions ─────────────────────────────────────────────────────────────────────────────

create table core.action (
  id                uuid primary key default uuidv7(),
  action_type       text not null references registry.action_type (id),
  actor_id          uuid not null,
  -- The role EXERCISED, not every role held. One person may hold several; the record has to
  -- say which authority was used.
  acting_role_id    uuid not null,
  target_ids        uuid[] not null check (cardinality(target_ids) >= 1),
  parameters        jsonb not null default '{}'::jsonb,
  -- What the action believed before it ran. Reproducing a decision later requires knowing
  -- what it was looking at, not just what it did.
  preconditions     jsonb not null default '{}'::jsonb,
  idempotency_key   text not null check (length(idempotency_key) between 8 and 128),
  -- recorded_at is when we learned; effective_at is when it happened. They differ whenever
  -- history is reconstructed from contemporaneous evidence (spec §29.4).
  recorded_at       timestamptz not null default now(),
  effective_at      timestamptz not null,
  request_id        text,
  reason            text,
  result_status     text not null check (result_status in ('applied', 'rejected', 'failed')),
  result            jsonb not null default '{}'::jsonb
);

-- Retrying an action must replay the first result, not apply it twice. This is what makes
-- a network timeout safe to retry.
create unique index action_idempotency on core.action (action_type, idempotency_key);
create index action_by_actor on core.action (actor_id, recorded_at desc);
create index action_by_target on core.action using gin (target_ids);

-- ── approvals and snapshots ─────────────────────────────────────────────────────────────

create table core.approval (
  id             uuid primary key default uuidv7(),
  object_id      uuid not null references core.object (id),
  action_id      uuid not null references core.action (id),
  approver_id    uuid not null,
  approver_role  uuid not null,
  -- What the signature MEANS. A signature with no stated meaning is not an approval of
  -- anything in particular.
  meaning        text not null check (length(btrim(meaning)) > 0),
  recorded_at    timestamptz not null default now(),
  effective_at   timestamptz not null
);

create table core.snapshot (
  id               uuid primary key default uuidv7(),
  object_id        uuid not null references core.object (id),
  action_id        uuid not null references core.action (id),
  object_revision  bigint not null,
  -- RFC 8785 canonical JSON of the object and its required relations at approval time.
  payload          jsonb not null,
  payload_sha256   text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  ontology_digest  text not null check (ontology_digest ~ '^[0-9a-f]{64}$'),
  -- Where the canonical package lives in object storage, when it is too large to inline.
  storage_uri      text,
  recorded_at      timestamptz not null default now()
);

create unique index snapshot_per_object_revision on core.snapshot (object_id, object_revision);

-- ── audit ───────────────────────────────────────────────────────────────────────────────

create table core.audit_event (
  -- Monotonic within the log. The chain is defined over this order.
  seq               bigserial primary key,
  id                uuid not null unique default uuidv7(),
  action_id         uuid not null references core.action (id),
  actor_id          uuid not null,
  acting_role_id    uuid not null,
  action_type       text not null references registry.action_type (id),
  object_id         uuid,
  recorded_at       timestamptz not null default now(),
  effective_at      timestamptz not null,
  request_id        text,
  reason            text,
  before_digest     text check (before_digest ~ '^[0-9a-f]{64}$'),
  after_digest      text check (after_digest ~ '^[0-9a-f]{64}$'),
  -- Hash chain. digest = sha256(prev_digest || canonical(this row's committed fields)).
  -- Altering any historical row changes every digest after it.
  prev_digest       text not null check (prev_digest ~ '^[0-9a-f]{64}$'),
  digest            text not null unique check (digest ~ '^[0-9a-f]{64}$')
);

create index audit_by_object on core.audit_event (object_id, seq);
create index audit_by_action on core.audit_event (action_id);

create table core.audit_checkpoint (
  id               uuid primary key default uuidv7(),
  from_seq         bigint not null,
  to_seq           bigint not null,
  merkle_root      text not null check (merkle_root ~ '^[0-9a-f]{64}$'),
  -- Ed25519 over the root, produced by a process the API cannot reach.
  signature        text not null,
  signing_key_id   text not null,
  storage_uri      text,
  recorded_at      timestamptz not null default now(),
  constraint checkpoint_range_ordered check (to_seq >= from_seq)
);

-- ── outbox and idempotency ──────────────────────────────────────────────────────────────

create table core.outbox (
  id            uuid primary key default uuidv7(),
  action_id     uuid not null references core.action (id),
  topic         text not null,
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  delivered_at  timestamptz
);

-- Partial index: the worker only ever scans undelivered rows, and this keeps that scan
-- proportional to the backlog rather than to the history.
create index outbox_undelivered on core.outbox (created_at) where delivered_at is null;

create table core.retention_hold (
  id           uuid primary key default uuidv7(),
  object_id    uuid not null references core.object (id),
  reason       text not null,
  placed_by    uuid not null,
  placed_at    timestamptz not null default now(),
  released_at  timestamptz
);

-- ── append-only enforcement ─────────────────────────────────────────────────────────────

create or replace function core.refuse_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'core.% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP
    using errcode = 'insufficient_privilege',
          hint = 'Corrections are additive: record a new event, never edit or remove one.';
end
$$;

-- Belt and braces alongside the revoked privileges below. Privileges can be re-granted by
-- accident; a trigger has to be dropped deliberately, and dropping it is visible in the DDL
-- log because log_statement=ddl.
create trigger audit_event_append_only
  before update or delete or truncate on core.audit_event
  for each statement execute function core.refuse_mutation();

create trigger snapshot_append_only
  before update or delete or truncate on core.snapshot
  for each statement execute function core.refuse_mutation();

create trigger approval_append_only
  before update or delete or truncate on core.approval
  for each statement execute function core.refuse_mutation();

create trigger checkpoint_append_only
  before update or delete or truncate on core.audit_checkpoint
  for each statement execute function core.refuse_mutation();

-- An action record is what happened. It does not get revised either.
create trigger action_append_only
  before update or delete or truncate on core.action
  for each statement execute function core.refuse_mutation();

-- ── grants ──────────────────────────────────────────────────────────────────────────────

grant select, insert, update on core.object, core.relation to kf_app;
grant select, insert on core.action, core.approval, core.snapshot, core.audit_event,
                        core.outbox, core.retention_hold to kf_app;

-- The worker delivers outbox rows: it marks them delivered and reads what it needs.
grant select on core.action, core.object, core.relation to kf_worker;
grant select, update (delivered_at) on core.outbox to kf_worker;

-- The checkpoint signer reads the audit log and writes checkpoints. Nothing else — it runs
-- where the signing key is, so its reach has to be as small as the job allows.
grant select on core.audit_event to kf_checkpoint;
grant select, insert on core.audit_checkpoint to kf_checkpoint;

grant select on all tables in schema core to kf_readonly, kf_auditor;

-- Explicit, even though no grant was issued: the application must never be able to rewrite
-- history, and a future blanket GRANT should not silently hand it that power.
revoke update, delete, truncate on core.audit_event from kf_app, kf_worker, kf_checkpoint;
revoke update, delete, truncate on core.snapshot, core.approval, core.action from kf_app, kf_worker;
revoke delete on core.object, core.relation from kf_app, kf_worker;

comment on function core.set_transaction_context is
  'Sets actor, role, action and request for the CURRENT transaction only. Triggers read '
  'these; a controlled write without them is refused.';
comment on table core.audit_event is
  'Append-only, hash-chained. Revoked privileges stop the application rewriting history; '
  'the chain makes a rewrite by anyone else detectable by recomputation.';
comment on column core.object.row_version is
  'Optimistic concurrency. An action states the version it read; if it moved, the action '
  'fails rather than overwriting a decision made in between.';

-- migrate:down

drop table if exists core.retention_hold;
drop table if exists core.outbox;
drop table if exists core.audit_checkpoint;
drop table if exists core.audit_event;
drop table if exists core.snapshot;
drop table if exists core.approval;
drop table if exists core.action;
drop table if exists core.relation;
drop table if exists core.object;
drop function if exists core.refuse_mutation();
drop function if exists core.current_action_id();
drop function if exists core.current_actor();
drop function if exists core.set_transaction_context(uuid, uuid, uuid, text);
