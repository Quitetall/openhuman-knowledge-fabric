-- migrate:up

-- `composition_input_scope` cost ~950ms to count THREE rows, measured on both the test harness
-- and the dev database. The predicate is fine; what was wrong was where it ran.
--
-- The policy is `exists(composition_revision)` AND a CASE over six branches, each an `exists`
-- against a DIFFERENT RLS-protected table. Every referenced table carries four permissive
-- policies of its own, and its `_scope` policy references further protected tables
-- (composition_revision -> document_composition -> core.object, and so on). PostgreSQL inlines
-- all of that into the calling query, so one `count(*)` planned out to InitPlan 1307 / SubPlan
-- 1306 — over thirteen hundred subplans.
--
-- The cost is not the depth by itself. The planner de-correlates each `exists` and turns it into
-- a HASHED subplan — `ANY (id = (hashed SubPlan 22).col1)` — which means it materialises the
-- ENTIRE visible set of each referenced table, recursively, before it can filter one row. That
-- is why the price is fixed rather than per-row, and why more rows would not amortise it.
--
-- Moving the identical predicate into a PL/pgSQL function stops the inlining: a PL/pgSQL body is
-- opaque to the caller's planner, each statement inside is planned separately and plan-cached,
-- and the referent lookups become single-row index probes on a passed parameter instead of
-- whole-table visible-set materialisations.
--
-- SECURITY INVOKER — the default, stated here because it is load-bearing. The body's queries run
-- with the CALLER's rights, so every referenced table's own RLS still applies exactly as it did
-- when the predicate was inline. That is what makes this a change of plan shape and not a change
-- of who can see what. SECURITY DEFINER would bypass RLS inside the body and force the
-- visibility rules to be re-implemented by hand, which is the version of this change that can
-- silently leak.
--
-- NOT STRICT, deliberately. A composition_input row sets exactly ONE of the five referent
-- columns and leaves the other four NULL, so `returns null on null input` would make the
-- function return NULL for every row in the table and RLS would read that as false — denying
-- everything, on every path, while looking like a tidy annotation.
--
-- PARALLEL UNSAFE, by omission and on purpose. Read-only bodies are normally parallel safe, but
-- this table is small enough that no test would ever produce a parallel plan, so a `parallel
-- safe` marking here would be an assertion nothing in the suite could falsify. Left conservative
-- until there is a reason and a way to measure it.
create function content.composition_input_visible(
  p_composition_revision_id uuid,
  p_input_role text,
  p_fragment_revision_id uuid,
  p_child_composition_revision_id uuid,
  p_resource_version_id uuid,
  p_binding_id uuid,
  p_compiled_view_id uuid
) returns boolean
language plpgsql
stable
as $fn$
begin
  if not exists (
    select 1 from content.composition_revision r where r.id = p_composition_revision_id
  ) then
    return false;
  end if;

  return case p_input_role
    when 'fragment' then exists (
      select 1 from content.authored_fragment_revision r where r.id = p_fragment_revision_id)
    when 'composition' then exists (
      select 1 from content.composition_revision r where r.id = p_child_composition_revision_id)
    when 'resource' then exists (
      select 1
        from content.artifact_version av
        join content.artifact a on a.id = av.artifact_id
        join core.object o on o.id = a.id
       where av.id = p_resource_version_id)
    when 'binding' then exists (
      select 1 from content.typed_binding b where b.id = p_binding_id)
    when 'generated_view' then exists (
      select 1 from content.compiled_view v where v.id = p_compiled_view_id)
    else false
  end;
end;
$fn$;

comment on function content.composition_input_visible(uuid, text, uuid, uuid, uuid, uuid, uuid) is
  'Visibility predicate for content.composition_input, identical to the inline policy it '
  'replaced. SECURITY INVOKER so the referenced tables enforce their own RLS; exists only to '
  'stop the planner inlining six recursive policy chains into every calling query.';

drop policy composition_input_scope on content.composition_input;

create policy composition_input_scope on content.composition_input
  for all
  using (
    content.composition_input_visible(
      composition_revision_id, input_role, fragment_revision_id,
      child_composition_revision_id, resource_version_id, binding_id, compiled_view_id)
  )
  with check (
    content.composition_input_visible(
      composition_revision_id, input_role, fragment_revision_id,
      child_composition_revision_id, resource_version_id, binding_id, compiled_view_id)
  );

-- migrate:down

drop policy composition_input_scope on content.composition_input;

-- Restored verbatim from 20260814000100_document_compiler.sql.
create policy composition_input_scope on content.composition_input
  for all
  using (
    exists (select 1 from content.composition_revision r where r.id = composition_revision_id)
    and case input_role
      when 'fragment' then exists (
        select 1 from content.authored_fragment_revision r where r.id = fragment_revision_id)
      when 'composition' then exists (
        select 1 from content.composition_revision r where r.id = child_composition_revision_id)
      when 'resource' then exists (
        select 1
          from content.artifact_version av
          join content.artifact a on a.id = av.artifact_id
          join core.object o on o.id = a.id
         where av.id = resource_version_id)
      when 'binding' then exists (
        select 1 from content.typed_binding b where b.id = binding_id)
      when 'generated_view' then exists (
        select 1 from content.compiled_view v where v.id = compiled_view_id)
      else false
    end
  )
  with check (
    exists (select 1 from content.composition_revision r where r.id = composition_revision_id)
    and case input_role
      when 'fragment' then exists (
        select 1 from content.authored_fragment_revision r where r.id = fragment_revision_id)
      when 'composition' then exists (
        select 1 from content.composition_revision r where r.id = child_composition_revision_id)
      when 'resource' then exists (
        select 1
          from content.artifact_version av
          join content.artifact a on a.id = av.artifact_id
          join core.object o on o.id = a.id
         where av.id = resource_version_id)
      when 'binding' then exists (
        select 1 from content.typed_binding b where b.id = binding_id)
      when 'generated_view' then exists (
        select 1 from content.compiled_view v where v.id = compiled_view_id)
      else false
    end
  );

drop function content.composition_input_visible(uuid, text, uuid, uuid, uuid, uuid, uuid);
