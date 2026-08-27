-- migrate:up

-- OW-WAR-0054 OBL-006/OBL-008. A master-record item carries the governed typed-row payload
-- alongside its envelope identity and digest. The payload is assembled under the caller's RLS
-- context; it is not a second authority and it never reaches across a live external source.
alter table content.master_record_item
  add column content_payload jsonb not null default '{}'::jsonb
    constraint master_record_item_content_payload_object
      check (jsonb_typeof(content_payload) = 'object');

-- Return every RLS-visible row directly attached to an object, plus artifact versions that
-- carry the bytes/reference for an artifact. Catalog-driven discovery keeps this function
-- current as new typed tables are added: a compiler cannot silently omit a new object-bearing
-- table because its name was forgotten in a hand-maintained UNION. SECURITY INVOKER is
-- deliberate. The caller's organization/classification context is the boundary.
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
       and namespace.nspname not in ('pg_catalog', 'information_schema')
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
  end loop;

  -- Artifact versions are keyed by artifact_id rather than sharing the artifact object id.
  -- Their immutable storage URI/version and byte digest are part of the content claim.
  execute
    'select coalesce(jsonb_agg(to_jsonb(version) order by version.version_no), ''[]''::jsonb)
       from content.artifact_version version where version.artifact_id = $1'
    into v_rows using p_object;
  if v_rows <> '[]'::jsonb then
    v_payload := v_payload || jsonb_build_object('content.artifact_version', v_rows);
  end if;

  return v_payload;
end;
$$;

revoke all on function content.master_record_payload(uuid) from public;
grant execute on function content.master_record_payload(uuid) to kf_app;

-- Bind persisted payload to the manifest member. A caller cannot replace a full typed payload
-- with an envelope-only row while retaining the same object identity and digest.
drop policy master_record_item_insert on content.master_record_item;
create policy master_record_item_insert on content.master_record_item
  for insert with check (exists (
    select 1 from content.master_record master
     where master.id = master_record_item.master_record_id
       and master.recorded_by = core.current_actor()
       and master.recorded_by_action = core.current_action_id()
       and not exists (
         select 1 from core.audit_event event where event.action_id = master.recorded_by_action
       )
       and (
         (master_record_item.item_state = 'included'
          and exists (
            select 1
              from jsonb_array_elements(master.manifest -> 'included') member
             where member ->> 'objectId' = master_record_item.object_id::text
               and member ->> 'objectType' = master_record_item.object_type
               and member ->> 'contentDigest' = master_record_item.content_digest
               and coalesce(member -> 'content', '{}'::jsonb) = master_record_item.content_payload
          )
          and (
            (master_record_item.section = 'your_record'
             and (master.manifest -> 'sections' -> 'yourRecord') ? master_record_item.object_id::text)
            or
            (master_record_item.section = 'org_view'
             and (master.manifest -> 'sections' -> 'organizationView') ? master_record_item.object_id::text)
          ))
         or
         (master_record_item.item_state = 'withdrawn'
          and exists (
            select 1
              from jsonb_array_elements(master.manifest -> 'withdrawn') member
             where member ->> 'objectId' = master_record_item.object_id::text
               and member ->> 'objectType' = master_record_item.object_type
               and member ->> 'contentDigest' = master_record_item.content_digest
               and coalesce(member -> 'content', '{}'::jsonb) = master_record_item.content_payload
          ))
       )
  ));

-- migrate:down
-- kf:forward-only master-record typed payloads are part of completeness evidence and must not be downgraded
