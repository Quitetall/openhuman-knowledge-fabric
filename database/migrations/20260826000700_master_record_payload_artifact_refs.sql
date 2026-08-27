-- migrate:up

-- OW-WAR-0054 OBL-006/OBL-008. Typed rows may point at immutable artifact versions without
-- making the artifact itself a member of the permission set (for example,
-- quality.controlled_document.content_version). Include those direct references in the
-- governed payload so a record never claims full content while retaining only the version id.
-- The catalog lookup is deliberately limited to rows directly attached to this object; it does
-- not walk arbitrary author/provenance foreign keys and accidentally turn one person's record
-- into the organization's entire connected component.
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

  -- 1:1 typed extensions have an id FK to core.object. Keep their full row, subject to RLS.
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

    -- A typed extension can carry one or more immutable artifact-version references. Collect
    -- their ids under the same RLS context; the version rows are added below in canonical order.
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

  -- Direct object references (evidence, links, relationships) are retained as arrays. The
  -- order is canonicalized by JSON text, so row order cannot change the master digest.
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

    -- Child rows directly attached through an object FK may also carry an artifact version.
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

  -- Artifact objects own their versions by artifact_id. Merge those with versions referenced
  -- by typed rows; duplicate ids are removed before serialisation.
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

    -- Locators and derivation links are part of the immutable byte/reference claim. They remain
    -- arrays because one version may have several external locations or relationships.
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

-- migrate:down
-- kf:forward-only expanding master-record payloads changes immutable claim bytes and cannot safely downgrade existing manifests
