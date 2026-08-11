-- migrate:up

-- Search: PostgreSQL full text and trigram, over a DERIVED index.
--
-- Two decisions, both deliberate.
--
-- First, no `pgvector`, and not because embeddings are useless. A semantic index cannot be
-- audited, cannot explain why it returned what it returned, and cannot be reproduced from the
-- records after a restore. Canonical search has to work first — an auditor asking "show me
-- every record citing SOP-QMS-012" needs an answer that is exhaustive and explicable, not one
-- that is usually about right. Embeddings can be added later, ON TOP, and the shape here is
-- what makes that safe: this table is derivable, so a second index alongside it changes
-- nothing about where authority lives.
--
-- Second, the index is DERIVED and DISPOSABLE. Nothing here is a source of truth: every row
-- is rebuildable from core.object and the typed tables, and `search.rebuild()` does exactly
-- that. A search index that could not be dropped and rebuilt would be a second copy of the
-- records with its own drift, which is the thing the federation boundary exists to prevent —
-- and it would be strange to enforce that against other systems and not against ourselves.

create schema if not exists search;

create table search.document (
  object_id      uuid primary key references core.object (id) on delete cascade,
  -- Denormalised for filtering without joining back. Refreshed by rebuild, never edited.
  object_type    text not null,
  organization_id uuid not null,
  classification text not null references registry.classification (id),
  lifecycle_state text not null,
  title          text not null,
  -- Everything worth matching on, flattened. Built by `search.text_for`, so what is
  -- searchable is one function rather than scattered across callers.
  body           text not null,
  document       tsvector not null,
  indexed_at     timestamptz not null default now()
);

create index search_document_fts on search.document using gin (document);
-- Trigram for the queries full text is bad at: partial identifiers, part numbers, someone
-- half-remembering "CNB-22". A tokeniser splits those in ways nobody expects.
create index search_document_trgm on search.document using gin (title gin_trgm_ops);
create index search_document_body_trgm on search.document using gin (body gin_trgm_ops);
create index search_document_by_org on search.document (organization_id, object_type);

/*
 * The searchable text for one object.
 *
 * SECURITY DEFINER with a pinned search_path, for the same reason the financial triggers
 * are: the index must cover every record, and text assembled from only the rows the CALLER
 * can see would silently index a subset — producing an index that looks complete and is not.
 *
 * Classification is enforced at QUERY time instead, which is the correct place: one index,
 * many audiences.
 */
create or replace function search.text_for(p_object uuid) returns text
language plpgsql
stable
security definer
set search_path = core, work, finance, product, quality, engineering, org, content, registry, pg_catalog
as $$
declare
  v_text text;
begin
  select concat_ws(' ',
      o.title,
      o.enterprise_id,
      o.object_type,
      o.lifecycle_state,
      -- Per-domain detail. Left joins throughout: an object with no typed row is still
      -- indexed on its envelope rather than dropped, because a record that cannot be found
      -- is a record that does not exist to the person looking for it.
      p.project_code, p.objective,
      wp.scope_statement, wp.acceptance_criterion,
      wo.order_number, wo.scope_summary,
      we.summary,
      ci.part_number, ci.revision_label,
      ic.generation, ic.specification,
      pb.serial_number, pb.location,
      cd.document_number, cd.revision,
      nc.description, nc.containment,
      cp.problem_statement, cp.root_cause, cp.effectiveness_criterion,
      cmp.summary,
      rc.description,
      td.acceptance_criterion,
      te.result_summary, te.invalidated_because,
      dr.summary
    )
    into v_text
    from core.object o
    left join work.initiative_project p on p.id = o.id
    left join work.work_package wp on wp.id = o.id
    left join work.work_order wo on wo.id = o.id
    left join work.work_execution we on we.id = o.id
    left join product.configuration_item ci on ci.id = o.id
    left join product.interface_contract ic on ic.id = o.id
    left join product.physical_binding pb on pb.id = o.id
    left join quality.controlled_document cd on cd.id = o.id
    left join quality.nonconformity nc on nc.id = o.id
    left join quality.capa cp on cp.id = o.id
    left join quality.complaint cmp on cmp.id = o.id
    left join engineering.risk_control rc on rc.id = o.id
    left join engineering.test_definition td on td.id = o.id
    left join engineering.test_execution te on te.id = o.id
    left join engineering.decision_alternative dr on dr.decision_id = o.id
   where o.id = p_object;

  return coalesce(v_text, '');
end
$$;

/** Index or re-index one object. Idempotent, so a replayed outbox row costs nothing. */
create or replace function search.index_object(p_object uuid) returns void
language plpgsql
security definer
set search_path = core, search, registry, pg_catalog
as $$
declare
  v_body text := search.text_for(p_object);
begin
  insert into search.document
    (object_id, object_type, organization_id, classification, lifecycle_state, title, body,
     document, indexed_at)
  select o.id, o.object_type, o.organization_id, o.classification, o.lifecycle_state,
         o.title, v_body,
         -- Title weighted above body: someone searching for a part number means the record
         -- called that, not every record mentioning it.
         setweight(to_tsvector('english', coalesce(o.title, '')), 'A')
           || setweight(to_tsvector('english', v_body), 'B'),
         now()
    from core.object o
   where o.id = p_object
  on conflict (object_id) do update
    set object_type = excluded.object_type,
        organization_id = excluded.organization_id,
        classification = excluded.classification,
        lifecycle_state = excluded.lifecycle_state,
        title = excluded.title,
        body = excluded.body,
        document = excluded.document,
        indexed_at = now();
end
$$;

/**
 * Rebuild the whole index from the records.
 *
 * This is the function that makes the index disposable, and disposable is the property that
 * keeps it from becoming a second source of truth. If this ever stops working, the index has
 * quietly become data.
 */
create or replace function search.rebuild() returns bigint
language plpgsql
security definer
set search_path = core, search, registry, pg_catalog
as $$
declare
  v_count bigint := 0;
  v_id uuid;
begin
  delete from search.document;
  for v_id in select id from core.object loop
    perform search.index_object(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- Query-time visibility. The index holds everything; who may see what is decided here, on
-- the same two axes as core.object's row-level security.
grant usage on schema search to kf_app, kf_worker, kf_readonly, kf_auditor;
grant select on search.document to kf_app, kf_worker, kf_readonly, kf_auditor;
grant execute on function search.index_object(uuid) to kf_app, kf_worker;
grant execute on function search.rebuild() to kf_worker;
-- Deliberately NOT granted to kf_app: a rebuild is an operator action, and an application
-- that could trigger one could make itself very slow on request.

comment on schema search is
  'Derived, disposable index. Nothing here is a source of truth; search.rebuild() reconstructs '
  'every row from core.object and the typed tables.';

-- migrate:down

drop function if exists search.rebuild();
drop function if exists search.index_object(uuid);
drop function if exists search.text_for(uuid);
drop table if exists search.document;
drop schema if exists search;
