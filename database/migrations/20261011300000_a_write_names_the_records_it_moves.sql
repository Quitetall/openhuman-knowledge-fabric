-- migrate:up

-- A write names the records it can move, so a reader re-checks those and not their whole corpus
-- (SAS §100.42, §100.43; ADR 0013, ADR 0015; KF-SAS-RQ-112, RQ-201).
--
-- THE COST, MEASURED. 20260926110100 made a claim knowable as current without recounting it: the
-- database records each transaction that writes an input of a permitted-set reading, and a reader
-- whose own compilation saw every such write since is current. But the record said only WHICH
-- TRANSACTION wrote, per organization. One note captured by anybody in the organization made every
-- reader's next Object View, master record, projection and master document fall back to recounting
-- their whole corpus — on the 50 000-record multi fixture, 11 to 28 s a click — until each reader
-- refreshed. In an organization that writes continuously that is the common case.
--
-- WHAT IS RECORDED NOW. A write to a table whose effect on every reading is confined to records it
-- names records those records: one row per transaction, organization and record (or artifact
-- version, resolved to the records holding it when it is read). Every other write is recorded as
-- before, naming nothing, and still means "anything may have moved". A reader whose compilation
-- missed only writes that name records re-checks those records — live, under their own row
-- security and grants, at the revision their claim holds — and the rest of the claim stands on the
-- same argument as before: nothing that could move it was written. Nothing about what a reading
-- may show is decided from this record. It only decides how much has to be read again.
--
-- WHICH WRITES NAME THEIR RECORDS (`content.master_record_input_plan`, from the catalog, applied by
-- `content.install_master_record_input_triggers`). A permitted set is the envelope rows row
-- security admits, the payload `content.master_record_payloads` walks for each of them, the grant
-- coverage, and the person's exclusions and the organization's holds. So a write is CONFINED when:
--
--   - its table is read by the payload walk (a typed table, a table with a foreign key to the
--     envelope, an artifact version and what hangs off it), or is a row-security parent of one,
--     or is the envelope itself, and the records it names are its foreign keys to the envelope (or
--     to a typed table, whose id is the envelope's) and to artifact versions — every column the
--     walk keys a row by, and more;
--   - no row-security policy of such a table reaches it through a function (those are named by
--     nothing and decide by anything);
--   - when other tables' policies read it (it is a PARENT), every one of them holds a foreign key to
--     it, so no row can depend on a parent row that does not exist yet, or outlive one deleted;
--     and an update that changes a column any policy reads, or its key, names nothing: it can
--     change what row security admits anywhere below it;
--   - it is not read by the grant coverage, except an object grant, which covers exactly its scope
--     record (`coveringGrants`); an organization-wide grant names nothing. A role assignment's
--     envelope is read by the coverage too (its lifecycle state), so a write to one names nothing;
--   - or it is a person's exclusion or a retention hold, which `enumeratePermittedSet` reads by
--     the record they name.
--
-- Everything else — registry tables, the coverage's sources, a parent some policy reads without a
-- foreign key, a table nothing confines — is recorded as before. A TRUNCATE of any table, and a
-- write the plan cannot confine, name nothing. The plan is pinned and each rule falsified in
-- tests/database/master-record-delta.test.ts.
--
-- WHAT A WRITE ROW IS. `content.master_record_input_write` keeps one row per transaction and
-- organization for a write that names nothing (object and version null), as it always did, and
-- one row per transaction, organization and record or version for one that names them. So
-- `content.master_record_current_format` is unchanged: ANY unseen row, naming or not, still means
-- it cannot vouch. `content.master_record_currency_delta` is the new question: given the same
-- currency row, either nothing unseen names nothing — and here are the records unseen writes named,
-- at most p_limit of them — or no answer.

alter table content.master_record_input_write
  add column object_id  uuid,
  add column version_id uuid,
  add constraint master_record_input_write_names_one
    check (object_id is null or version_id is null);

drop index content.master_record_input_write_once;
create unique index master_record_input_write_once
  on content.master_record_input_write (xact, organization_id, object_id, version_id)
  nulls not distinct;
-- A write that names nothing is what makes a reader recount: found without reading the others.
create index master_record_input_write_unconfined
  on content.master_record_input_write (organization_id, xact)
  where object_id is null and version_id is null;

comment on table content.master_record_input_write is
  'Transient (§64B): which transactions wrote an input of a master-record permitted set, for '
  'which organization (null: every organization), and — when the write is confined to records it '
  'names — which record (object_id) or artifact version (version_id). Both null: anything may have '
  'moved. Read only through content.master_record_current_format and '
  'content.master_record_currency_delta; swept, keeping what a live currency row still needs.';

-- How every noted table's writes are recorded, derived from the catalog. One row per table in the
-- governed schemas that is not exempt. `mode` is `confined` (the write names records) or
-- `unconfined` (it names nothing); `reason` says which rule decided.
create function content.master_record_input_plan()
returns table (
  table_name      text,
  mode            text,
  object_columns  text[],
  version_columns text[],
  guarded_columns text[],
  unconfined_when text,
  reason          text
)
language sql
stable
set search_path = pg_catalog
as $$
  with recursive
  governed(oid, name) as materialized (
    select c.oid, format('%I.%I', n.nspname, c.relname)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and n.nspname in ('content', 'core', 'engineering', 'finance', 'ml', 'org', 'product',
                         'quality', 'registry', 'secure_object', 'work')
       and not exists (select 1 from content.master_record_input_exemption e
                        where e.table_name = format('%I.%I', n.nspname, c.relname))
  ),
  -- Typed tables: their id is a foreign key to the envelope's, so a key to one is a record id.
  typed(oid) as (
    select k.conrelid
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f' and k.confrelid = 'core.object'::regclass
       and array_length(k.conkey, 1) = 1 and a.attname = 'id'
    union
    select 'core.object'::regclass::oid
  ),
  -- The single-column foreign keys a row names a record or an artifact version by.
  keys(oid, kind, column_name) as (
    select k.conrelid, case when k.confrelid = 'content.artifact_version'::regclass
                            then 'version' else 'object' end, a.attname::text
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f' and array_length(k.conkey, 1) = 1
       and (k.confrelid in (select oid from typed)
            or k.confrelid = 'content.artifact_version'::regclass)
    union
    select 'core.object'::regclass, 'object', 'id'
    union
    select 'content.artifact_version'::regclass, 'version', 'id'
  ),
  -- What a permitted set reads row by row: content.master_record_payloads' catalog walk, the
  -- envelope, and the exclusions, holds and object grants read by the record they name.
  walk(oid) as (
    select c.oid
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and c.relrowsecurity
       and n.nspname in ('content', 'engineering', 'finance', 'ml', 'org', 'product', 'quality',
                         'secure_object', 'work')
       and c.relname not like 'master_record%'
       and c.relname <> 'person_entitlement_exclusion'
       and exists (select 1 from pg_constraint k
                    where k.conrelid = c.oid and k.contype = 'f'
                      and k.confrelid = 'core.object'::regclass
                      and array_length(k.conkey, 1) = 1)
    union
    select unnest(array['core.object'::regclass, 'content.artifact_version'::regclass,
                        'content.external_locator'::regclass,
                        'content.artifact_relationship'::regclass,
                        'content.person_entitlement_exclusion'::regclass,
                        'core.retention_hold'::regclass, 'org.access_grant'::regclass]::oid[])
  ),
  read_policy(oid, relid) as (
    select p.oid, p.polrelid from pg_policy p where p.polcmd in ('r', '*')
  ),
  -- Table T is read by a read policy of table D (D <> T).
  policy_reads(d, t) as (
    select distinct p.relid, dd.refobjid
      from read_policy p
      join pg_depend dd on dd.classid = 'pg_policy'::regclass and dd.objid = p.oid
                       and dd.refclassid = 'pg_class'::regclass
     where dd.refobjid <> p.relid
  ),
  -- The walk and every table row security reads to decide one of its rows, transitively.
  relevant(oid) as (
    select oid from walk
    union
    select pr.t from relevant r join policy_reads pr on pr.d = r.oid
  ),
  -- Functions a read policy of a relevant table calls, and every function their bodies name.
  policy_function(oid) as (
    select dd.refobjid
      from read_policy p
      join relevant r on r.oid = p.relid
      join pg_depend dd on dd.classid = 'pg_policy'::regclass and dd.objid = p.oid
                       and dd.refclassid = 'pg_proc'::regclass
    union
    select callee.oid
      from policy_function pf
      join pg_proc caller on caller.oid = pf.oid
      join pg_proc callee on callee.oid <> caller.oid
      join pg_namespace cn on cn.oid = callee.pronamespace
     where cn.nspname not in ('pg_catalog', 'information_schema')
       and caller.prosrc ~* ('\m' || cn.nspname || '\.' || callee.proname || '\M')
  ),
  -- Tables those functions name. One reading is allowed for: org.qualification_holds_role reads
  -- the envelope of a role assignment (its organization and lifecycle state), and every write to
  -- a role assignment's envelope names nothing (`unconfined_when` below). The test pins it.
  called(oid, prosrc) as materialized (
    select f.oid, f.prosrc from pg_proc f where f.oid in (select oid from policy_function)
  ),
  through_function(oid) as materialized (
    select distinct g.oid
      from called f
      join governed g on f.prosrc ~* ('\m' || replace(g.name, '.', '\.') || '\M')
     where not (g.oid = 'core.object'::regclass
                and f.oid = 'org.qualification_holds_role(uuid,uuid,text)'::regprocedure)
  ),
  -- What the grant coverage reads: org.effective_access_grant through its views and functions,
  -- and the role assignments enumerateAccessCoverage joins itself.
  coverage_view(oid) as (
    select 'org.effective_access_grant'::regclass::oid
    union
    select dd.refobjid
      from coverage_view v
      join pg_rewrite rw on rw.ev_class = v.oid
      join pg_depend dd on dd.classid = 'pg_rewrite'::regclass and dd.objid = rw.oid
                       and dd.refclassid = 'pg_class'::regclass and dd.refobjid <> v.oid
      join pg_class c on c.oid = dd.refobjid and c.relkind = 'v'
  ),
  coverage(oid) as (
    select dd.refobjid
      from coverage_view v
      join pg_rewrite rw on rw.ev_class = v.oid
      join pg_depend dd on dd.classid = 'pg_rewrite'::regclass and dd.objid = rw.oid
                       and dd.refclassid = 'pg_class'::regclass
    union
    select g.oid
      from (select f.oid, f.prosrc
              from pg_proc f
             where f.oid in (select dd.refobjid
                               from coverage_view v
                               join pg_rewrite rw on rw.ev_class = v.oid
                               join pg_depend dd on dd.classid = 'pg_rewrite'::regclass
                                                and dd.objid = rw.oid
                                                and dd.refclassid = 'pg_proc'::regclass)
            offset 0) as f
      join governed g on f.prosrc ~* ('\m' || replace(g.name, '.', '\.') || '\M')
    union
    select 'org.role_assignment'::regclass::oid
  ),
  -- A table a relevant table's read policy reads: a parent. Backed when every such table holds a
  -- foreign key to it, so no row can wait for a parent row or outlive one.
  parent(oid) as (
    select distinct pr.t
      from policy_reads pr
      join relevant d on d.oid = pr.d
      join governed dg on dg.oid = pr.d
  ),
  unbacked_parent(oid) as (
    select distinct pr.t
      from policy_reads pr
      join relevant d on d.oid = pr.d
      join governed dg on dg.oid = pr.d
     where not exists (select 1 from pg_constraint k
                        where k.conrelid = pr.d and k.contype = 'f' and k.confrelid = pr.t)
    union
    select p.oid from parent p
     where not exists (select 1 from pg_constraint k where k.conrelid = p.oid and k.contype = 'p')
  ),
  plan as (
    select g.name,
           g.oid,
           (select coalesce(array_agg(quote_ident(k.column_name) order by k.column_name), '{}')
              from keys k where k.oid = g.oid and k.kind = 'object') as object_columns,
           (select coalesce(array_agg(quote_ident(k.column_name) order by k.column_name), '{}')
              from keys k where k.oid = g.oid and k.kind = 'version') as version_columns,
           case
             when g.oid in (select oid from through_function)
               then 'read inside a function a row-security policy calls'
             when g.oid in (select oid from unbacked_parent)
               then 'read by a row-security policy of a table holding no foreign key to it'
             when not exists (select 1 from keys k where k.oid = g.oid)
               then 'names no record and no artifact version'
             when g.oid = 'core.object'::regclass
               then 'the envelope: an update to its key, organization or classification, or to a role assignment, names nothing'
             when g.oid = 'org.access_grant'::regclass
               then 'an object grant covers exactly its scope record; an organization-wide one names nothing'
             when g.oid in (select oid from coverage) then 'read by the grant coverage'
             when g.oid = 'core.retention_hold'::regclass
               then 'a hold withholds exactly the record it names'
             when g.oid = 'content.person_entitlement_exclusion'::regclass
               then 'an exclusion withholds exactly the record it names'
             when g.oid not in (select oid from relevant)
               then 'not shown to be read only for the records it names'
             when g.oid in (select oid from parent)
               then 'read by the payload walk and by row security, along foreign keys'
             else 'read by the payload walk'
           end as reason
      from governed g
  )
  select plan.name,
         case when plan.reason in ('read inside a function a row-security policy calls',
                                   'read by a row-security policy of a table holding no foreign key to it',
                                   'names no record and no artifact version',
                                   'read by the grant coverage',
                                   'not shown to be read only for the records it names')
              then 'unconfined' else 'confined' end,
         plan.object_columns,
         plan.version_columns,
         case
           -- A parent's key, and every column any read policy of a relevant table reads of it.
           when plan.oid in (select oid from parent) or plan.oid = 'core.object'::regclass then
             array(
               select quote_ident(a.attname)
                 from pg_attribute a
                where a.attrelid = plan.oid and a.attnum > 0 and not a.attisdropped
                  and (a.attnum = any ((select k.conkey from pg_constraint k
                                         where k.conrelid = plan.oid and k.contype = 'p')::int2[])
                       or exists (
                         select 1 from read_policy p
                           join pg_depend dd on dd.classid = 'pg_policy'::regclass
                                            and dd.objid = p.oid
                                            and dd.refclassid = 'pg_class'::regclass
                                            and dd.refobjid = plan.oid
                                            and dd.refobjsubid = a.attnum
                          where p.relid in (select oid from relevant)))
                order by a.attname)
           else '{}'::text[]
         end,
         case plan.oid
           -- The grant coverage reads a role assignment's envelope (its lifecycle state).
           when 'core.object'::regclass then $u$r.object_type = 'role_assignment'$u$
           -- An organization-wide grant covers every record.
           when 'org.access_grant'::regclass
             then 'r.scope_object_id is null or r.scope_object_id = r.organization_id'
           else null
         end,
         plan.reason
    from plan
   order by plan.name
$$;

revoke all on function content.master_record_input_plan() from public;

comment on function content.master_record_input_plan() is
  'How each noted table''s writes are recorded in content.master_record_input_write: confined '
  '(naming the records and artifact versions its rows name) or unconfined (naming nothing), with '
  'the rule that decided. Derived from the catalog; pinned by tests/database/master-record-delta.test.ts.';

-- Note one write's records. Statement-level, over the statement's transition tables. Arguments:
--   0  record columns   1  artifact-version columns   2  guarded columns (comma lists, quoted)
--   3  a predicate over a row `r` that makes the write name nothing ('' for none)
-- An update that changes any guarded column — matched row by row through the table's key, which
-- is guarded too — names nothing, and so does any row the predicate holds for.
create function content.note_master_record_input_rows() returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_org      uuid := case when core.session_is_administrator() then null
                          else core.current_organization() end;
  v_objects  text[] := string_to_array(nullif(tg_argv[0], ''), ',');
  v_versions text[] := string_to_array(nullif(tg_argv[1], ''), ',');
  v_guarded  text := nullif(tg_argv[2], '');
  v_when     text := nullif(tg_argv[3], '');
  v_sources  text[] := case tg_op when 'INSERT' then array['new_rows']
                                  when 'DELETE' then array['old_rows']
                                  else array['old_rows', 'new_rows'] end;
  v_source   text;
  v_column   text;
  v_hit      boolean;
  v_named    text[];
begin
  foreach v_source in array v_sources loop
    if v_when is not null then
      execute format('select exists (select 1 from %I r where %s)', v_source, v_when) into v_hit;
      if v_hit then
        insert into content.master_record_input_write (organization_id) values (v_org)
        on conflict do nothing;
        return null;
      end if;
    end if;
  end loop;
  if tg_op = 'UPDATE' and v_guarded is not null then
    execute format(
      'select exists (select %1$s from old_rows except all select %1$s from new_rows)', v_guarded)
      into v_hit;
    if v_hit then
      insert into content.master_record_input_write (organization_id) values (v_org)
      on conflict do nothing;
      return null;
    end if;
  end if;
  -- One statement for the records and one for the versions, over every key of every row.
  v_named := '{}';
  foreach v_source in array v_sources loop
    foreach v_column in array coalesce(v_objects, '{}') loop
      v_named := v_named || format('select r.%s as k from %I r', v_column, v_source);
    end loop;
  end loop;
  if cardinality(v_named) > 0 then
    execute format(
      'insert into content.master_record_input_write (organization_id, object_id)
       select distinct $1, named.k from (%s) as named where named.k is not null
       on conflict do nothing', array_to_string(v_named, ' union all '))
      using v_org;
  end if;
  v_named := '{}';
  foreach v_source in array v_sources loop
    foreach v_column in array coalesce(v_versions, '{}') loop
      v_named := v_named || format('select r.%s as k from %I r', v_column, v_source);
    end loop;
  end loop;
  if cardinality(v_named) > 0 then
    execute format(
      'insert into content.master_record_input_write (organization_id, version_id)
       select distinct $1, named.k from (%s) as named where named.k is not null
       on conflict do nothing', array_to_string(v_named, ' union all '))
      using v_org;
  end if;
  return null;
end
$$;

revoke all on function content.note_master_record_input_rows() from public;

-- Apply the plan: an unconfined table keeps the statement trigger that names nothing; a confined
-- one gets three transition-table triggers that name its rows' records, and keeps the old trigger
-- for TRUNCATE alone. Idempotent; a migration that adds a table calls it again.
create or replace function content.install_master_record_input_triggers() returns integer
language plpgsql
set search_path = pg_catalog
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in select * from content.master_record_input_plan() loop
    execute format('drop trigger if exists zz_master_record_input_written on %s', r.table_name);
    execute format('drop trigger if exists zz_master_record_input_inserted on %s', r.table_name);
    execute format('drop trigger if exists zz_master_record_input_updated on %s', r.table_name);
    execute format('drop trigger if exists zz_master_record_input_deleted on %s', r.table_name);
    if r.mode = 'confined' then
      execute format(
        'create trigger zz_master_record_input_written after truncate on %s '
        'for each statement execute function content.note_master_record_input_write()',
        r.table_name);
      execute format(
        'create trigger zz_master_record_input_inserted after insert on %s '
        'referencing new table as new_rows for each statement '
        'execute function content.note_master_record_input_rows(%L, %L, %L, %L)',
        r.table_name, array_to_string(r.object_columns, ','),
        array_to_string(r.version_columns, ','), array_to_string(r.guarded_columns, ','),
        coalesce(r.unconfined_when, ''));
      execute format(
        'create trigger zz_master_record_input_updated after update on %s '
        'referencing old table as old_rows new table as new_rows for each statement '
        'execute function content.note_master_record_input_rows(%L, %L, %L, %L)',
        r.table_name, array_to_string(r.object_columns, ','),
        array_to_string(r.version_columns, ','), array_to_string(r.guarded_columns, ','),
        coalesce(r.unconfined_when, ''));
      execute format(
        'create trigger zz_master_record_input_deleted after delete on %s '
        'referencing old table as old_rows for each statement '
        'execute function content.note_master_record_input_rows(%L, %L, %L, %L)',
        r.table_name, array_to_string(r.object_columns, ','),
        array_to_string(r.version_columns, ','), array_to_string(r.guarded_columns, ','),
        coalesce(r.unconfined_when, ''));
    else
      execute format(
        'create trigger zz_master_record_input_written '
        'after insert or update or delete or truncate on %s '
        'for each statement execute function content.note_master_record_input_write()',
        r.table_name);
    end if;
    v_count := v_count + 1;
  end loop;
  perform content.install_master_record_version_objects();
  return v_count;
end
$$;

revoke all on function content.install_master_record_input_triggers() from public;

-- (Re)write content.master_record_objects_of_versions from the catalog: the records whose payload
-- an artifact version is part of — the artifact it versions, and every record a row holding a key
-- to that version names. A superset of what the payload walk reads. Resolved when a reading asks,
-- not when the version is written, so a row that comes to hold the version later is found too.
create function content.install_master_record_version_objects() returns void
language plpgsql
set search_path = pg_catalog
as $$
declare
  r record;
  v_arms text[] := array[
    'select version.artifact_id from content.artifact_version version where version.id = any($1)'
  ];
  v_object text;
  v_version text;
begin
  -- Every table with a key to a version and to a record, confined or not: a write to a version
  -- moves the payload of every record that holds it, whichever table holds it.
  for r in select * from content.master_record_input_plan()
            where cardinality(version_columns) > 0 and cardinality(object_columns) > 0
              and table_name <> 'content.artifact_version' loop
    foreach v_version in array r.version_columns loop
      foreach v_object in array r.object_columns loop
        v_arms := v_arms || format(
          'select item.%s from %s item where item.%s = any($1) and item.%s is not null',
          v_object, r.table_name, v_version, v_object);
      end loop;
    end loop;
  end loop;
  execute format(
    'create or replace function content.master_record_objects_of_versions(p_versions uuid[]) '
    'returns setof uuid language sql stable security definer set search_path = pg_catalog '
    'as %L',
    array_to_string(v_arms, E'\nunion\n'));
  execute 'revoke all on function content.master_record_objects_of_versions(uuid[]) from public';
end
$$;

revoke all on function content.install_master_record_version_objects() from public;

select content.install_master_record_input_triggers();

/**
 * What the bound person's reading of `p_master_record` has to re-check to know it is current,
 * without reading the corpus: the claim's manifest format and the records written since the
 * snapshot of the reader's own compilation by writes that named them — an empty list when nothing
 * was written. No row when the claim cannot be vouched for this way: no matching currency row (the
 * same conditions as content.master_record_current_format), an unseen write that named nothing, or
 * more than `p_limit` records named. The caller then enumerates, exactly as before.
 *
 * The answer names records the reader may not be able to see; it never says anything about them,
 * and the caller re-checks them under the reader's own row security and grants.
 */
create function content.master_record_currency_delta(p_master_record uuid, p_limit integer)
returns table (manifest_format text, objects uuid[])
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
  v_currency record;
  v_objects  uuid[];
  v_versions uuid[];
begin
  if p_limit is null or p_limit < 0 then
    raise exception 'a delta limit must be a count' using errcode = 'invalid_parameter_value';
  end if;
  select currency.manifest_format, currency.organization_id, currency.snapshot
    into v_currency
    from content.master_record_currency currency
    join content.master_record master on master.id = currency.master_record_id
   where currency.master_record_id = p_master_record
     and master.person_id = core.sealed_setting('kf.principal', true)::uuid
     and master.organization_id = core.current_organization()
     and currency.organization_id = core.current_organization()
     and currency.acting_role_id = core.sealed_setting('kf.principal_assignment', true)::uuid
     and currency.classification_rank = core.current_classification_rank()
     and currency.expires_at > now()
     and (currency.valid_until is null or currency.valid_until > now())
     and currency.schema_fingerprint = content.master_record_schema_fingerprint()
   order by currency.recorded_at desc, currency.id desc
   limit 1;
  if not found then
    return;
  end if;
  -- An unseen write that named nothing: anything may have moved.
  if exists (
    select 1 from content.master_record_input_write written
     where (written.organization_id = v_currency.organization_id
            or written.organization_id is null)
       and written.object_id is null and written.version_id is null
       and written.xact >= pg_snapshot_xmin(v_currency.snapshot)
       and not pg_visible_in_snapshot(written.xact, v_currency.snapshot)
  ) then
    return;
  end if;
  select array_agg(named.object_id) into v_objects
    from (
      select distinct written.object_id
        from content.master_record_input_write written
       where (written.organization_id = v_currency.organization_id
              or written.organization_id is null)
         and written.object_id is not null
         and written.xact >= pg_snapshot_xmin(v_currency.snapshot)
         and not pg_visible_in_snapshot(written.xact, v_currency.snapshot)
       limit p_limit + 1
    ) as named;
  select array_agg(named.version_id) into v_versions
    from (
      select distinct written.version_id
        from content.master_record_input_write written
       where (written.organization_id = v_currency.organization_id
              or written.organization_id is null)
         and written.version_id is not null
         and written.xact >= pg_snapshot_xmin(v_currency.snapshot)
         and not pg_visible_in_snapshot(written.xact, v_currency.snapshot)
       limit p_limit + 1
    ) as named;
  if coalesce(cardinality(v_versions), 0) > p_limit then
    return;
  end if;
  if v_versions is not null then
    select array_agg(distinct held) into v_objects
      from (
        select unnest(coalesce(v_objects, '{}')) as held
        union
        select content.master_record_objects_of_versions(v_versions)
      ) as every(held);
  end if;
  if coalesce(cardinality(v_objects), 0) > p_limit then
    return;
  end if;
  manifest_format := v_currency.manifest_format;
  objects := coalesce(v_objects, '{}');
  return next;
end
$$;

revoke all on function content.master_record_currency_delta(uuid, integer) from public;
grant execute on function content.master_record_currency_delta(uuid, integer) to kf_app;

-- migrate:down

drop function content.master_record_currency_delta(uuid, integer);

create or replace function content.install_master_record_input_triggers() returns integer
language plpgsql
set search_path = pg_catalog
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select format('%I.%I', n.nspname, c.relname) as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and n.nspname in ('content', 'core', 'engineering', 'finance', 'ml', 'org', 'product',
                         'quality', 'registry', 'secure_object', 'work')
       and not exists (
         select 1 from content.master_record_input_exemption e
          where e.table_name = format('%I.%I', n.nspname, c.relname))
     order by 1
  loop
    execute format('drop trigger if exists zz_master_record_input_written on %s', r.tbl);
    execute format('drop trigger if exists zz_master_record_input_inserted on %s', r.tbl);
    execute format('drop trigger if exists zz_master_record_input_updated on %s', r.tbl);
    execute format('drop trigger if exists zz_master_record_input_deleted on %s', r.tbl);
    execute format(
      'create trigger zz_master_record_input_written '
      'after insert or update or delete or truncate on %s '
      'for each statement execute function content.note_master_record_input_write()', r.tbl);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

select content.install_master_record_input_triggers();

drop function content.master_record_objects_of_versions(uuid[]);
drop function content.install_master_record_version_objects();
drop function content.note_master_record_input_rows();
drop function content.master_record_input_plan();

-- Rows that named records collapse into the one row per transaction and organization they were:
-- the write still happened, and the older reading counts it.
insert into content.master_record_input_write (xact, organization_id, written_at, expires_at)
select xact, organization_id, min(written_at), max(expires_at)
  from content.master_record_input_write
 where object_id is not null or version_id is not null
 group by xact, organization_id
on conflict do nothing;
delete from content.master_record_input_write
 where object_id is not null or version_id is not null;
drop index content.master_record_input_write_unconfined;
drop index content.master_record_input_write_once;
alter table content.master_record_input_write
  drop constraint master_record_input_write_names_one,
  drop column object_id,
  drop column version_id;
create unique index master_record_input_write_once
  on content.master_record_input_write (xact, organization_id) nulls not distinct;

comment on table content.master_record_input_write is
  'Transient (§64B): which transactions wrote an input of a master-record permitted set, and for '
  'which organization (null: every organization). Read only through '
  'content.master_record_current_format; swept, keeping what a live currency row still needs.';
