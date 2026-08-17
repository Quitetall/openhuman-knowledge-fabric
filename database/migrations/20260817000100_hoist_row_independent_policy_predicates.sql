-- migrate:up

-- Row-independent policy predicates are evaluated once per statement, not once per row.
--
-- MEASURED, not reasoned about. `tests/database/rls-read-cost.test.ts` on 36,007 objects and
-- 36,000 actions across three organizations, read as kf_readonly with the access context
-- bound, taking the median of seven runs:
--
--   core.object · scan, no predicate                        0.8 ms   36007 rows
--   core.object · organization term only                    0.8 ms   12005 rows
--   core.object · organization + classification rank       98.2 ms   12005 rows
--   core.object · full policy predicate, hand-written     461.1 ms   12005 rows
--   core.object · same predicate, OR branches hoisted       93.8 ms   12005 rows
--
-- The organization term is free — `object_by_org` covers it. The classification rank costs
-- ~97 ms and is genuinely per-row: it depends on the row's own classification. The remaining
-- ~363 ms is two predicates that depend on NOTHING about the row.
--
-- `content.document_basis_classifier_active()` and `content.compiler_runtime_active()` ask
-- whether a runtime is presently active. Both are declared STABLE, which is easy to misread
-- as "evaluated once". STABLE promises only that the answer will not change WITHIN a
-- statement, which is what lets the planner use such a value in an index condition. In a
-- per-row filter PostgreSQL still calls the function for every row it tests — and because
-- these are separate PERMISSIVE policies, PostgreSQL ORs them with the scoped policy, so
-- every row that fails the organization test goes on to call both functions. On a read that
-- filters two organizations out of three, that is the majority of rows.
--
-- Wrapping each call in an uncorrelated scalar subquery lets the planner lift it into an
-- InitPlan evaluated once per statement. `(select f())` and `f()` have identical truth
-- values and select identical rows — the benchmark asserts the row counts match before it
-- reports either duration — so this is a plan change and not a policy change. Nobody can see
-- a row they could not see before, and nobody is denied one they could.
--
-- Applied by rewriting rather than by 30 hand-written statements, because the set is
-- discovered from `pg_policies` and so cannot drift from what is actually installed. The
-- block RAISES if it rewrites nothing: a migration that silently matches zero policies would
-- report this fixed while leaving every one of them slow.

do $$
declare
  policy_row  record;
  hoisted     text;
  rewritten   integer := 0;
begin
  for policy_row in
    select schemaname, tablename, policyname, qual
      from pg_policies
     where qual is not null
       and qual ~ '^\(?\s*(content\.)?(document_basis_classifier_active|compiler_runtime_active)\(\)\s*\)?$'
  loop
    -- Rebuilt explicitly rather than by interpolating `qual` back in, so exactly one of two
    -- known expressions can ever be installed by this migration.
    hoisted := case
      when policy_row.qual like '%document_basis_classifier_active%'
        then '(select content.document_basis_classifier_active())'
      else '(select content.compiler_runtime_active())'
    end;
    execute format(
      'alter policy %I on %I.%I using (%s)',
      policy_row.policyname, policy_row.schemaname, policy_row.tablename, hoisted
    );
    rewritten := rewritten + 1;
  end loop;

  if rewritten = 0 then
    raise exception
      'hoist migration matched no policies; the predicate shape it targets has changed and '
      'every runtime-gate policy is still being evaluated per row'
      using errcode = 'check_violation';
  end if;

  raise notice 'hoisted % row-independent policy predicates', rewritten;
end $$;

-- migrate:down

do $$
declare
  policy_row record;
  restored   text;
begin
  for policy_row in
    select schemaname, tablename, policyname, qual
      from pg_policies
     where qual is not null
       and qual ~ '^\(?\s*\(?\s*SELECT\s+(content\.)?(document_basis_classifier_active|compiler_runtime_active)\(\)\s*\)?\s*\)?$'
  loop
    restored := case
      when policy_row.qual like '%document_basis_classifier_active%'
        then 'content.document_basis_classifier_active()'
      else 'content.compiler_runtime_active()'
    end;
    execute format(
      'alter policy %I on %I.%I using (%s)',
      policy_row.policyname, policy_row.schemaname, policy_row.tablename, restored
    );
  end loop;
end $$;
