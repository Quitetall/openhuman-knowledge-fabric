-- migrate:up

-- Every table that enables row-level security also forces it (KF-SAS-RQ-073).
--
-- ENABLE binds every role except the table's OWNER, and PostgreSQL counts as the owner any
-- login that inherits the owner role. FORCE binds the owner too. Until now 70 governed tables
-- forced it and 76 — the domain tables in work, quality, engineering, product, finance, and
-- parts of core, org and content — only enabled it. For those, a login that was a member of the
-- schema owner read every row of every tenant at every classification, with no context bound.
-- The API refuses to start as such a login (T8), and that was the whole of the protection: a
-- startup check in one program, not a property of the tables. Threat model T2 recorded it as
-- not mitigated.
--
-- WHY THIS BREAKS NOTHING. Every SECURITY DEFINER seam runs as the schema owner, and reads past
-- forced policies because the owner has BYPASSRLS (ADR 0026) — the attribute, which is not
-- inherited, not the ownership, which is. `readiness` already refuses a host whose owner lacks
-- it (`schema_owner_bypasses_rls`), and the seventy tables forced before this migration depend
-- on it in exactly the same way. The migrator itself keeps reading everything by the same
-- attribute; the owner credential's admin commands are unchanged. What loses its exemption is a
-- login that merely INHERITS the owner role without being it — which is the misconfiguration
-- this closes.
--
-- WHAT IS LEFT UNFORCED, AND WHY: nothing that enables row security. Tables that do not enable
-- it are not governed records and carry no tenant or classification:
--
--   * `ops.*` — recovery objectives, backup runs and copies, restore drills and their evidence.
--     Operational facts about the installation, written by the backup and readiness logins and
--     read by readiness; they name no organization and hold no record content, so there is no
--     row a policy could scope. Their integrity is append-only triggers, not row security.
--   * `registry.*` reference data, `org.role`, the audit chain head and checkpoints, the seal
--     key, leases and migration bookkeeping — each guarded by grants, not by rows.
--
-- `tests/database/row-security-forced.test.ts` fails on any table added later that enables row
-- security without forcing it.

do $$
declare
  r record;
  v_offenders text;
begin
  for r in
    select c.oid::regclass::text as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and c.relrowsecurity
       and not c.relforcerowsecurity
       and n.nspname not in ('pg_catalog', 'information_schema')
       and n.nspname !~ '^pg_'
     order by 1
  loop
    execute format('alter table %s force row level security', r.tbl);
  end loop;

  select string_agg(c.oid::regclass::text, ', ')
    into v_offenders
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p')
     and c.relrowsecurity
     and not c.relforcerowsecurity
     and n.nspname not in ('pg_catalog', 'information_schema')
     and n.nspname !~ '^pg_';
  if v_offenders is not null then
    raise exception 'tables still enable row security without forcing it: %', v_offenders;
  end if;
end
$$;

-- migrate:down
-- kf:forward-only reverting would let any login inheriting the schema owner read every tenant's rows in 76 governed tables again
