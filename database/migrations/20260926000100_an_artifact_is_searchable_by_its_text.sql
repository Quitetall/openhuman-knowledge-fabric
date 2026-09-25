-- migrate:up

-- An artifact is searchable by the text its own parse extracted (SAS §52, §64).
--
-- `search.text_for` added parsed text for one kind of record only: a controlled document, through
-- its `content_version`. Every file that entered through `attach_evidence` — `kf ingest`,
-- `POST /ingest` — was indexed by its title and nothing else, although `attach_evidence` parses
-- the file and stores its atoms in the same act. Measured on the first corpus-sized fixture
-- (1 004 PDFs and their extracted text, 2026-09-24): a search for a phrase from a document's body
-- found nothing, and every hit was a title match.
--
-- The atoms of the artifact's NEWEST version that has a parse are the ones indexed: a record is
-- found by what it says now, the way a controlled document is found by its current content. An
-- artifact whose versions have no parse (a PDF, which the pandoc parser does not read) is still
-- indexed by its title alone; its text reaches search only as a separate, derived artifact.
--
-- Nothing is re-indexed here. The index is disposable: `search.rebuild()` (the worker's login)
-- reconstructs it, and every later act re-indexes what it touches through the outbox.

create or replace function search.text_for(p_object uuid) returns text
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
    ),
    (
      select string_agg(a.text_content, ' ' order by a.ordinal)
        from content.document_atom a
       where a.parse_id = (
         select p.id
           from content.artifact_version v
           join content.document_parse p on p.artifact_version_id = v.id
          where v.artifact_id = p_object
          order by v.version_no desc, p.created_at desc, p.id desc
          limit 1
       )
    )
  )
$$;

comment on function search.text_for(uuid) is
  'What the search index holds for a record: its structured fields, a controlled document''s '
  'current content, and an artifact''s newest parsed text (20260926000100).';

-- migrate:down

create or replace function search.text_for(p_object uuid) returns text
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
