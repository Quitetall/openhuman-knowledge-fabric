-- migrate:up

-- The master-record payload, read for a set of objects in one pass (KF-SAS-RQ-201, ADR 0024).
--
-- WHY. `content.master_record_payload(uuid)` (20260826000700) answers for ONE object, and the
-- permission-set enumeration called it once per visible object. Each call walked the catalog
-- (35 typed-extension tables and 82 object-keyed foreign-key columns when this was written) and
-- issued one dynamic statement per table and per column, plus one catalog lookup per table for
-- artifact-version references: about 235 planned statements for every object, every time. Every
-- Object View read enumerates the reader's permitted set to decide whether their claim is still
-- current, so a view cost ~65 ms per object in the organization — measured at 16 objects, ~1 s,
-- 398 436 shared buffer hits for the enumeration alone (25 000 per object), and linear beyond.
--
-- WHAT CHANGES. `content.master_record_payloads(uuid[])` builds ONE statement from the same
-- catalog walk — one arm per typed extension, one per foreign-key column, the artifact-version
-- references collected by the same rules — and runs it once over every requested object. The
-- number of planned statements no longer depends on how many objects are asked about.
--
-- WHAT DOES NOT CHANGE. The payload of each object, byte for byte: the same keys, the same rows,
-- the same orderings (typed-row arrays by their JSON text; artifact versions by version number
-- then id; locators and relationships by id). It is still SECURITY INVOKER, so every row it reads
-- is read under the caller's row security and bound principal, exactly as before; it widens
-- nothing. The equivalence is held by tests/database/master-record-payloads.test.ts against the
-- 20260826000700 implementation itself, loaded from its migration file.
--
-- One deliberate strictness: two typed-extension rows with the same id for one object were read
-- by `select … into`, which kept whichever came first — a payload, and so a corpus digest, that
-- could differ between two reads of the same data. The one-pass form aggregates with
-- `jsonb_object_agg_unique` and refuses instead. Every typed extension keys `id` as its primary
-- key today, so this cannot fire; it is there so that it cannot fire silently later.
--
-- `content.master_record_payload(uuid)` stays, with its grant, as the one-object case of the
-- same implementation, so there are not two readings of "the payload" to drift apart.

create function content.master_record_payloads(p_objects uuid[])
returns table (object_id uuid, payload jsonb)
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $$
declare
  v_parts text[] := array[
    'select envelope.id, ''core.object'', to_jsonb(envelope)
       from core.object envelope where envelope.id = any($1)'
  ];
  v_refs text[] := array[
    'select version.artifact_id, version.id
       from content.artifact_version version where version.artifact_id = any($1)'
  ];
  v_schema text;
  v_table text;
  v_column text;
  v_artifact_fk_col text;
begin
  -- 1:1 typed extensions have an id FK to core.object. Keep their full row, subject to RLS.
  -- The same catalog walk as 20260826000700, statement for statement.
  for v_schema, v_table in
    select namespace.nspname, relation.relname
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_attribute id_column
        on id_column.attrelid = relation.oid
       and id_column.attname = 'id'
       and id_column.attnum > 0
       and not id_column.attisdropped
     where relation.relkind = 'r'
       and relation.relrowsecurity
       and namespace.nspname in ('content', 'engineering', 'finance', 'ml', 'org', 'product', 'quality', 'secure_object', 'work')
       and relation.relname not like 'master_record%'
       and relation.relname <> 'person_entitlement_exclusion'
       and exists (
         select 1
           from pg_constraint constraint_row
          where constraint_row.conrelid = relation.oid
            and constraint_row.contype = 'f'
            and constraint_row.confrelid = 'core.object'::regclass
            and constraint_row.conkey = array[id_column.attnum]::smallint[]
       )
     order by namespace.nspname, relation.relname
  loop
    v_parts := v_parts || format(
      'select item.id, %L, to_jsonb(item) from %I.%I item where item.id = any($1)',
      v_schema || '.' || v_table,
      v_schema,
      v_table
    );
    for v_artifact_fk_col in
      select child_column.attname
        from pg_constraint constraint_row
        join pg_class child_relation on child_relation.oid = constraint_row.conrelid
        join pg_namespace child_namespace on child_namespace.oid = child_relation.relnamespace
        join pg_attribute child_column
          on child_column.attrelid = child_relation.oid
         and child_column.attnum = constraint_row.conkey[1]
         and child_column.attnum > 0
         and not child_column.attisdropped
       where child_namespace.nspname = v_schema
         and child_relation.relname = v_table
         and child_relation.relkind = 'r'
         and constraint_row.contype = 'f'
         and constraint_row.confrelid = 'content.artifact_version'::regclass
         and array_length(constraint_row.conkey, 1) = 1
         and array_length(constraint_row.confkey, 1) = 1
    loop
      v_refs := v_refs || format(
        'select item.id, item.%I from %I.%I item where item.id = any($1)',
        v_artifact_fk_col,
        v_schema,
        v_table
      );
    end loop;
  end loop;

  -- Direct object references (evidence, links, relationships) are retained as arrays, ordered by
  -- JSON text so row order cannot change the master digest.
  for v_schema, v_table, v_column in
    select namespace.nspname, relation.relname, column_row.attname
      from pg_constraint constraint_row
      join pg_class relation on relation.oid = constraint_row.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_attribute column_row
        on column_row.attrelid = relation.oid
       and column_row.attnum = constraint_row.conkey[1]
       and column_row.attnum > 0
       and not column_row.attisdropped
     where constraint_row.contype = 'f'
       and constraint_row.confrelid = 'core.object'::regclass
       and array_length(constraint_row.conkey, 1) = 1
       and relation.relkind = 'r'
       and relation.relrowsecurity
       and namespace.nspname in ('content', 'engineering', 'finance', 'ml', 'org', 'product', 'quality', 'secure_object', 'work')
       and relation.relname not like 'master_record%'
       and relation.relname <> 'person_entitlement_exclusion'
     order by namespace.nspname, relation.relname, column_row.attname
  loop
    v_parts := v_parts || format(
      'select item.%1$I, %2$L, jsonb_agg(to_jsonb(item) order by to_jsonb(item)::text)
         from %3$I.%4$I item where item.%1$I = any($1) group by item.%1$I',
      v_column,
      v_schema || '.' || v_table || '.' || v_column,
      v_schema,
      v_table
    );
    for v_artifact_fk_col in
      select child_column.attname
        from pg_constraint constraint_row
        join pg_class child_relation on child_relation.oid = constraint_row.conrelid
        join pg_namespace child_namespace on child_namespace.oid = child_relation.relnamespace
        join pg_attribute child_column
          on child_column.attrelid = child_relation.oid
         and child_column.attnum = constraint_row.conkey[1]
         and child_column.attnum > 0
         and not child_column.attisdropped
       where child_namespace.nspname = v_schema
         and child_relation.relname = v_table
         and child_relation.relkind = 'r'
         and constraint_row.contype = 'f'
         and constraint_row.confrelid = 'content.artifact_version'::regclass
         and array_length(constraint_row.conkey, 1) = 1
         and array_length(constraint_row.confkey, 1) = 1
    loop
      v_refs := v_refs || format(
        'select item.%I, item.%I from %I.%I item where item.%I = any($1)',
        v_column,
        v_artifact_fk_col,
        v_schema,
        v_table,
        v_column
      );
    end loop;
  end loop;

  -- One statement. Artifact versions, their locators and their derivation links are read for the
  -- deduplicated set of versions each object references, as the one-object form did; a null
  -- reference matched nothing there and is dropped here.
  return query execute format(
    $sql$
    with requested(id) as (
      select distinct requested.id from unnest($1::uuid[]) as requested(id)
       where requested.id is not null
    ),
    refs(object_id, version_id) as (
      %1$s
    ),
    versions(object_id, ids) as (
      select refs.object_id, array_agg(distinct refs.version_id order by refs.version_id)
        from refs
       where refs.version_id is not null
       group by refs.object_id
    ),
    parts(object_id, part, value) as (
      %2$s
      union all
      select versions.object_id, 'content.artifact_version',
             (select jsonb_agg(to_jsonb(version) order by version.version_no, version.id)
                from content.artifact_version version
               where version.id = any(versions.ids))
        from versions
      union all
      select versions.object_id, 'content.external_locator',
             (select jsonb_agg(to_jsonb(locator) order by locator.id)
                from content.external_locator locator
               where locator.version_id = any(versions.ids))
        from versions
      union all
      select versions.object_id, 'content.artifact_relationship',
             (select jsonb_agg(to_jsonb(relationship) order by relationship.id)
                from content.artifact_relationship relationship
               where relationship.from_version = any(versions.ids)
                  or relationship.to_version = any(versions.ids))
        from versions
    )
    select requested.id,
           coalesce(
             jsonb_object_agg_unique(parts.part, parts.value)
               filter (where parts.value is not null),
             '{}'::jsonb)
      from requested
      left join parts on parts.object_id = requested.id
     group by requested.id
     order by requested.id
    $sql$,
    array_to_string(v_refs, E'\n      union all\n      '),
    array_to_string(v_parts, E'\n      union all\n      ')
  ) using p_objects;
end;
$$;

revoke all on function content.master_record_payloads(uuid[]) from public;
grant execute on function content.master_record_payloads(uuid[]) to kf_app;

comment on function content.master_record_payloads(uuid[]) is
  'The master-record payload of each requested object, under the caller''s row security, read in '
  'one statement whatever the number of objects (20260925121500). Same bytes as the one-object '
  'form, which is now this function applied to one id.';

-- The one-object form: the same implementation, applied to one id.
create or replace function content.master_record_payload(p_object uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select coalesce(
    (select payloads.payload from content.master_record_payloads(array[p_object]) payloads),
    '{}'::jsonb)
$$;

-- migrate:down

-- Restore the one-object implementation of 20260826000700 verbatim, then drop the batch form.
create or replace function content.master_record_payload(p_object uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $$
declare
  v_payload jsonb := '{}'::jsonb;
  v_row jsonb;
  v_rows jsonb;
  v_schema text;
  v_table text;
  v_column text;
  v_key text;
  v_artifact_fk_col text;
  v_fk_ids uuid[];
  v_artifact_version_ids uuid[] := '{}'::uuid[];
begin
  select to_jsonb(envelope)
    into v_row
    from core.object envelope
   where envelope.id = p_object;
  if v_row is not null then
    v_payload := v_payload || jsonb_build_object('core.object', v_row);
  end if;

  for v_schema, v_table in
    select namespace.nspname, relation.relname
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_attribute id_column
        on id_column.attrelid = relation.oid
       and id_column.attname = 'id'
       and id_column.attnum > 0
       and not id_column.attisdropped
     where relation.relkind = 'r'
       and relation.relrowsecurity
       and namespace.nspname in ('content', 'engineering', 'finance', 'ml', 'org', 'product', 'quality', 'secure_object', 'work')
       and relation.relname not like 'master_record%'
       and relation.relname <> 'person_entitlement_exclusion'
       and exists (
         select 1
           from pg_constraint constraint_row
          where constraint_row.conrelid = relation.oid
            and constraint_row.contype = 'f'
            and constraint_row.confrelid = 'core.object'::regclass
            and constraint_row.conkey = array[id_column.attnum]::smallint[]
       )
     order by namespace.nspname, relation.relname
  loop
    execute format(
      'select to_jsonb(item) from %I.%I item where item.id = $1',
      v_schema,
      v_table
    ) into v_row using p_object;
    if v_row is not null then
      v_payload := v_payload || jsonb_build_object(v_schema || '.' || v_table, v_row);
    end if;

    for v_artifact_fk_col in
      select child_column.attname
        from pg_constraint constraint_row
        join pg_class child_relation on child_relation.oid = constraint_row.conrelid
        join pg_namespace child_namespace on child_namespace.oid = child_relation.relnamespace
        join pg_attribute child_column
          on child_column.attrelid = child_relation.oid
         and child_column.attnum = constraint_row.conkey[1]
         and child_column.attnum > 0
         and not child_column.attisdropped
       where child_namespace.nspname = v_schema
         and child_relation.relname = v_table
         and child_relation.relkind = 'r'
         and constraint_row.contype = 'f'
         and constraint_row.confrelid = 'content.artifact_version'::regclass
         and array_length(constraint_row.conkey, 1) = 1
         and array_length(constraint_row.confkey, 1) = 1
    loop
      execute format(
        'select coalesce(array_agg(item.%I), ''{}''::uuid[]) from %I.%I item where item.id = $1',
        v_artifact_fk_col,
        v_schema,
        v_table
      ) into v_fk_ids using p_object;
      v_artifact_version_ids := v_artifact_version_ids || coalesce(v_fk_ids, '{}'::uuid[]);
    end loop;
  end loop;

  for v_schema, v_table, v_column in
    select namespace.nspname, relation.relname, column_row.attname
      from pg_constraint constraint_row
      join pg_class relation on relation.oid = constraint_row.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join pg_attribute column_row
        on column_row.attrelid = relation.oid
       and column_row.attnum = constraint_row.conkey[1]
       and column_row.attnum > 0
       and not column_row.attisdropped
     where constraint_row.contype = 'f'
       and constraint_row.confrelid = 'core.object'::regclass
       and array_length(constraint_row.conkey, 1) = 1
       and relation.relkind = 'r'
       and relation.relrowsecurity
       and namespace.nspname in ('content', 'engineering', 'finance', 'ml', 'org', 'product', 'quality', 'secure_object', 'work')
       and relation.relname not like 'master_record%'
       and relation.relname <> 'person_entitlement_exclusion'
     order by namespace.nspname, relation.relname, column_row.attname
  loop
    v_key := v_schema || '.' || v_table || '.' || v_column;
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(item) order by to_jsonb(item)::text), ''[]''::jsonb)
         from %I.%I item where item.%I = $1',
      v_schema,
      v_table,
      v_column
    ) into v_rows using p_object;
    if v_rows <> '[]'::jsonb then
      v_payload := v_payload || jsonb_build_object(v_key, v_rows);
    end if;

    for v_artifact_fk_col in
      select child_column.attname
        from pg_constraint constraint_row
        join pg_class child_relation on child_relation.oid = constraint_row.conrelid
        join pg_namespace child_namespace on child_namespace.oid = child_relation.relnamespace
        join pg_attribute child_column
          on child_column.attrelid = child_relation.oid
         and child_column.attnum = constraint_row.conkey[1]
         and child_column.attnum > 0
         and not child_column.attisdropped
       where child_namespace.nspname = v_schema
         and child_relation.relname = v_table
         and child_relation.relkind = 'r'
         and constraint_row.contype = 'f'
         and constraint_row.confrelid = 'content.artifact_version'::regclass
         and array_length(constraint_row.conkey, 1) = 1
         and array_length(constraint_row.confkey, 1) = 1
    loop
      execute format(
        'select coalesce(array_agg(item.%I), ''{}''::uuid[]) from %I.%I item where item.%I = $1',
        v_artifact_fk_col,
        v_schema,
        v_table,
        v_column
      ) into v_fk_ids using p_object;
      v_artifact_version_ids := v_artifact_version_ids || coalesce(v_fk_ids, '{}'::uuid[]);
    end loop;
  end loop;

  select coalesce(array_agg(version.id order by version.id), '{}'::uuid[])
    into v_fk_ids
    from content.artifact_version version
   where version.artifact_id = p_object;
  v_artifact_version_ids := v_artifact_version_ids || coalesce(v_fk_ids, '{}'::uuid[]);
  select coalesce(array_agg(distinct ids.id order by ids.id), '{}'::uuid[])
    into v_artifact_version_ids
    from unnest(v_artifact_version_ids) as ids(id);

  if cardinality(v_artifact_version_ids) > 0 then
    select coalesce(jsonb_agg(to_jsonb(version) order by version.version_no, version.id), '[]'::jsonb)
      into v_rows
      from content.artifact_version version
     where version.id = any(v_artifact_version_ids);
    if v_rows <> '[]'::jsonb then
      v_payload := v_payload || jsonb_build_object('content.artifact_version', v_rows);
    end if;

    select coalesce(jsonb_agg(to_jsonb(locator) order by locator.id), '[]'::jsonb)
      into v_rows
      from content.external_locator locator
     where locator.version_id = any(v_artifact_version_ids);
    if v_rows <> '[]'::jsonb then
      v_payload := v_payload || jsonb_build_object('content.external_locator', v_rows);
    end if;

    select coalesce(jsonb_agg(to_jsonb(relationship) order by relationship.id), '[]'::jsonb)
      into v_rows
      from content.artifact_relationship relationship
     where relationship.from_version = any(v_artifact_version_ids)
        or relationship.to_version = any(v_artifact_version_ids);
    if v_rows <> '[]'::jsonb then
      v_payload := v_payload || jsonb_build_object('content.artifact_relationship', v_rows);
    end if;
  end if;

  return v_payload;
end;
$$;

drop function content.master_record_payloads(uuid[]);
