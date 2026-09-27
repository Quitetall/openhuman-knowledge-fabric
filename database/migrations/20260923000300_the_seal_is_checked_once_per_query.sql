-- migrate:up

-- The seal is checked once per query, not once per row.
--
-- 20260923000100 made every context accessor verify an HMAC. The accessors used to be inlinable
-- SQL over `current_setting`; now each is a SECURITY DEFINER call, which the planner cannot
-- inline, and a policy term like `organization_id = core.current_organization()` is a per-row
-- filter. Measured with tests/database/rls-read-cost.test.ts on 12,000 rows: a policy-governed
-- read went from 17 ms to 296 ms, every row paying for the MAC.
--
-- The value cannot change within a query, so it is asked for once. A scalar subquery with no
-- outer reference — `(select core.current_organization())` — is planned as an InitPlan, run the
-- first time it is needed and reused for every row. The rewrite below is mechanical: every
-- policy expression that calls a context accessor has the call wrapped, and nothing else in it
-- changes. The assertions after it are what keep it true.

do $$
declare
  r record;
  v_qual text;
  v_check text;
  v_pattern constant text :=
    '(?<!SELECT )core\.(current_organization|current_classification_rank|current_actor|'
    || 'current_actor_or_null|current_action_id|current_acting_role)\(\)';
begin
  for r in
    select p.polname, p.polrelid::regclass::text as tbl,
           pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as wcheck
      from pg_policy p
     where coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
           ~ v_pattern
  loop
    v_qual := regexp_replace(r.qual, v_pattern, '(SELECT core.\1())', 'g');
    v_check := regexp_replace(r.wcheck, v_pattern, '(SELECT core.\1())', 'g');
    if r.qual is not null and r.wcheck is not null then
      execute format('alter policy %I on %s using (%s) with check (%s)', r.polname, r.tbl, v_qual, v_check);
    elsif r.qual is not null then
      execute format('alter policy %I on %s using (%s)', r.polname, r.tbl, v_qual);
    else
      execute format('alter policy %I on %s with check (%s)', r.polname, r.tbl, v_check);
    end if;
  end loop;
end
$$;

-- The ADR views filter by organization and ceiling in their own WHERE clauses, per row, in the
-- same way. Same rewrite, keeping each view's options (all are security_invoker).
do $$
declare
  r record;
  v_pattern constant text :=
    '(?<!SELECT )core\.(current_organization|current_classification_rank|current_actor|'
    || 'current_actor_or_null|current_action_id|current_acting_role)\(\)';
begin
  for r in
    select c.oid::regclass::text as view_name,
           pg_get_viewdef(c.oid) as def,
           coalesce(array_to_string(c.reloptions, ', '), '') as options
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'v'
       and n.nspname not in ('pg_catalog', 'information_schema')
       and pg_get_viewdef(c.oid) ~ v_pattern
  loop
    execute format(
      'create or replace view %s %s as %s',
      r.view_name,
      case when r.options = '' then '' else 'with (' || r.options || ')' end,
      regexp_replace(rtrim(r.def, '; '), v_pattern, '(SELECT core.\1())', 'g'));
  end loop;
end
$$;

do $$
declare
  v_offenders text;
begin
  select string_agg(polrelid::regclass::text || '.' || polname, ', ')
    into v_offenders
    from pg_policy
   where coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '')
         ~ '(?<!SELECT )core\.current_[a-z_]+\(\)';
  if v_offenders is not null then
    raise exception 'policies still call a context accessor per row: %', v_offenders;
  end if;

  select string_agg(c.oid::regclass::text, ', ')
    into v_offenders
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'v'
     and n.nspname not in ('pg_catalog', 'information_schema')
     and pg_get_viewdef(c.oid) ~ '(?<!SELECT )core\.current_[a-z_]+\(\)';
  if v_offenders is not null then
    raise exception 'views still call a context accessor per row: %', v_offenders;
  end if;
end
$$;

-- migrate:down
-- kf:forward-only the unwrapped form is the same predicate evaluated once per row; reverting only restores the cost
