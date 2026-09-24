-- migrate:up

-- A master-record payload carries each artifact relationship whole, and names the reading it is.
--
-- THE DEFECT. The payload of an object that references artifact versions carries the derivation
-- links between them, `content.artifact_relationship`. Every implementation since 20260826000700
-- wrote `to_jsonb(relationship) … from content.artifact_relationship relationship`, and that
-- table has a column called `relationship`: PostgreSQL resolves the bare name to the column
-- before the row, so the payload recorded `["supersedes"]` — the kind, without which versions it
-- links. Two corpora that differ only in which version supersedes which read as the same.
--
-- WHY IT IS VERSIONED, NOT FIXED IN PLACE. The payload is inside every member's content digest,
-- and so inside `corpus_digest`, and a stored claim is re-checked on every read by enumerating the
-- corpus again. Changing the bytes under recorded claims would make every one of them stale. So
-- the reading is named, and chosen by the member format the claim recorded (KF-SAS-RQ-016):
--
--   kf-master-record-payload-v1  the reading as recorded (the defect kept, byte for byte)
--                                — kf-master-record-member-v1, manifests kf-master-record-v1/-v2
--   kf-master-record-payload-v2  every row turned into JSON as `to_jsonb(alias.*)`, which is the
--                                row whatever its columns are called
--                                — kf-master-record-member-v2, manifests kf-master-record-v3
--
-- The two differ only where a column shares its alias's name; today that is the relationship
-- arm. Both functions now take the format and have no default, so no caller can read one
-- believing it is the other. Everything else about 20260925121500 — one statement, SECURITY
-- INVOKER, the orderings, the duplicate refusal — is unchanged.

drop function content.master_record_payload(uuid);
drop function content.master_record_payloads(uuid[]);

create function content.master_record_payloads(p_objects uuid[], p_format text)
returns table (object_id uuid, payload jsonb)
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $$
declare
  v_parts text[];
  -- How each row is turned into JSON. v1 wrote `to_jsonb(alias)`, which is the ROW only while
  -- no column of that table shares the alias's name; content.artifact_relationship has a
  -- `relationship` column, so v1 recorded that column's text. v2 writes `to_jsonb(alias.*)`,
  -- which is the row whatever the columns are called.
  v_row text;
  v_refs text[] := array[
    'select version.artifact_id, version.id
       from content.artifact_version version where version.artifact_id = any($1)'
  ];
  v_schema text;
  v_table text;
  v_column text;
  v_artifact_fk_col text;
begin
  if p_format = 'kf-master-record-payload-v1' then
    v_row := '';
  elsif p_format = 'kf-master-record-payload-v2' then
    v_row := '.*';
  else
    raise exception 'unknown master-record payload format %', coalesce(p_format, 'null')
      using errcode = 'invalid_parameter_value';
  end if;
  v_parts := array[format(
    'select envelope.id, ''core.object'', to_jsonb(envelope%s)
       from core.object envelope where envelope.id = any($1)',
    v_row
  )];

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
      'select item.id, %L, to_jsonb(item%s) from %I.%I item where item.id = any($1)',
      v_schema || '.' || v_table,
      v_row,
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
      'select item.%1$I, %2$L, jsonb_agg(to_jsonb(item%5$s) order by to_jsonb(item%5$s)::text)
         from %3$I.%4$I item where item.%1$I = any($1) group by item.%1$I',
      v_column,
      v_schema || '.' || v_table || '.' || v_column,
      v_schema,
      v_table,
      v_row
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
             (select jsonb_agg(to_jsonb(version%3$s) order by version.version_no, version.id)
                from content.artifact_version version
               where version.id = any(versions.ids))
        from versions
      union all
      select versions.object_id, 'content.external_locator',
             (select jsonb_agg(to_jsonb(locator%3$s) order by locator.id)
                from content.external_locator locator
               where locator.version_id = any(versions.ids))
        from versions
      union all
      select versions.object_id, 'content.artifact_relationship',
             (select jsonb_agg(to_jsonb(relationship%3$s) order by relationship.id)
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
    array_to_string(v_parts, E'\n      union all\n      '),
    v_row
  ) using p_objects;
end;
$$;

revoke all on function content.master_record_payloads(uuid[], text) from public;
grant execute on function content.master_record_payloads(uuid[], text) to kf_app;

comment on function content.master_record_payloads(uuid[], text) is
  'The master-record payload of each requested object under the named reading, read under the '
  'caller''s row security in one statement. kf-master-record-payload-v1 is the reading claims '
  'with kf-master-record-member-v1 recorded (artifact relationships as their kind only); '
  'kf-master-record-payload-v2 carries every row whole (20260925130000).';

-- The one-object form: the same implementation, applied to one id, under the named reading.
create function content.master_record_payload(p_object uuid, p_format text)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $$
  select coalesce(
    (select payloads.payload
       from content.master_record_payloads(array[p_object], p_format) payloads),
    '{}'::jsonb)
$$;

revoke all on function content.master_record_payload(uuid, text) from public;
grant execute on function content.master_record_payload(uuid, text) to kf_app;

-- migrate:down
-- kf:forward-only claims compiled after this migration carry kf-master-record-payload-v2 member content; restoring the one-argument reading would make every such claim read as stale, and no reading could re-check it
