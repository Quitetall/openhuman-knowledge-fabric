-- migrate:up

-- Retirement sequesters source history. Exact old revisions remain queryable, but no new
-- active composition, compilation Basis, acceptance, or publication may make a subject whose
-- latest authority state is retired contribute again. Locking fragment object rows closes the
-- retire-vs-compose/finalize race under both application and direct typed SQL paths.

create function content.assert_fragment_revisions_active(p_revision_ids uuid[]) returns void
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_revision_ids uuid[];
  v_locked integer;
begin
  select coalesce(array_agg(distinct id order by id), array[]::uuid[])
    into v_revision_ids
    from unnest(coalesce(p_revision_ids, array[]::uuid[])) requested(id);
  if cardinality(v_revision_ids) = 0 then
    return;
  end if;

  -- Every lifecycle transition for an Authored Fragment locks the same core.object row.
  -- Sorted acquisition prevents two multi-fragment compositions from deadlocking each other.
  perform object.id
    from unnest(v_revision_ids) requested(id)
    join content.authored_fragment_revision revision on revision.id = requested.id
    join content.document_subject subject on subject.id = revision.fragment_id
    join core.object object on object.id = subject.object_id
   order by object.id, revision.id
   for update of object;
  get diagnostics v_locked = row_count;
  if v_locked <> cardinality(v_revision_ids) then
    raise exception 'composition references a missing authored fragment revision'
      using errcode = 'integrity_constraint_violation';
  end if;

  if exists (
    select 1
      from unnest(v_revision_ids) requested_id(id)
      join content.authored_fragment_revision requested on requested.id = requested_id.id
      join content.document_subject subject on subject.id = requested.fragment_id
      join core.object object on object.id = subject.object_id
      join lateral (
        select candidate.revision_state
          from content.authored_fragment_revision candidate
         where candidate.fragment_id = requested.fragment_id
           and not exists (
             select 1 from content.authored_fragment_revision successor
              where successor.previous_revision_id = candidate.id
           )
      ) latest on true
     where requested.revision_state = 'retired'
        or latest.revision_state = 'retired'
        or object.lifecycle_state <> 'active'
  ) then
    raise exception 'retired authored fragment cannot contribute to active documentation'
      using errcode = 'integrity_constraint_violation';
  end if;
end
$$;

revoke all on function content.assert_fragment_revisions_active(uuid[]) from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create function content.enforce_active_composition_input() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_fragments uuid[];
begin
  if new.fragment_revision_id is not null then
    v_fragments := array[new.fragment_revision_id];
  elsif new.child_composition_revision_id is not null then
    with recursive reachable(id) as (
      select new.child_composition_revision_id
      union
      select input.child_composition_revision_id
        from reachable parent
        join content.composition_input input on input.composition_revision_id = parent.id
       where input.child_composition_revision_id is not null
    )
    select coalesce(array_agg(distinct input.fragment_revision_id
                              order by input.fragment_revision_id), array[]::uuid[])
      into v_fragments
      from reachable parent
      join content.composition_input input on input.composition_revision_id = parent.id
     where input.fragment_revision_id is not null;
  else
    return new;
  end if;

  perform content.assert_fragment_revisions_active(v_fragments);
  return new;
end
$$;

revoke all on function content.enforce_active_composition_input() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create trigger composition_input_active_fragments
  before insert on content.composition_input
  for each row execute function content.enforce_active_composition_input();

create function content.enforce_active_basis_fragments() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_fragments uuid[];
begin
  select coalesce(array_agg(fragment_revision_id order by fragment_revision_id),
                  array[]::uuid[])
    into v_fragments
    from content.compilation_basis_fragment
   where basis_id = new.id;
  perform content.assert_fragment_revisions_active(v_fragments);
  return new;
end
$$;

revoke all on function content.enforce_active_basis_fragments() from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

create trigger compilation_basis_active_fragments
  before update of finalized_at on content.compilation_basis
  for each row
  when (old.finalized_at is null and new.finalized_at is not null)
  execute function content.enforce_active_basis_fragments();

-- migrate:down

drop trigger if exists compilation_basis_active_fragments on content.compilation_basis;
drop function if exists content.enforce_active_basis_fragments();
drop trigger if exists composition_input_active_fragments on content.composition_input;
drop function if exists content.enforce_active_composition_input();
drop function if exists content.assert_fragment_revisions_active(uuid[]);
