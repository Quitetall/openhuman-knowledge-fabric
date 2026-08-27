-- migrate:up

-- OW-WAR-0054 STAGE-004. A link is a capability receipt, not a second document store. The
-- token is never persisted in clear; only its digest and immutable scope are retained. Access
-- and delivery records are append-only so a link can be revoked without rewriting history.

create table content.master_record_link (
  id               uuid primary key default uuidv7(),
  master_record_id  uuid not null references content.master_record (id) on delete restrict,
  token_digest     text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  scope            jsonb not null check (jsonb_typeof(scope) = 'object'),
  issued_at        timestamptz not null,
  expires_at       timestamptz not null,
  issued_by        uuid not null references org.person (id) on delete restrict,
  issued_by_action uuid not null references core.action (id) on delete restrict,
  constraint master_record_link_expiry check (expires_at > issued_at)
);

create table content.master_record_link_revocation (
  link_id          uuid primary key references content.master_record_link (id) on delete restrict,
  revoked_at       timestamptz not null default now(),
  revoked_by        uuid not null references org.person (id) on delete restrict,
  revoked_by_action uuid not null references core.action (id) on delete restrict,
  reason           text not null check (length(btrim(reason)) > 0)
);

create table content.master_record_delivery_receipt (
  id               uuid primary key default uuidv7(),
  link_id          uuid not null references content.master_record_link (id) on delete restrict,
  action_id        uuid not null references core.action (id) on delete restrict,
  delivery_status  text not null check (delivery_status in ('queued', 'delivered', 'failed')),
  payload_digest   text not null check (payload_digest ~ '^[0-9a-f]{64}$'),
  recorded_at      timestamptz not null default now(),
  detail           jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  unique (link_id, action_id)
);

create table content.master_record_link_access (
  id             uuid primary key default uuidv7(),
  link_id        uuid not null references content.master_record_link (id) on delete restrict,
  accessed_at    timestamptz not null default now(),
  requester_hash text,
  result         text not null check (result in ('served', 'expired', 'revoked', 'invalid', 'stale')),
  record_digest  text check (record_digest is null or record_digest ~ '^[0-9a-f]{64}$'),
  detail         jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object')
);

create index master_record_link_active
  on content.master_record_link (master_record_id, expires_at);
create index master_record_link_access_by_link
  on content.master_record_link_access (link_id, accessed_at desc);

-- Worker delivery runs without a person/organization access context. Keep the receipt
-- append-only and expose one narrow definer operation instead of granting the worker
-- arbitrary insert authority over capability evidence.
create or replace function content.record_master_record_link_delivery(
  p_link_id uuid,
  p_action_id uuid,
  p_payload_digest text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
begin
  if p_payload_digest is null or p_payload_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'master-record delivery payload digest is malformed'
      using errcode = 'invalid_parameter_value';
  end if;
  if not exists (
    select 1 from content.master_record_link link where link.id = p_link_id
  ) then
    raise exception 'master-record link does not exist'
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1 from core.action action where action.id = p_action_id
  ) then
    raise exception 'delivery action does not exist'
      using errcode = 'foreign_key_violation';
  end if;
  if not exists (
    select 1
      from content.master_record_link link
      join core.outbox outbox on outbox.action_id = p_action_id
     where link.id = p_link_id
       and link.issued_by_action = p_action_id
       and outbox.topic = 'kf.master_record_link_issued'
       and outbox.payload ->> 'link_id' = p_link_id::text
       and outbox.payload ->> 'action_id' = p_action_id::text
       and outbox.payload ->> 'payload_digest' = p_payload_digest
  ) then
    raise exception 'delivery receipt has no matching link-issued outbox event'
      using errcode = 'foreign_key_violation';
  end if;
  insert into content.master_record_delivery_receipt
    (link_id, action_id, delivery_status, payload_digest, detail)
  values (p_link_id, p_action_id, 'delivered', p_payload_digest,
          '{"handler":"kf-worker"}'::jsonb)
  on conflict (link_id, action_id) do nothing;
end;
$$;

revoke all on function content.record_master_record_link_delivery(uuid, uuid, text) from public;
grant execute on function content.record_master_record_link_delivery(uuid, uuid, text) to kf_worker;

-- Token lookup intentionally crosses RLS only after the caller presents a digest of a
-- cryptographically signed capability. The function returns no item content and route code
-- must still compare signed claims, expiry and revocation before setting read context.
create or replace function content.resolve_master_record_link(p_token_digest text)
returns table (
  link_id              uuid,
  master_record_id     uuid,
  organization_id      uuid,
  effective_classification text,
  scope                jsonb,
  issued_at            timestamptz,
  expires_at           timestamptz,
  revoked              boolean,
  record_digest        text
)
language sql
stable
security definer
set search_path = pg_catalog, content
as $$
  select link.id, master.id, master.organization_id, master.effective_classification,
         link.scope, link.issued_at, link.expires_at,
         exists (select 1 from content.master_record_link_revocation revoked
                  where revoked.link_id = link.id),
         master.record_digest
    from content.master_record_link link
    join content.master_record master on master.id = link.master_record_id
   where link.token_digest = p_token_digest
$$;

revoke all on function content.resolve_master_record_link(text) from public;
grant execute on function content.resolve_master_record_link(text) to kf_app;

comment on table content.master_record_link is
  'Signed, expiring capability. Clear token exists only at issuance/transport; token_digest '
  'and immutable scope are the durable facts.';
comment on table content.master_record_delivery_receipt is
  'Outbox consumer receipt. Delivery is at-least-once and never changes master-record authority.';
comment on table content.master_record_link_access is
  'Append-only link access log. Invalid, expired, revoked and stale attempts remain observable.';

create trigger master_record_link_append_only
  before update or delete or truncate on content.master_record_link
  for each statement execute function core.refuse_mutation();
create trigger master_record_link_revocation_append_only
  before update or delete or truncate on content.master_record_link_revocation
  for each statement execute function core.refuse_mutation();
create trigger master_record_delivery_receipt_append_only
  before update or delete or truncate on content.master_record_delivery_receipt
  for each statement execute function core.refuse_mutation();
create trigger master_record_link_access_append_only
  before update or delete or truncate on content.master_record_link_access
  for each statement execute function core.refuse_mutation();

alter table content.master_record_link enable row level security;
alter table content.master_record_link force row level security;
create policy master_record_link_scope on content.master_record_link
  for select using (exists (
    select 1 from content.master_record master
     where master.id = master_record_link.master_record_id
  ));
create policy master_record_link_insert on content.master_record_link
  for insert with check (exists (
    select 1 from content.master_record master
     where master.id = master_record_link.master_record_id
       and master_record_link.issued_by = core.current_actor()
       and master_record_link.issued_by_action = core.current_action_id()
  ));
create policy master_record_link_backup_read on content.master_record_link
  for select to kf_backup using (true);

alter table content.master_record_link_revocation enable row level security;
alter table content.master_record_link_revocation force row level security;
create policy master_record_link_revocation_scope on content.master_record_link_revocation
  for select using (exists (
    select 1 from content.master_record_link link
     where link.id = master_record_link_revocation.link_id
  ));
create policy master_record_link_revocation_insert on content.master_record_link_revocation
  for insert with check (exists (
    select 1 from content.master_record_link link
     where link.id = master_record_link_revocation.link_id
       and master_record_link_revocation.revoked_by = core.current_actor()
       and master_record_link_revocation.revoked_by_action = core.current_action_id()
  ));
create policy master_record_link_revocation_backup_read on content.master_record_link_revocation
  for select to kf_backup using (true);

alter table content.master_record_delivery_receipt enable row level security;
alter table content.master_record_delivery_receipt force row level security;
create policy master_record_delivery_scope on content.master_record_delivery_receipt
  for select using (exists (
    select 1 from content.master_record_link link
    join content.master_record master on master.id = link.master_record_id
     where link.id = master_record_delivery_receipt.link_id
  ));
create policy master_record_delivery_insert on content.master_record_delivery_receipt
  for insert with check (exists (
    select 1 from content.master_record_link link
     where link.id = master_record_delivery_receipt.link_id
  ));
create policy master_record_delivery_backup_read on content.master_record_delivery_receipt
  for select to kf_backup using (true);

alter table content.master_record_link_access enable row level security;
alter table content.master_record_link_access force row level security;
create policy master_record_link_access_scope on content.master_record_link_access
  for select using (exists (
    select 1 from content.master_record_link link
     where link.id = master_record_link_access.link_id
  ));
create policy master_record_link_access_insert on content.master_record_link_access
  for insert with check (exists (
    select 1 from content.master_record_link link
     where link.id = master_record_link_access.link_id
  ));
create policy master_record_link_access_backup_read on content.master_record_link_access
  for select to kf_backup using (true);

grant select on content.master_record_link, content.master_record_link_revocation,
  content.master_record_delivery_receipt, content.master_record_link_access
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on content.master_record_link, content.master_record_link_revocation,
  content.master_record_link_access to kf_app;
grant usage, select on all sequences in schema content to kf_app, kf_worker;

-- migrate:down
-- kf:forward-only revoking delivery primitives would remove access history and capability evidence
