-- migrate:up

-- The job queue's own schema is declared to the row-security reconciliation (KF-SAS-RQ-186).
--
-- The worker's job-queue library creates and migrates `graphile_worker` on every start
-- (dogfood-vm.md, 2026-09-11): its tables enable row security without forcing it, and its
-- migration ledger has none. The reconciliation (20260925040000) arrived after the worker was
-- first deployed and was never run with one beside it, so every installation that runs the
-- worker reported `row_security_reconciled: failed` for five tables no migration of ours creates
-- — found by the first workstation stack that started the worker and asked /readiness.
--
-- The schema is exempt as a whole, like `ops`: it holds job rows naming an action id or an
-- outbox task, never record content, and no application login is granted it. What is NOT exempt
-- is any other schema the queue might one day write to; a new one is a new difference.

create or replace function core.readiness_unforced_row_security()
returns table (table_name text, problem text)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select format('%I.%I', n.nspname, c.relname) as table_name,
         case when c.relrowsecurity then 'enabled_not_forced'
              else 'undeclared_without_row_security' end as problem
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and n.nspname not in ('pg_catalog', 'information_schema')
     and n.nspname !~ '^pg_'
     -- graphile_worker.*: the worker's job queue, created and migrated by the library itself
     -- (20260926000200).
     and n.nspname <> 'graphile_worker'
     and (
       (c.relrowsecurity and not c.relforcerowsecurity)
       or (
         not c.relrowsecurity
         -- ops.*: operational facts about the installation — backup runs, copies, drills, the
         -- recovery objective — naming no organization (20260924000200).
         and n.nspname <> 'ops'
         and format('%I.%I', n.nspname, c.relname) not in (
           select e.table_name from core.readiness_row_security_exemptions() e
         )
       )
     )
   order by 1
$$;

-- migrate:down

create or replace function core.readiness_unforced_row_security()
returns table (table_name text, problem text)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select format('%I.%I', n.nspname, c.relname) as table_name,
         case when c.relrowsecurity then 'enabled_not_forced'
              else 'undeclared_without_row_security' end as problem
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and n.nspname not in ('pg_catalog', 'information_schema')
     and n.nspname !~ '^pg_'
     and (
       (c.relrowsecurity and not c.relforcerowsecurity)
       or (
         not c.relrowsecurity
         and n.nspname <> 'ops'
         and format('%I.%I', n.nspname, c.relname) not in (
           select e.table_name from core.readiness_row_security_exemptions() e
         )
       )
     )
   order by 1
$$;
