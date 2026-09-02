-- migrate:up

-- ADR 0019. OpenWarrant SAS §67: Knowledge Fabric is the institutional authority for a
-- Warrant while Git stays its Source Holder (§13, §91.3 test 21). KF holds normalized query
-- fields and immutable canonical snapshots (§83.5) — never the WAR as a generic blob, never the
-- authored atoms themselves. Two tables: the Warrant as a first-class object with SAS §24's
-- five independent state dimensions, and its contract revisions (§28), which are never
-- patched in place (§28.7).

create table work.warrant (
  id                   uuid primary key references core.object (id) on delete restrict,
  -- §12.1: the UUIDv7 OpenWarrant minted at draft creation IS the object id (§12.2 never
  -- changes, §12.7 stable references). Recorded again here so the fact survives a read of
  -- this table alone.
  warrant_uuid         uuid not null unique,
  -- §12.5 federation record: which repository/subsystem authored it, and its local alias.
  repository           text not null check (length(btrim(repository)) between 1 and 200),
  local_alias          text check (local_alias is null or local_alias ~ '^[A-Z][A-Z0-9]*-WAR-[0-9]{4,}$'),
  profile              text not null check (profile in ('delivery', 'research', 'operations', 'governance')),
  assurance_level      text not null check (assurance_level in ('basic', 'controlled', 'high_assurance')),
  -- §24: phase lives in core.object.lifecycle_state; the other four dimensions are here.
  execution_condition  text not null default 'clear' check (execution_condition in ('clear', 'blocked', 'paused')),
  outcome              text not null default 'none'
    check (outcome in ('none', 'satisfied', 'not_satisfied', 'falsified', 'rejected', 'withdrawn', 'cancelled', 'inconclusive')),
  currency             text not null default 'current' check (currency in ('current', 'superseded', 'deprecated')),
  standing             text not null default 'valid' check (standing in ('valid', 'disputed', 'annulled')),
  -- Which contract revision is proposed / authorized right now (§28.1: identity persists
  -- across revisions).
  current_revision_no  integer check (current_revision_no is null or current_revision_no > 0),
  authorized_revision_no integer check (authorized_revision_no is null or authorized_revision_no > 0),
  superseded_by        uuid references core.object (id) on delete restrict,
  constraint warrant_uuid_is_identity check (warrant_uuid = id)
);

comment on table work.warrant is
  'OpenWarrant Warrant as institutional record (SAS §12, §24, §84). Phase is core.object.lifecycle_state; Git holds the source.';

-- §28: a revision is a snapshot with a digest and a basis. Proposed by submission, authorized
-- by authorization, each immutable, each naming its predecessor.
create table work.warrant_contract_revision (
  warrant_id            uuid not null references work.warrant (id) on delete restrict,
  revision_no           integer not null check (revision_no > 0),
  kind                  text not null check (kind in ('proposed', 'authorized', 'amendment_proposed', 'amendment_rejected')),
  -- §28.5 contract digest and §83.2/§28.4 exact Compilation Basis, as OpenWarrant computed them.
  -- KF records; it does not recompute — Git is Source Holder.
  contract_digest       text not null check (contract_digest ~ '^[0-9a-f]{64}$'),
  compilation_basis     text not null check (compilation_basis ~ '^[0-9a-f]{64}$'),
  -- The canonical IR at this revision (§83.5 immutable canonical snapshot).
  canonical_ir          jsonb not null,
  predecessor_no        integer check (predecessor_no is null or predecessor_no > 0),
  structured_difference jsonb,
  recorded_at           timestamptz not null default now(),
  recorded_by           uuid not null references org.person (id) on delete restrict,
  recorded_by_action    uuid not null references core.action (id) on delete restrict,
  -- §28.4, present on authorized revisions only.
  authorizer            uuid references org.person (id) on delete restrict,
  acting_role           uuid references org.role_assignment (id) on delete restrict,
  authorization_meaning text,
  policy_basis          text,
  effective_at          timestamptz,
  primary key (warrant_id, revision_no),
  constraint warrant_revision_authorization_complete check (
    (kind <> 'authorized' and authorizer is null and acting_role is null
      and authorization_meaning is null and policy_basis is null and effective_at is null)
    or (kind = 'authorized' and authorizer is not null and acting_role is not null
      and length(btrim(authorization_meaning)) > 0 and length(btrim(policy_basis)) > 0
      and effective_at is not null)
  ),
  constraint warrant_revision_predecessor_earlier
    check (predecessor_no is null or predecessor_no < revision_no),
  foreign key (warrant_id, predecessor_no) references work.warrant_contract_revision (warrant_id, revision_no)
);

comment on table work.warrant_contract_revision is
  'Immutable contract revisions (SAS §28): proposal and authorization snapshots with digest, basis and ancestry.';

create or replace function work.warrant_contract_revision_append_only() returns trigger
language plpgsql
as $$
begin
  raise exception 'warrant contract revisions are immutable (SAS §28.7): % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger warrant_contract_revision_append_only
  before update or delete on work.warrant_contract_revision
  for each row execute function work.warrant_contract_revision_append_only();

create index warrant_contract_revision_latest on work.warrant_contract_revision (warrant_id, revision_no desc);
create index warrant_by_alias on work.warrant (repository, local_alias);

alter table work.warrant enable row level security;
create policy warrant_scoped_read on work.warrant for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant.id)
  );
create policy warrant_scoped_insert on work.warrant for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant.id)
  );
create policy warrant_scoped_update on work.warrant for update
  using (exists (select 1 from core.object envelope where envelope.id = warrant.id))
  with check (exists (select 1 from core.object envelope where envelope.id = warrant.id));
create policy warrant_backup_read on work.warrant for select to kf_backup using (true);

alter table work.warrant_contract_revision enable row level security;
create policy warrant_contract_revision_scoped_read on work.warrant_contract_revision for select using (
    exists (select 1 from core.object envelope where envelope.id = warrant_contract_revision.warrant_id)
  );
create policy warrant_contract_revision_scoped_insert on work.warrant_contract_revision for insert with check (
    exists (select 1 from core.object envelope where envelope.id = warrant_contract_revision.warrant_id)
    and recorded_by = core.current_actor()
    and recorded_by_action = core.current_action_id()
  );
create policy warrant_contract_revision_backup_read on work.warrant_contract_revision
  for select to kf_backup using (true);

grant select on work.warrant, work.warrant_contract_revision
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert, update on work.warrant to kf_app;
grant insert on work.warrant_contract_revision to kf_app;

-- migrate:down

drop policy warrant_contract_revision_backup_read on work.warrant_contract_revision;
drop policy warrant_contract_revision_scoped_insert on work.warrant_contract_revision;
drop policy warrant_contract_revision_scoped_read on work.warrant_contract_revision;
drop policy warrant_backup_read on work.warrant;
drop policy warrant_scoped_update on work.warrant;
drop policy warrant_scoped_insert on work.warrant;
drop policy warrant_scoped_read on work.warrant;
drop trigger warrant_contract_revision_append_only on work.warrant_contract_revision;
drop function work.warrant_contract_revision_append_only();
drop table work.warrant_contract_revision;
drop table work.warrant;
