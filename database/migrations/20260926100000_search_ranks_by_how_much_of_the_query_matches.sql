-- migrate:up

-- Lexical search ranks by how much of the query a record matches, in the record's own language
-- (§64, KF-SAS-RQ-213, RQ-224, ADR 0037).
--
-- WHAT WAS WRONG, measured on the fixture corpora (fixtures/*/reports/search-baseline.md,
-- 2026-09-25):
--
--   1. Every word had to match. `websearch_to_tsquery` ANDs every term, so a question typed as a
--      sentence found almost nothing: Véracier recall@10 0.0168 as written, EnterpriseRAG-Bench
--      0.0717. Joined with `or` the same words found 0.1793 and 0.7046, and then the 20
--      EnterpriseRAG-Bench questions whose answer is not in the corpus each "matched" 42 000 to
--      50 000 of its 50 001 documents, because any shared word was a match.
--   2. Every document was stemmed as English. Véracier is French, English, German, Italian and
--      Spanish; its French text was indexed with English stemming and English stopwords.
--
-- WHAT THIS DOES.
--
--   Language. `search.detect_languages` counts, in the first 5 000 characters, the function words
--   (the configuration's stopwords) of each supported language: the language whose function words
--   the text uses most is its language. A second language is kept when its own function words
--   (not also the first's) number at least half the first's, because the corpora hold bilingual
--   documents (a French letterhead over a German contract) and one stemmer cannot serve both. Fewer than three
--   function words (a title, a part number) is not evidence of anything, and such a text keeps
--   the configuration it had before: English. The document's languages are stored beside its
--   vector, and the vector is the concatenation of one vector per language.
--
--   Query terms. `search.query_terms` splits the query with the same parser, drops the function
--   words of the query's own language, and gives each remaining term every supported language's
--   stem of it and its unstemmed form ('simple'), OR'd: a query in French finds a French document
--   indexed with French stems, and the same query finds an English one through the English stems.
--   The operators of web-search syntax (`or`, quotes, `-`) are not interpreted: every word is a
--   term, and "or" is an English function word.
--
--   Matching and the floor. `search.lexical_matches` scores a record by the share of the query's
--   information it contains: the sum over the terms it matches of each term's inverse document
--   frequency (BM25's, over the records the caller's ceiling admits in the scope searched),
--   divided by the sum over all terms. A record matches when that share is at least one half —
--   it contains at least half of what the query says, weighted so that a word every record
--   contains says almost nothing and a word no record contains says the most. The floor is a
--   stated default, not a value fitted to any benchmark. Records matching a term are found per
--   term through the GIN index; nothing is detoasted to be counted.
--
--   Partial identifiers (a substring of the whole query in the title or body, by trigram) are
--   still matched only where full text missed, and are scored below every full-text match. They
--   are looked for only when full text cannot answer: a query of at most three words and 64
--   characters that has a term no record holds as a word (CNB-22, half of CNB-2201), or no term.
--
-- `search.rebuild()` re-detects every document's languages; until a record is re-indexed it
-- keeps the English vector it had, which is what the new column's default says.

-- The languages a document may be detected as. English first: it wins a tie, and it is the
-- configuration every record was indexed with before this migration.
create function search.supported_languages() returns regconfig[]
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select '{english,french,german,italian,spanish,portuguese,dutch}'::regconfig[]
$$;

/*
 * A text's languages, most evident first, from the function words (the configuration's stopwords)
 * of its first 5 000 characters. The first is the language whose function words the text uses
 * most. The second counts only function words that are not also the first's (French and Spanish
 * share "de", "la", "en"), and is kept when there are at least half as many of them. Fewer than
 * three function words in the best language is no evidence, and the answer is English, the
 * configuration before languages.
 */
create function search.detect_languages(p_text text) returns regconfig[]
language sql
stable
parallel safe
set search_path = pg_catalog, search
as $$
  with words as (
    select v.lexeme as word, array_length(v.positions, 1) as n
      from unnest(to_tsvector('simple'::regconfig, left(coalesce(p_text, ''), 5000))) v
  ),
  membership as (
    select w.word, w.n, l.cfg, l.ord
      from words w
     cross join unnest(search.supported_languages()) with ordinality as l(cfg, ord)
     where to_tsvector(l.cfg, w.word) = ''::tsvector
  ),
  first as (
    select cfg, ord, sum(n) as function_words
      from membership
     group by cfg, ord
     order by function_words desc, ord
     limit 1
  ),
  second as (
    select m.cfg, m.ord, sum(m.n) as function_words
      from membership m
     cross join first f
     where m.cfg <> f.cfg
       and not exists (select from membership o where o.word = m.word and o.cfg = f.cfg)
     group by m.cfg, m.ord
     order by function_words desc, m.ord
     limit 1
  )
  select case
           when coalesce((select function_words from first), 0) < 3
             then array['english'::regconfig]
           when (select function_words from second) * 2 >= (select function_words from first)
             then array[(select cfg from first), (select cfg from second)]
           else array[(select cfg from first)]
         end
$$;

-- OR and AND over a set of tsqueries, for building one query from many terms.
create aggregate search.tsquery_or(tsquery) (sfunc = pg_catalog.tsquery_or, stype = tsquery);
create aggregate search.tsquery_and(tsquery) (sfunc = pg_catalog.tsquery_and, stype = tsquery);

/*
 * The lexemes of a vector, AND'd, as a query; null for an empty vector. Each lexeme is quoted as
 * a tsquery literal, so it is taken exactly as the vector holds it and never re-parsed.
 */
create function search.lexeme_query(p_vector tsvector) returns tsquery
language sql
immutable
parallel safe
set search_path = pg_catalog, search
as $$
  select search.tsquery_and(
           ('''' || replace(replace(v.lexeme, '\', '\\'), '''', '''''') || '''')::tsquery)
    from unnest(p_vector) v
$$;

/*
 * The terms of a query, in order: each distinct token that is not a function word of the query's
 * own language, with every supported language's stem of it and its unstemmed form, OR'd. At most
 * 64 terms (the API refuses a query over 512 characters).
 */
create function search.query_terms(p_text text)
returns table (term text, variants tsquery)
language sql
stable
parallel safe
set search_path = pg_catalog, search
as $$
  with query_language as (
    select (search.detect_languages(p_text))[1] as cfg
  ),
  tokens as (
    select lower(p.token) as token, min(p.position) as position
      from ts_parse('default', left(coalesce(p_text, ''), 2048)) with ordinality as p(tokid, token, position)
      join ts_token_type('default') t on t.tokid = p.tokid
     -- Whitespace and punctuation are not terms; the parts of a hyphenated word are matched
     -- through the whole word, which the vector holds together with its parts.
     where t.alias not in ('blank', 'hword_part', 'hword_asciipart', 'hword_numpart')
     group by lower(p.token)
  ),
  content as (
    select tokens.token, tokens.position
      from tokens, query_language
     where exists (select from unnest(to_tsvector(query_language.cfg, tokens.token)))
     order by tokens.position
     limit 64
  )
  select content.token,
         (select search.tsquery_or(v.q)
            from (select distinct search.lexeme_query(to_tsvector(c.cfg, content.token)) as q
                    from unnest(search.supported_languages() || 'simple'::regconfig) c(cfg)) v
           where v.q is not null)
    from content
   order by content.position
$$;

/*
 * Every record the caller's session can see that the query matches, with the share of the
 * query's information it matches (0..1; partial-identifier matches score below 0.5, which no
 * full-text match does). Security invoker: row security on search.document applies to every
 * scan here, and the organization and ceiling predicates are repeated, as @kf/search always has.
 *
 * `p_only` restricts to the given ids (the records a caller's grants reach).
 */
create function search.lexical_matches(
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

-- The record's detected languages. Existing rows were indexed as English, which the default
-- states truthfully until search.rebuild() re-detects them.
alter table search.document
  add column languages regconfig[] not null default '{english}'::regconfig[];

comment on column search.document.languages is
  'Languages the document vector was built in, most evident first (search.detect_languages).';

/** Index or re-index one object, in its own languages. Idempotent. */
create or replace function search.index_object(p_object uuid) returns void
language plpgsql
security definer
set search_path = core, search, registry, pg_catalog
as $$
declare
  v_body      text := search.text_for(p_object);
  v_languages regconfig[] := search.detect_languages(v_body);
  v_vector    tsvector := ''::tsvector;
  v_title     text;
  v_language  regconfig;
begin
  select coalesce(o.title, '') into v_title from core.object o where o.id = p_object;
  foreach v_language in array v_languages loop
    -- Title weighted above body: someone searching for a part number means the record called
    -- that, not every record mentioning it.
    v_vector := v_vector
      || setweight(to_tsvector(v_language, coalesce(v_title, '')), 'A')
      || setweight(to_tsvector(v_language, v_body), 'B');
  end loop;

  insert into search.document
    (object_id, object_type, organization_id, classification, lifecycle_state, title, body,
     document, languages, indexed_at)
  select o.id, o.object_type, o.organization_id, o.classification, o.lifecycle_state,
         o.title, v_body, v_vector, v_languages, now()
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
        languages = excluded.languages,
        indexed_at = now();
end
$$;

revoke execute on function search.supported_languages() from public;
revoke execute on function search.detect_languages(text) from public;
revoke execute on function search.lexeme_query(tsvector) from public;
revoke execute on function search.query_terms(text) from public;
revoke execute on function search.lexical_matches(uuid, text, text, text[], text[], uuid[]) from public;
revoke execute on function search.index_object(uuid) from public;
grant execute on function search.supported_languages() to kf_app, kf_worker;
grant execute on function search.detect_languages(text) to kf_app, kf_worker;
grant execute on function search.lexeme_query(tsvector) to kf_app, kf_worker;
grant execute on function search.query_terms(text) to kf_app, kf_worker;
grant execute on function search.lexical_matches(uuid, text, text, text[], text[], uuid[])
  to kf_app, kf_worker;
grant execute on function search.index_object(uuid) to kf_app, kf_worker;

comment on function search.lexical_matches(uuid, text, text, text[], text[], uuid[]) is
  'Lexical matches under the caller''s row security, scored by the IDF-weighted share of the '
  'query they match; a full-text match holds at least half (20260926100000).';

-- migrate:down

drop function search.lexical_matches(uuid, text, text, text[], text[], uuid[]);
drop function search.query_terms(text);
drop function search.lexeme_query(tsvector);
drop aggregate search.tsquery_and(tsquery);
drop aggregate search.tsquery_or(tsquery);

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

alter table search.document drop column languages;
drop function search.detect_languages(text);
drop function search.supported_languages();
