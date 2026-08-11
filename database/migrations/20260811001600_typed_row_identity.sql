-- migrate:up

-- Bind every typed row to the TYPE of the object it claims to be.
--
-- Until now each typed table keyed on `core.object (id)` and nothing more. That says the
-- object exists; it does not say the object is the kind of thing this table is about. So a
-- work-order row could be attached to a decision record's id, a supplier row to a person, an
-- invoice to a work package — and every one of those would satisfy the foreign key while
-- producing a record that is two different things at once.
--
-- Nothing in the application does that today. That is not the point: the dispatcher is one
-- path, and a constraint that only holds because the current code happens to be careful is a
-- convention. This makes it structural.
--
-- The mechanism is a composite key. `core.object` gains a unique (id, object_type); each
-- typed table gains a generated column holding its own type as a constant, and a foreign key
-- on the pair. The column cannot be written — it is `generated always` — so the type of a
-- typed row is not something a caller states, it is something the table IS.

alter table core.object add constraint object_id_type_unique unique (id, object_type);

-- One statement per table rather than a loop, so the type each table binds to is written
-- down and reviewable rather than derived from a naming convention.
do $$
declare
  binding record;
begin
  for binding in
    select * from (values
      ('work',        'initiative_project',    'initiative_project'),
      ('work',        'milestone',             'milestone'),
      ('work',        'work_package',          'work_package'),
      ('work',        'work_order',            'work_order'),
      ('work',        'work_order_amendment',  'work_order_amendment'),
      ('work',        'deliverable',           'deliverable'),
      ('work',        'work_execution',        'work_execution'),
      ('work',        'acceptance_record',     'acceptance_record'),
      ('finance',     'invoice',               'invoice'),
      ('finance',     'payment',               'payment'),
      ('product',     'configuration_item',    'configuration_item'),
      ('product',     'interface_contract',    'interface_contract'),
      ('product',     'physical_binding',      'physical_binding'),
      ('quality',     'controlled_document',   'controlled_document'),
      ('quality',     'nonconformity',         'nonconformity'),
      ('quality',     'capa',                  'capa'),
      ('quality',     'supplier',              'supplier'),
      ('quality',     'equipment',             'equipment'),
      ('quality',     'complaint',             'complaint'),
      ('engineering', 'risk_control',          'risk_control'),
      ('engineering', 'test_definition',       'test_definition'),
      ('engineering', 'test_execution',        'test_execution'),
      ('content',     'artifact',              'artifact'),
      ('org',         'organization',          'organization'),
      ('org',         'person',                'person'),
      ('org',         'engagement',            'engagement'),
      ('org',         'role_assignment',       'role_assignment')
    ) as t(schema_name, table_name, object_type)
  loop
    -- The type is a constant of the table, not a value of the row: `generated always` means
    -- no INSERT can state it and no UPDATE can change it.
    execute format(
      'alter table %I.%I add column object_type text
         generated always as (%L::text) stored',
      binding.schema_name, binding.table_name, binding.object_type);

    execute format(
      'alter table %I.%I add constraint %I
         foreign key (id, object_type) references core.object (id, object_type)',
      binding.schema_name, binding.table_name,
      binding.table_name || '_is_' || binding.object_type);
  end loop;
end $$;

comment on constraint object_id_type_unique on core.object is
  'Lets typed tables key on (id, object_type), so a typed row cannot attach to an object of '
  'a different kind. Without it a supplier row could be hung on a person.';

-- migrate:down

do $$
declare
  binding record;
begin
  for binding in
    select table_schema, table_name
      from information_schema.columns
     where column_name = 'object_type'
       and table_schema in ('work', 'finance', 'product', 'quality', 'engineering', 'content', 'org')
  loop
    execute format('alter table %I.%I drop column object_type',
                   binding.table_schema, binding.table_name);
  end loop;
end $$;

alter table core.object drop constraint object_id_type_unique;
