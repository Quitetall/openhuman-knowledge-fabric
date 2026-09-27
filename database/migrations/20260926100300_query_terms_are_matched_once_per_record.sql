-- migrate:up

-- A query's terms are matched without evaluating row security once per term per record
-- (20260926100000 measured at scale).
--
-- WHAT WAS WRONG. `search.lexical_matches` found each term's records with its own index scan of
-- `search.document`, and row security evaluated `search_document_read` — an EXISTS over
-- `core.object`, whose own policy runs in turn — for every row of every scan. On the
-- multi-organization fixture a 19-term question touched ~280 000 rows that way and took 9-13 s
-- under the application login, against 0.5 s for the same statement without the per-row policy.
--
-- THE FIX. `search.term_hits` finds, per term, the records of the CALLER'S OWN bound
-- organization at or below the CALLER'S OWN bound ceiling — read from the sealed context
-- (core.current_organization(), core.current_classification_rank()), never from an argument —
-- with the predicate of `core.object`'s read policy written as a join on `core.object`: the same
-- records row security admits, found once per term by the GIN index and filtered by a join
-- rather than by a subplan per row. It is SECURITY DEFINER only so that the join, not the policy,
-- does the filtering; it can name no organization and raise no ceiling, returns ids and a term
-- number and nothing else, and returns nothing to a session with no context bound.
--
-- `search.lexical_matches` stays security invoker. It scores from those hits and then keeps only
-- records it can read through `search.document` under row security — the policy still decides,
-- once per matching record instead of once per term per record — and still applies the explicit
-- organization and ceiling predicate of its arguments.

create function search.term_hits(
  p_terms            tsquery[],
  p_object_types     text[],
  p_lifecycle_states text[],
  p_only             uuid[]
) returns table (term integer, object_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, core, search, registry
as $$
  -- One GIN bitmap scan per term, then one join to core.object for all of them. The lateral
  -- subquery carries OFFSET 0 and the hits are MATERIALIZED so the planner cannot flatten them:
  -- flattened, the term becomes a join filter checked against every record's vector (1.4 s
  -- instead of 0.3 s for an 11-term question at 50 000 records).
  with context as (
    select core.current_organization() as organization,
           core.current_classification_rank() as ceiling
  ),
  hits as materialized (
    select t.i::integer as i, h.object_id
      from unnest(p_terms) with ordinality as t(q, i)
     cross join context
     cross join lateral (
       select d.object_id
         from search.document d
        where d.document @@ t.q
          and d.organization_id = context.organization
          and (p_object_types is null or d.object_type = any(p_object_types))
          and (p_lifecycle_states is null or d.lifecycle_state = any(p_lifecycle_states))
          and (p_only is null or d.object_id = any(p_only))
       offset 0
     ) h
     where context.organization is not null
  )
  select hits.i, hits.object_id
    from hits
    join core.object o on o.id = hits.object_id
    join registry.classification c on c.id = o.classification
   cross join context
   where o.organization_id = context.organization
     and c.rank <= context.ceiling
$$;

/** How many records of the caller's own bound scope a query is weighed against (BM25's N). */
create function search.scope_size(
  p_object_types     text[],
  p_lifecycle_states text[],
  p_only             uuid[]
) returns bigint
language sql
stable
security definer
set search_path = pg_catalog, core, search, registry
as $$
  select count(*)
    from search.document d
    join core.object o on o.id = d.object_id
    join registry.classification c on c.id = o.classification
   where o.organization_id = core.current_organization()
     and c.rank <= core.current_classification_rank()
     and (p_object_types is null or d.object_type = any(p_object_types))
     and (p_lifecycle_states is null or d.lifecycle_state = any(p_lifecycle_states))
     and (p_only is null or d.object_id = any(p_only))
$$;

revoke all on function search.term_hits(tsquery[], text[], text[], uuid[]) from public;
revoke all on function search.scope_size(text[], text[], uuid[]) from public;
grant execute on function search.term_hits(tsquery[], text[], text[], uuid[]) to kf_app, kf_worker;
grant execute on function search.scope_size(text[], text[], uuid[]) to kf_app, kf_worker;

comment on function search.term_hits(tsquery[], text[], text[], uuid[]) is
  'Per query term, the ids of the bound caller''s own records matching it, filtered by a join '
  'equal to core.object''s read policy; organization and ceiling come from the sealed context '
  'only (20260926100300).';

create or replace function search.lexical_matches(
  p_organization     uuid,
  p_ceiling          text,
  p_text             text,
  p_object_types     text[],
  p_lifecycle_states text[],
  p_only             uuid[]
) returns table (object_id uuid, classification text, coverage double precision, matched_by text)
language sql
stable
security invoker
set search_path = pg_catalog, search, registry
as $$
  with terms as (
    select t.ordinality::integer as i, t.variants as q
      from search.query_terms(p_text) with ordinality as t(term, variants, ordinality)
     where t.variants is not null
  ),
  ceiling as (
    select rank from registry.classification where id = p_ceiling
  ),
  scope as materialized (
    -- Materialized: inlined, the count is re-evaluated for every term.
    select search.scope_size(p_object_types, p_lifecycle_states, p_only)::double precision as n
  ),
  term_hits as (
    select h.term as i, h.object_id
      from search.term_hits(
             array(select q from terms order by i), p_object_types, p_lifecycle_states, p_only
           ) h
  ),
  frequency as (
    select i, count(*)::double precision as df from term_hits group by i
  ),
  weight as (
    -- BM25's inverse document frequency, which stays positive for a term every record holds.
    select t.i,
           ln(1 + (s.n - coalesce(f.df, 0) + 0.5) / (coalesce(f.df, 0) + 0.5)) as w
      from terms t cross join scope s left join frequency f on f.i = t.i
  ),
  total as (
    select sum(w) as w from weight
  ),
  scored as (
    select h.object_id, sum(w.w) / (select w from total) as coverage
      from term_hits h
      join weight w on w.i = h.i
     group by h.object_id
    having sum(w.w) * 2 >= (select w from total)
  ),
  full_text as (
    -- Row security decides here, once per matching record, and the explicit predicate of the
    -- arguments is applied as @kf/search always has.
    select d.object_id, d.classification, s.coverage
      from scored s
      join search.document d on d.object_id = s.object_id
      join registry.classification c on c.id = d.classification
     where d.organization_id = p_organization
       and c.rank <= (select rank from ceiling)
  ),
  needle as (
    -- ILIKE patterns are not search syntax. Escape their metacharacters so an identifier such as
    -- LOT_A7 or ZX%Q stays literal instead of widening into a wildcard scan.
    select replace(replace(replace(p_text, '!', '!!'), '%', '!%'), '_', '!_') as pattern
  ),
  partial as (
    select d.object_id, d.classification,
           greatest(public.similarity(d.title, p_text), public.similarity(d.body, p_text)) * 0.49
             as coverage
      from search.document d
      join registry.classification c on c.id = d.classification
     cross join needle n
     where d.organization_id = p_organization
       and c.rank <= (select rank from ceiling)
       and (p_object_types is null or d.object_type = any(p_object_types))
       and (p_lifecycle_states is null or d.lifecycle_state = any(p_lifecycle_states))
       and (p_only is null or d.object_id = any(p_only))
       and (d.title ilike '%' || n.pattern || '%' escape '!'
            or d.body ilike '%' || n.pattern || '%' escape '!')
       and d.object_id not in (select f.object_id from full_text f)
       -- Only for what full text cannot do: a short query (an identifier, not a sentence) with a
       -- term no record holds as a word, or no term at all.
       and length(p_text) <= 64
       and array_length(regexp_split_to_array(btrim(p_text), '\s+'), 1) <= 3
       and ((select count(*) from terms) = 0
            or exists (select from terms t where not exists (select from frequency f where f.i = t.i)))
  )
  select object_id, classification, coverage, 'full_text' from full_text
  union all
  select object_id, classification, coverage, 'partial_identifier' from partial
$$;

-- migrate:down

create or replace function search.lexical_matches(
  p_organization     uuid,
  p_ceiling          text,
  p_text             text,
  p_object_types     text[],
  p_lifecycle_states text[],
  p_only             uuid[]
) returns table (object_id uuid, classification text, coverage double precision, matched_by text)
language sql
stable
security invoker
set search_path = pg_catalog, search, registry
as $$
  with terms as (
    select t.ordinality as i, t.variants as q
      from search.query_terms(p_text) with ordinality as t(term, variants, ordinality)
     where t.variants is not null
  ),
  ceiling as (
    select rank from registry.classification where id = p_ceiling
  ),
  scope as (
    select count(*)::double precision as n
      from search.document d
      join registry.classification c on c.id = d.classification
     where d.organization_id = p_organization
       and c.rank <= (select rank from ceiling)
       and (p_object_types is null or d.object_type = any(p_object_types))
       and (p_lifecycle_states is null or d.lifecycle_state = any(p_lifecycle_states))
       and (p_only is null or d.object_id = any(p_only))
  ),
  term_hits as (
    select t.i, h.object_id, h.classification
      from terms t
     cross join lateral (
       select d.object_id, d.classification
         from search.document d
         join registry.classification c on c.id = d.classification
        where d.organization_id = p_organization
          and c.rank <= (select rank from ceiling)
          and (p_object_types is null or d.object_type = any(p_object_types))
          and (p_lifecycle_states is null or d.lifecycle_state = any(p_lifecycle_states))
          and (p_only is null or d.object_id = any(p_only))
          and d.document @@ t.q
     ) h
  ),
  frequency as (
    select i, count(*)::double precision as df from term_hits group by i
  ),
  weight as (
    -- BM25's inverse document frequency, which stays positive for a term every record holds.
    select t.i,
           ln(1 + (s.n - coalesce(f.df, 0) + 0.5) / (coalesce(f.df, 0) + 0.5)) as w
      from terms t cross join scope s left join frequency f on f.i = t.i
  ),
  total as (
    select sum(w) as w from weight
  ),
  full_text as (
    select h.object_id, min(h.classification) as classification,
           sum(w.w) / (select w from total) as coverage
      from term_hits h
      join weight w on w.i = h.i
     group by h.object_id
    having sum(w.w) * 2 >= (select w from total)
  ),
  needle as (
    -- ILIKE patterns are not search syntax. Escape their metacharacters so an identifier such as
    -- LOT_A7 or ZX%Q stays literal instead of widening into a wildcard scan.
    select replace(replace(replace(p_text, '!', '!!'), '%', '!%'), '_', '!_') as pattern
  ),
  partial as (
    select d.object_id, d.classification,
           greatest(public.similarity(d.title, p_text), public.similarity(d.body, p_text)) * 0.49 as coverage
      from search.document d
      join registry.classification c on c.id = d.classification
     cross join needle n
     where d.organization_id = p_organization
       and c.rank <= (select rank from ceiling)
       and (p_object_types is null or d.object_type = any(p_object_types))
       and (p_lifecycle_states is null or d.lifecycle_state = any(p_lifecycle_states))
       and (p_only is null or d.object_id = any(p_only))
       and (d.title ilike '%' || n.pattern || '%' escape '!'
            or d.body ilike '%' || n.pattern || '%' escape '!')
       and d.object_id not in (select f.object_id from full_text f)
       -- Only for what full text cannot do: a short query (an identifier, not a sentence) with a
       -- term no record holds as a word, or no term at all. A query of whole words that every
       -- record could hold is answered by full text; scanning every body for it as a substring
       -- found only longer words containing it, and cost a second per common word at 50 000.
       and length(p_text) <= 64
       and array_length(regexp_split_to_array(btrim(p_text), '\s+'), 1) <= 3
       and ((select count(*) from terms) = 0
            or exists (select from terms t where not exists (select from frequency f where f.i = t.i)))
  )
  select object_id, classification, coverage, 'full_text' from full_text
  union all
  select object_id, classification, coverage, 'partial_identifier' from partial
$$;

drop function search.scope_size(text[], text[], uuid[]);
drop function search.term_hits(tsquery[], text[], text[], uuid[]);
