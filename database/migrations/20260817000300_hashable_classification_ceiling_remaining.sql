-- migrate:up

-- The classification ceiling, hashed everywhere else it appears in a policy.
--
-- `20260817000200` did `core.object`'s three policies and enumerated the rest as follow-on
-- work. This is that work: the remaining **15 policies, 19 clauses, across 10 tables**.
--
-- The earlier record said "ten other policies". That was wrong — it came from eyeballing a
-- truncated listing rather than counting. The real set is enumerated from `pg_policies` and
-- reproduced below, and the verification block at the foot asserts the count rather than
-- trusting this comment.
--
-- Why it is safe is unchanged and already established: the term is identical in every one of
-- these, and `tests/database/classification-predicate-equivalence.test.ts` compares the two
-- forms exhaustively — every classification the registry defines crossed with every ceiling a
-- caller can bind, including NULL and values the registry does not define. The admission
-- decision is identical at every point. What is per-policy here is transcription, not proof.
--
-- Each policy is RESTATED IN FULL from its defining migration rather than patched from the
-- text PostgreSQL renders back. Several of these govern writes, several are FOR ALL and carry
-- the ceiling in both USING and WITH CHECK, and one carries it inside a nested OR. Editing a
-- decompiled predicate is reconstructing a security rule from a serialization of itself; the
-- clauses that are not the ceiling are copied verbatim from source so the diff is exactly the
-- ceiling and nothing else.
--
-- The classification column differs between them — `classification`, `classification_id`,
-- `effective_classification`, and `decision.classification` inside an EXISTS — which is the
-- other reason this is not a textual sweep.

-- ── content.adr_decision_body ────────────────────────────────────────────────────────────
-- Ceiling nested inside the EXISTS, on the decision envelope's own classification.

alter policy adr_decision_body_read on content.adr_decision_body
  using (
    exists (
      select 1 from core.object decision
       where decision.id = decision_id
         and decision.organization_id = core.current_organization()
         and decision.classification in (select id from registry.classification
                                          where rank <= core.current_classification_rank())
    )
  );

alter policy adr_decision_body_insert on content.adr_decision_body
  with check (
    exists (
      select 1 from core.object decision
       where decision.id = decision_id
         and decision.organization_id = core.current_organization()
         and decision.classification in (select id from registry.classification
                                          where rank <= core.current_classification_rank())
    )
  );

-- ── content.authored_fragment_revision ───────────────────────────────────────────────────

alter policy authored_fragment_revision_scope on content.authored_fragment_revision
  using (
    exists (select 1 from content.authored_fragment f where f.id = fragment_id)
    and classification in (select id from registry.classification
                            where rank <= core.current_classification_rank())
  )
  with check (
    exists (select 1 from content.authored_fragment f where f.id = fragment_id)
    and classification in (select id from registry.classification
                            where rank <= core.current_classification_rank())
  );

-- ── content.compilation_basis ────────────────────────────────────────────────────────────
-- The read policy carries the ceiling inside one arm of an OR: a finalized basis is bounded
-- by its effective classification, an unfinalized one by its author. Only the first arm is
-- touched; the second is copied verbatim.

alter policy compilation_basis_read on content.compilation_basis
  using (
    exists (select 1 from content.composition_revision r where r.id = root_composition_revision_id)
    and (
      (finalized_at is not null
       and effective_classification in (select id from registry.classification
                                         where rank <= core.current_classification_rank()))
      or
      (finalized_at is null
       and created_by::text = nullif(current_setting('kf.actor', true), ''))
    )
  );

-- USING carries no ceiling here and is restated unchanged, so that both halves of this policy
-- are written down in one place rather than one being left to inference.
alter policy compilation_basis_finalize on content.compilation_basis
  using (
    finalized_at is null
    and created_by::text = nullif(current_setting('kf.actor', true), '')
  )
  with check (
    finalized_at is not null
    and effective_classification is not null
    and effective_classification in (select id from registry.classification
                                      where rank <= core.current_classification_rank())
  );

-- ── content.compilation_run ──────────────────────────────────────────────────────────────

alter policy compilation_run_scope on content.compilation_run
  using (
    exists (select 1 from content.compilation_basis b where b.id = basis_id)
    and effective_classification in (select id from registry.classification
                                      where rank <= core.current_classification_rank())
  )
  with check (
    exists (select 1 from content.compilation_basis b where b.id = basis_id)
    and effective_classification in (select id from registry.classification
                                      where rank <= core.current_classification_rank())
  );

-- ── content.compiled_view ────────────────────────────────────────────────────────────────

alter policy compiled_view_scope on content.compiled_view
  using (
    exists (select 1 from content.compilation_run r where r.id = compilation_run_id)
    and effective_classification in (select id from registry.classification
                                      where rank <= core.current_classification_rank())
  )
  with check (
    exists (select 1 from content.compilation_run r where r.id = compilation_run_id)
    and effective_classification in (select id from registry.classification
                                      where rank <= core.current_classification_rank())
  );

-- ── content.document_publication ─────────────────────────────────────────────────────────

alter policy document_publication_scope on content.document_publication
  using (
    organization_id = core.current_organization()
    and exists (select 1 from content.document_subject s where s.id = subject_id)
    and effective_classification in (select id from registry.classification
                                      where rank <= core.current_classification_rank())
  )
  with check (
    organization_id = core.current_organization()
    and exists (select 1 from content.document_subject s where s.id = subject_id)
    and effective_classification in (select id from registry.classification
                                      where rank <= core.current_classification_rank())
  );

-- ── ml.aggregate_reference ───────────────────────────────────────────────────────────────

alter policy aggregate_reference_read on ml.aggregate_reference
  using (
    organization_id = core.current_organization()
    and classification_id in (select id from registry.classification
                               where rank <= core.current_classification_rank())
  );

alter policy aggregate_reference_insert on ml.aggregate_reference
  with check (
    organization_id = core.current_organization()
    and classification_id in (select id from registry.classification
                               where rank <= core.current_classification_rank())
  );

-- ── search.document ──────────────────────────────────────────────────────────────────────

alter policy search_document_read on search.document
  using (
    organization_id = core.current_organization()
    and classification in (select id from registry.classification
                            where rank <= core.current_classification_rank())
  );

-- ── secure_object.capability_request ─────────────────────────────────────────────────────

alter policy capability_request_read on secure_object.capability_request
  using (
    organization_id = core.current_organization()
    and classification_id in (select id from registry.classification
                               where rank <= core.current_classification_rank())
  );

alter policy capability_request_insert on secure_object.capability_request
  with check (
    organization_id = core.current_organization()
    and classification_id in (select id from registry.classification
                               where rank <= core.current_classification_rank())
  );

-- ── secure_object.erasure_request ────────────────────────────────────────────────────────

alter policy erasure_request_read on secure_object.erasure_request
  using (
    organization_id = core.current_organization()
    and classification_id in (select id from registry.classification
                               where rank <= core.current_classification_rank())
  );

alter policy erasure_request_insert on secure_object.erasure_request
  with check (
    organization_id = core.current_organization()
    and classification_id in (select id from registry.classification
                               where rank <= core.current_classification_rank())
  );

do $$
declare
  correlated_left integer;
  hashable_now    integer;
begin
  -- Fabric-wide, not scoped to the tables above: the point of this migration is that NO
  -- policy anywhere still asks the ceiling once per row, and a check scoped to the ones being
  -- changed could not tell the difference between "finished" and "missed one".
  select count(*) into correlated_left
    from (select qual as clause from pg_policies
          union all
          select with_check from pg_policies) as clauses
   where clause ~ 'SELECT [a-z_]+\.rank';

  select count(*) into hashable_now
    from (select qual as clause from pg_policies
          union all
          select with_check from pg_policies) as clauses
   where clause ~ 'IN \(\s*SELECT classification\.id';

  if correlated_left <> 0 then
    raise exception
      '% policy clause(s) still evaluate the classification ceiling once per row',
      correlated_left using errcode = 'check_violation';
  end if;
  -- 19 rewritten here plus the 4 core.object clauses from 20260817000200. A bare "> 0" would
  -- pass on a single rewritten clause and report the sweep complete.
  if hashable_now <> 23 then
    raise exception
      'expected 23 hashed ceiling clauses fabric-wide, found %', hashable_now
      using errcode = 'check_violation';
  end if;
end $$;

-- migrate:down

alter policy adr_decision_body_read on content.adr_decision_body
  using (
    exists (
      select 1 from core.object decision
       where decision.id = decision_id
         and decision.organization_id = core.current_organization()
         and (select rank from registry.classification where id = decision.classification)
             <= core.current_classification_rank()
    )
  );

alter policy adr_decision_body_insert on content.adr_decision_body
  with check (
    exists (
      select 1 from core.object decision
       where decision.id = decision_id
         and decision.organization_id = core.current_organization()
         and (select rank from registry.classification where id = decision.classification)
             <= core.current_classification_rank()
    )
  );

alter policy authored_fragment_revision_scope on content.authored_fragment_revision
  using (
    exists (select 1 from content.authored_fragment f where f.id = fragment_id)
    and (select rank from registry.classification c where c.id = classification)
        <= core.current_classification_rank()
  )
  with check (
    exists (select 1 from content.authored_fragment f where f.id = fragment_id)
    and (select rank from registry.classification c where c.id = classification)
        <= core.current_classification_rank()
  );

alter policy compilation_basis_read on content.compilation_basis
  using (
    exists (select 1 from content.composition_revision r where r.id = root_composition_revision_id)
    and (
      (finalized_at is not null
       and (select rank from registry.classification c where c.id = effective_classification)
           <= core.current_classification_rank())
      or
      (finalized_at is null
       and created_by::text = nullif(current_setting('kf.actor', true), ''))
    )
  );

alter policy compilation_basis_finalize on content.compilation_basis
  using (
    finalized_at is null
    and created_by::text = nullif(current_setting('kf.actor', true), '')
  )
  with check (
    finalized_at is not null
    and effective_classification is not null
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  );

alter policy compilation_run_scope on content.compilation_run
  using (
    exists (select 1 from content.compilation_basis b where b.id = basis_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  )
  with check (
    exists (select 1 from content.compilation_basis b where b.id = basis_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  );

alter policy compiled_view_scope on content.compiled_view
  using (
    exists (select 1 from content.compilation_run r where r.id = compilation_run_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  )
  with check (
    exists (select 1 from content.compilation_run r where r.id = compilation_run_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  );

alter policy document_publication_scope on content.document_publication
  using (
    organization_id = core.current_organization()
    and exists (select 1 from content.document_subject s where s.id = subject_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  )
  with check (
    organization_id = core.current_organization()
    and exists (select 1 from content.document_subject s where s.id = subject_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  );

alter policy aggregate_reference_read on ml.aggregate_reference
  using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );

alter policy aggregate_reference_insert on ml.aggregate_reference
  with check (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );

alter policy search_document_read on search.document
  using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
      <= core.current_classification_rank()
  );

alter policy capability_request_read on secure_object.capability_request
  using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );

alter policy capability_request_insert on secure_object.capability_request
  with check (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );

alter policy erasure_request_read on secure_object.erasure_request
  using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );

alter policy erasure_request_insert on secure_object.erasure_request
  with check (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification_id)
      <= core.current_classification_rank()
  );

do $$
declare
  restored integer;
begin
  select count(*) into restored
    from (select qual as clause from pg_policies
          union all
          select with_check from pg_policies) as clauses
   where clause ~ 'SELECT [a-z_]+\.rank';
  if restored <> 19 then
    raise exception
      'rollback restored % per-row ceiling clause(s), expected 19', restored
      using errcode = 'check_violation';
  end if;
end $$;
