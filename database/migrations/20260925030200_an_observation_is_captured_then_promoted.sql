-- migrate:up

-- ADR 0034 (proposed): an observation is captured in one gesture, and promoted by a separate act.
--
-- ADR 0024 decided capture is cheap and governance is on promotion, and that an observation
-- enters "as an ordinary object in a draft lifecycle state". It did not name the type, so nothing
-- could be captured. The ontology now declares `observation` (captured -> promoted | withdrawn)
-- and three acts; this is its typed row.
--
-- The row IS the object, as for every typed table: its visibility defers to the envelope, row
-- security is forced (20260924000200), and the application may insert and never update. Promotion
-- and withdrawal are lifecycle moves on core.object; nothing about what was observed changes after
-- capture, so there is no update grant to misuse. What it concerns is `concerns` relations from the
-- observation, not a column here.
--
-- `body_sha256` is derived, never written: it is half of the server-formed idempotency key
-- (gesture id plus body digest, ADR 0034 §2), and deriving it here means the key a replay is
-- matched on and the body stored cannot disagree. A trigger rather than a generated column,
-- because `convert_to` is not immutable; the trigger overwrites whatever a writer supplied, and
-- the application is granted no insert on the column at all.

create function content.observation_tags_valid(p_tags text[]) returns boolean
language sql
immutable
strict
parallel safe
as $$
  select coalesce(bool_and(t ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'), true)
         and count(*) = count(distinct t)
    from unnest(p_tags) as t
$$;

comment on function content.observation_tags_valid(text[]) is
  'The envelope tags grammar (ontology/meta.yaml): each tag matches ^[a-z0-9][a-z0-9_.-]{0,63}$, '
  'and no tag appears twice.';

create table content.observation (
  id          uuid primary key references core.object (id) on delete restrict,
  body        text not null check (length(btrim(body)) between 1 and 20000),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz not null default now(),
  tags        text[] not null default '{}' check (content.observation_tags_valid(tags))
);

-- The row is an observation (KF-SAS-RQ-030, 20260925012000).
alter table content.observation
  add column object_type text generated always as ('observation') stored,
  add constraint observation_is_observation
    foreign key (id, object_type) references core.object (id, object_type);

create function content.observation_body_digest() returns trigger
language plpgsql
set search_path = pg_catalog, content
as $$
begin
  new.body_sha256 := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');
  return new;
end
$$;

create trigger observation_body_digest
  before insert on content.observation
  for each row execute function content.observation_body_digest();

comment on table content.observation is
  'ADR 0034: what somebody observed, captured by record_observation and promoted by '
  'promote_observation. Insert-only; its subjects are `concerns` relations.';

create index observation_by_time on content.observation (observed_at);

alter table content.observation enable row level security;
alter table content.observation force row level security;
create policy observation_scoped_read on content.observation for select using (
    exists (select 1 from core.object envelope where envelope.id = observation.id)
  );
create policy observation_scoped_insert on content.observation for insert with check (
    exists (select 1 from core.object envelope where envelope.id = observation.id)
  );
create policy observation_backup_read on content.observation for select to kf_backup using (true);

grant select on content.observation to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert (id, body, observed_at, tags) on content.observation to kf_app;

-- Every table the application can write belongs to an act (20260925011000): attach the act write
-- guard to the tables above, which did not exist when that migration swept the catalog.
select core.install_action_context_guards();

-- migrate:down

drop table content.observation;
drop function content.observation_body_digest();
drop function content.observation_tags_valid(text[]);
