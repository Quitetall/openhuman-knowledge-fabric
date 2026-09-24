-- migrate:up

-- A deliverable holds the fields the ontology declares for it (ontology/README.md).
--
-- `work.deliverable` predated the ontology's `deliverable` and disagreed with it: the table held
-- `deliverable_kind` and `definition_of_done`, the ontology `work_order`, `description`,
-- `acceptance_criteria` and `due_date`, and `define_deliverable` wrote the table. The ontology is
-- right — `deliverable` is an R01 type held byte-identical to the released pack, and its
-- `acceptance_criteria` are what an acceptance record's `criteria_results` are judged against — so
-- the table moves to it.
--
-- Nothing is lost. Each existing row's `definition_of_done` becomes its `description` and its one
-- acceptance criterion, and both retired values are kept, per deliverable, in
-- `work.deliverable_retired_attribute`: read-only, no application write grant, exported and
-- backed up with the record it describes.

alter table work.deliverable
  add column work_order_id       uuid,
  add column description         text,
  add column acceptance_criteria text[] not null default '{}',
  add column due_date            date;

/** Acceptance criteria as the ontology declares them: strings, none blank, a bounded list. */
create function work.acceptance_criteria_valid(p_criteria text[]) returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select cardinality(p_criteria) <= 64
     and coalesce(array_ndims(p_criteria), 1) = 1
     and not exists (
       select 1 from unnest(p_criteria) as c(criterion)
        where c.criterion is null or length(btrim(c.criterion)) not between 1 and 2000)
$$;

create table work.deliverable_retired_attribute (
  deliverable_id     uuid primary key references work.deliverable (id) on delete restrict,
  deliverable_kind   text not null,
  definition_of_done text not null,
  retired_at         timestamptz not null default now()
);

comment on table work.deliverable_retired_attribute is
  'The two work.deliverable columns the ontology does not declare (deliverable_kind, '
  'definition_of_done), as each deliverable held them when 20260925130100 retired them. Written '
  'once by that migration; no application role writes it.';

insert into work.deliverable_retired_attribute (deliverable_id, deliverable_kind, definition_of_done)
select id, deliverable_kind, definition_of_done from work.deliverable;

update work.deliverable
   set description = definition_of_done,
       acceptance_criteria = array[definition_of_done];

alter table work.deliverable
  alter column description set not null,
  add constraint deliverable_description_present
    check (length(btrim(description)) between 1 and 4000),
  add constraint deliverable_acceptance_criteria_valid
    check (work.acceptance_criteria_valid(acceptance_criteria)),
  -- A named work order must cover the deliverable's package: a deliverable due under an order
  -- that does not include its package is one nobody was engaged to hand over.
  add constraint deliverable_order_covers_package
    foreign key (work_order_id, work_package_id)
    references work.work_order_scope (work_order_id, work_package_id) on delete restrict,
  drop column deliverable_kind,
  drop column definition_of_done;

create index deliverable_by_order on work.deliverable (work_order_id)
  where work_order_id is not null;

alter table work.deliverable_retired_attribute enable row level security;
alter table work.deliverable_retired_attribute force row level security;

-- Visible exactly when the deliverable it describes is.
create policy deliverable_retired_attribute_read on work.deliverable_retired_attribute
  for select using (
    exists (select 1 from core.object envelope
             where envelope.id = deliverable_retired_attribute.deliverable_id)
  );
create policy deliverable_retired_attribute_backup_read on work.deliverable_retired_attribute
  for select to kf_backup using (true);

revoke all on work.deliverable_retired_attribute from public;
grant select on work.deliverable_retired_attribute
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;

-- migrate:down

alter table work.deliverable
  add column deliverable_kind text,
  add column definition_of_done text;

update work.deliverable d
   set deliverable_kind = coalesce(r.deliverable_kind, 'other'),
       definition_of_done = coalesce(r.definition_of_done, d.description)
  from work.deliverable d2
  left join work.deliverable_retired_attribute r on r.deliverable_id = d2.id
 where d2.id = d.id;

alter table work.deliverable
  alter column deliverable_kind set not null,
  alter column definition_of_done set not null,
  add constraint deliverable_deliverable_kind_check check (deliverable_kind in (
    'document', 'design', 'firmware', 'software', 'hardware', 'test_report',
    'data', 'service', 'other'
  )),
  add constraint deliverable_definition_of_done_check
    check (length(btrim(definition_of_done)) between 1 and 4000);

drop table work.deliverable_retired_attribute;
drop index work.deliverable_by_order;
alter table work.deliverable
  drop constraint deliverable_order_covers_package,
  drop constraint deliverable_acceptance_criteria_valid,
  drop constraint deliverable_description_present,
  drop column due_date,
  drop column acceptance_criteria,
  drop column description,
  drop column work_order_id;
drop function work.acceptance_criteria_valid(text[]);
