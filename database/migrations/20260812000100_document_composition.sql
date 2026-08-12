-- migrate:up

-- Document composition: immutable source bytes become ordered, independently digested atoms.
--
-- These rows are a projection, not a second authority. `artifact_version_id` points at bytes
-- whose SHA-256 was verified by the server; deleting and reparsing those bytes must reproduce
-- the same ordered claims and `content_digest`.

create table content.document_parse (
  id                  uuid primary key default uuidv7(),
  artifact_version_id uuid not null unique
    references content.artifact_version (id) on delete restrict,
  parser              text not null check (length(btrim(parser)) > 0),
  parser_version      text not null check (length(btrim(parser_version)) > 0),
  content_digest      text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz not null default now(),
  created_by          uuid not null,
  created_by_action   uuid not null references core.action (id) on delete restrict
);

create table content.document_atom (
  id              uuid primary key default uuidv7(),
  parse_id        uuid not null references content.document_parse (id) on delete restrict,
  ordinal         integer not null check (ordinal > 0),
  atom_kind       text not null check (atom_kind in (
    'heading', 'paragraph', 'list_item', 'quote', 'code', 'table', 'horizontal_rule'
  )),
  heading_level   integer check (heading_level between 1 and 9),
  text_content    text not null,
  attributes      jsonb not null default '{}'::jsonb,
  atom_digest     text not null check (atom_digest ~ '^[0-9a-f]{64}$'),
  unique (parse_id, ordinal)
);

create index document_atom_by_parse on content.document_atom (parse_id, ordinal);
create index document_atom_text on content.document_atom
  using gin (to_tsvector('english', text_content));

-- Parsed rows never change. A parser upgrade creates a new artifact version and parse, making
-- the old interpretation reproducible instead of silently rewriting what an approval saw.
create trigger document_parse_append_only
  before update or delete or truncate on content.document_parse
  for each statement execute function core.refuse_mutation();

create trigger document_atom_append_only
  before update or delete or truncate on content.document_atom
  for each statement execute function core.refuse_mutation();

-- Parsed text carries the source document's confidentiality. Direct table reads must cross
-- the same organization/classification boundary as the artifact envelope; otherwise an app
-- login could bypass core.object RLS by selecting atoms directly.
alter table content.document_parse enable row level security;
alter table content.document_parse force row level security;

create policy document_parse_read on content.document_parse
  for select
  using (
    exists (
      select 1
        from content.artifact_version v
        join content.artifact a on a.id = v.artifact_id
        join core.object o on o.id = a.id
       where v.id = document_parse.artifact_version_id
    )
  );

create policy document_parse_insert on content.document_parse
  for insert
  with check (
    exists (
      select 1
        from content.artifact_version v
        join content.artifact a on a.id = v.artifact_id
        join core.object o on o.id = a.id
       where v.id = document_parse.artifact_version_id
    )
  );

alter table content.document_atom enable row level security;
alter table content.document_atom force row level security;

create policy document_atom_read on content.document_atom
  for select
  using (
    exists (select 1 from content.document_parse p where p.id = document_atom.parse_id)
  );

create policy document_atom_insert on content.document_atom
  for insert
  with check (
    exists (select 1 from content.document_parse p where p.id = document_atom.parse_id)
  );

grant select on content.document_parse, content.document_atom
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on content.document_parse, content.document_atom to kf_app;

-- Compose parsed text into the existing disposable search projection without copying the
-- whole original function. The old function remains one auditable atom; this wrapper is the
-- document contribution. `search.index_object` resolves this name when it runs.
alter function search.text_for(uuid) rename to text_for_structured_record;

create function search.text_for(p_object uuid) returns text
language sql
stable
security definer
set search_path = core, quality, content, search, pg_catalog
as $$
  select concat_ws(' ',
    search.text_for_structured_record(p_object),
    (
      select string_agg(a.text_content, ' ' order by a.ordinal)
        from quality.controlled_document d
        join content.document_parse p on p.artifact_version_id = d.content_version
        join content.document_atom a on a.parse_id = p.id
       where d.id = p_object
    )
  )
$$;

comment on table content.document_atom is
  'Rebuildable, ordered document atoms. Source authority remains the verified artifact version.';

-- migrate:down

drop function search.text_for(uuid);
alter function search.text_for_structured_record(uuid) rename to text_for;
drop table content.document_atom;
drop table content.document_parse;
