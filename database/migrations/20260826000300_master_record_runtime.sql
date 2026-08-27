-- migrate:up

-- OW-WAR-0054 STAGE-001 through STAGE-003.
--
-- A master record is an immutable claim about one permission enumeration at one point in
-- time. Its JSON manifest is the portable claim; the item and withholding rows make the claim
-- queryable without asking a renderer to reconstruct membership or invent an absence reason.
-- A new compilation appends a new master_record. Nothing updates an old claim in place.

create table content.master_record (
  id                         uuid primary key default uuidv7(),
  person_id                  uuid not null references org.person (id) on delete restrict,
  organization_id            uuid not null references org.organization (id) on delete restrict,
  compilation_run_id         uuid references content.compilation_run (id) on delete restrict,
  effective_classification   text not null references registry.classification (id),
  permission_digest          text not null check (permission_digest ~ '^[0-9a-f]{64}$'),
  record_digest              text not null unique check (record_digest ~ '^[0-9a-f]{64}$'),
  manifest                   jsonb not null check (jsonb_typeof(manifest) = 'object'),
  compiled_at                timestamptz not null,
  recorded_at                timestamptz not null default now(),
  recorded_by                uuid not null,
  recorded_by_action         uuid not null references core.action (id) on delete restrict,
  unique (person_id, organization_id, permission_digest)
);

create index master_record_latest
  on content.master_record (person_id, organization_id, compiled_at desc, recorded_at desc);

create table content.master_record_item (
  master_record_id  uuid not null references content.master_record (id) on delete restrict,
  object_id         uuid not null references core.object (id) on delete restrict,
  object_type       text not null,
  title             text not null check (length(btrim(title)) between 1 and 240),
  classification    text not null references registry.classification (id),
  content_digest    text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  section           text not null check (section in ('your_record', 'org_view', 'withdrawn')),
  item_state        text not null check (item_state in ('included', 'withdrawn')),
  withdrawn_at      timestamptz,
  withdrawal_reason text,
  primary key (master_record_id, object_id),
  constraint master_record_item_state_shape check (
    (item_state = 'included' and section in ('your_record', 'org_view')
      and withdrawn_at is null and withdrawal_reason is null)
    or
    (item_state = 'withdrawn' and section = 'withdrawn'
      and withdrawn_at is not null and withdrawal_reason is not null
      and length(btrim(withdrawal_reason)) > 0)
  )
);

create index master_record_item_section
  on content.master_record_item (master_record_id, section, object_type, object_id);

create table content.master_record_withholding (
  id               uuid primary key default uuidv7(),
  master_record_id uuid not null references content.master_record (id) on delete restrict,
  object_id        uuid references core.object (id) on delete restrict,
  reason_class     text not null check (reason_class in ('legal_hold', 'exclusion', 'third_party')),
  reason           text not null check (length(btrim(reason)) > 0),
  authorizer       uuid not null references org.person (id) on delete restrict,
  withheld_at      timestamptz not null,
  item_count       integer not null default 1 check (item_count > 0),
  constraint master_record_withholding_shape check (
    (reason_class = 'third_party' and object_id is null)
    or
    (reason_class in ('legal_hold', 'exclusion') and object_id is not null and item_count = 1)
  )
);

create unique index master_record_withholding_item
  on content.master_record_withholding
    (master_record_id, object_id, reason_class, reason, withheld_at)
  where object_id is not null;

comment on table content.master_record is
  'Immutable permission enumeration claim for exactly one person and organization. The manifest '
  'digest must equal the included item set; newer compilations append, never rewrite.';
comment on table content.master_record_item is
  'Membership and presentation split. Every permitted object is included; relevance selects '
  'your_record versus org_view, while withdrawn objects remain named with a reason.';
comment on table content.master_record_withholding is
  'Subtractive entitlement ledger. Legal holds and exclusions identify items; third-party '
  'material is represented only by a count and reason class.';

create trigger master_record_append_only
  before update or delete or truncate on content.master_record
  for each statement execute function core.refuse_mutation();
create trigger master_record_item_append_only
  before update or delete or truncate on content.master_record_item
  for each statement execute function core.refuse_mutation();
create trigger master_record_withholding_append_only
  before update or delete or truncate on content.master_record_withholding
  for each statement execute function core.refuse_mutation();

alter table content.master_record enable row level security;
alter table content.master_record force row level security;
create policy master_record_scope on content.master_record
  for select using (
    organization_id = core.current_organization()
    and effective_classification in (
      select c.id from registry.classification c
       where c.rank <= core.current_classification_rank()
    )
  );
create policy master_record_insert on content.master_record
  for insert with check (
    organization_id = core.current_organization()
    and exists (
      select 1 from org.person person
       where person.id = master_record.person_id
         and person.organization = master_record.organization_id
    )
    and recorded_by = core.current_actor()
    and recorded_by_action = core.current_action_id()
    and not exists (select 1 from core.audit_event event where event.action_id = recorded_by_action)
    and effective_classification in (
      select c.id from registry.classification c
       where c.rank <= core.current_classification_rank()
    )
  );
create policy master_record_backup_read on content.master_record
  for select to kf_backup using (true);

alter table content.master_record_item enable row level security;
alter table content.master_record_item force row level security;
create policy master_record_item_scope on content.master_record_item
  for select using (exists (
    select 1 from content.master_record master
     where master.id = master_record_item.master_record_id
  ));
create policy master_record_item_insert on content.master_record_item
  for insert with check (exists (
    select 1 from content.master_record master
     where master.id = master_record_item.master_record_id
       and master.recorded_by = core.current_actor()
       and master.recorded_by_action = core.current_action_id()
       and not exists (
         select 1 from core.audit_event event where event.action_id = master.recorded_by_action
       )
       and (
         (master_record_item.item_state = 'included'
          and exists (
            select 1
              from jsonb_array_elements(master.manifest -> 'included') member
             where member ->> 'objectId' = master_record_item.object_id::text
               and member ->> 'objectType' = master_record_item.object_type
               and member ->> 'contentDigest' = master_record_item.content_digest
          )
          and (
            (master_record_item.section = 'your_record'
             and (master.manifest -> 'sections' -> 'yourRecord') ? master_record_item.object_id::text)
            or
            (master_record_item.section = 'org_view'
             and (master.manifest -> 'sections' -> 'organizationView') ? master_record_item.object_id::text)
          ))
         or
         (master_record_item.item_state = 'withdrawn'
          and exists (
            select 1
              from jsonb_array_elements(master.manifest -> 'withdrawn') member
             where member ->> 'objectId' = master_record_item.object_id::text
               and member ->> 'objectType' = master_record_item.object_type
               and member ->> 'contentDigest' = master_record_item.content_digest
          ))
       )
  ));
create policy master_record_item_backup_read on content.master_record_item
  for select to kf_backup using (true);

alter table content.master_record_withholding enable row level security;
alter table content.master_record_withholding force row level security;
create policy master_record_withholding_scope on content.master_record_withholding
  for select using (exists (
    select 1 from content.master_record master
     where master.id = master_record_withholding.master_record_id
  ));
create policy master_record_withholding_insert on content.master_record_withholding
  for insert with check (exists (
    select 1 from content.master_record master
     where master.id = master_record_withholding.master_record_id
       and master.recorded_by = core.current_actor()
       and master.recorded_by_action = core.current_action_id()
       and not exists (
         select 1 from core.audit_event event where event.action_id = master.recorded_by_action
       )
       and (
         (master_record_withholding.reason_class in ('legal_hold', 'exclusion')
          and exists (
            select 1
              from jsonb_array_elements(master.manifest -> 'withheld' -> 'items') item
             where item ->> 'objectId' = master_record_withholding.object_id::text
               and item ->> 'reasonClass' = master_record_withholding.reason_class
               and item ->> 'reason' = master_record_withholding.reason
               and item ->> 'authorizer' = master_record_withholding.authorizer::text
               and item ->> 'withheldAt' = to_char(
                 master_record_withholding.withheld_at at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               )
          ))
         or
         (master_record_withholding.reason_class = 'third_party'
          and coalesce(
            (master.manifest -> 'withheld' -> 'thirdPartyCounts' ->> master_record_withholding.reason_class)::integer,
            0
          ) >= master_record_withholding.item_count)
       )
  ));
create policy master_record_withholding_backup_read on content.master_record_withholding
  for select to kf_backup using (true);

grant select, insert on content.master_record, content.master_record_item,
  content.master_record_withholding to kf_app, kf_worker;
grant select on content.master_record, content.master_record_item,
  content.master_record_withholding to kf_readonly, kf_auditor, kf_backup;
grant usage, select on all sequences in schema content to kf_app, kf_worker;

-- migrate:down
-- kf:forward-only master-record claims and withholding evidence must not be downgraded into silent omissions
