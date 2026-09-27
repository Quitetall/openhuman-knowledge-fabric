-- migrate:up

-- The sweep covers every transient table again.
--
-- Two migrations written in parallel each redefined core.sweep_transient_observations() from the
-- same starting point: 20260926110100 added content.master_record_currency and
-- content.master_record_input_write, and 20260926200200 added search.identification_refusal.
-- The later one, by number, replaced the earlier's definition, so on a database migrated to both
-- the two master-record tables were never swept, and nothing but a test noticed
-- (tests/database/transient-observations.test.ts compares the swept set with the declared one).
-- This is the union, in the earlier order, with the asker key still last.

create or replace function core.sweep_transient_observations()
returns table (table_name text, removed bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count bigint;
begin
  delete from search.recorded_query where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.recorded_query'; removed := v_count; return next;

  delete from search.demand_contribution where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.demand_contribution'; removed := v_count; return next;

  delete from retrieval.disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'retrieval.disclosure'; removed := v_count; return next;

  delete from search.context_disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.context_disclosure'; removed := v_count; return next;

  delete from search.identification_refusal where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.identification_refusal'; removed := v_count; return next;

  delete from content.master_record_currency where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'content.master_record_currency'; removed := v_count; return next;

  delete from content.master_record_input_write written
   where written.expires_at <= now()
     and written.xact < coalesce(
       (select min(pg_snapshot_xmin(currency.snapshot)) from content.master_record_currency currency),
       pg_snapshot_xmin(pg_current_snapshot()));
  get diagnostics v_count = row_count;
  table_name := 'content.master_record_input_write'; removed := v_count; return next;

  -- The key last: a row swept above may still have been keyed by it.
  delete from search.asker_key where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.asker_key'; removed := v_count; return next;
end
$$;

-- migrate:down

create or replace function core.sweep_transient_observations()
returns table (table_name text, removed bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count bigint;
begin
  delete from search.recorded_query where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.recorded_query'; removed := v_count; return next;

  delete from search.demand_contribution where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.demand_contribution'; removed := v_count; return next;

  delete from retrieval.disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'retrieval.disclosure'; removed := v_count; return next;

  delete from search.context_disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.context_disclosure'; removed := v_count; return next;

  delete from search.identification_refusal where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.identification_refusal'; removed := v_count; return next;

  -- The key last: a row swept above may still have been keyed by it.
  delete from search.asker_key where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.asker_key'; removed := v_count; return next;
end
$$;
