-- migrate:up

-- The classification ceiling, asked once per statement instead of once per row.
--
-- `core.object`'s three policies compare a row's classification rank against the caller's
-- ceiling with a CORRELATED subquery — it names the row, so PostgreSQL runs it for every row
-- tested. Measured on 36,007 objects, read as kf_readonly, median of seven runs
-- (`tests/database/rls-read-cost.test.ts`):
--
--   core.object · organization term only                    1.3 ms   12005 rows
--   core.object · organization + classification rank      137.3 ms   12005 rows
--   core.object · organization + rank, hashable form        2.0 ms   12005 rows
--
-- Same 12,005 rows, ~68x less time. `registry.classification` holds a handful of rows and the
-- question "which classifications are at or below my ceiling" does not depend on the row being
-- tested, so asking it once and hashing the answer is the same question asked better.
--
-- WHY THIS IS SAFE, ESTABLISHED RATHER THAN ARGUED. This term is not only what a caller may
-- READ: it is in `object_write`'s WITH CHECK and in BOTH halves of `object_update`, so it
-- governs what a caller may write and what they may reclassify a record to. A form that is
-- subtly weaker in some corner would let a writer move a record beyond their own ceiling.
--
-- `tests/database/classification-predicate-equivalence.test.ts` compares the two forms
-- EXHAUSTIVELY: every classification the registry defines, crossed with every ceiling a
-- caller can bind, including ceilings that are not classifications and classifications that
-- are not in the registry. The admission decision is identical at every point.
--
-- The two forms differ in exactly one respect, at inputs that cannot occur. A classification
-- the registry does not define yields NULL from the correlated form (a subquery with no rows)
-- and FALSE from the hashable form (absent from the set). RLS denies on both, so no row's
-- fate changes — and `core.object.classification` is `not null references
-- registry.classification (id)`, so no row can carry such a value at all. The test asserts
-- that difference is confined to exactly those inputs, and asserts the constraint that makes
-- them unreachable, so relaxing the constraint later fails the suite rather than quietly
-- widening the corner.
--
-- Written out in full rather than by rewriting the stored expression text. PostgreSQL renders
-- a policy back from its parse tree, so text-editing a rendered predicate means reconstructing
-- a security rule from a serialization of itself; these three are short, and stating them is
-- cheaper than proving a transformation of them.

alter policy object_read on core.object
  using (
    organization_id = core.current_organization()
    and classification in (select id from registry.classification
                            where rank <= core.current_classification_rank())
  );

alter policy object_write on core.object
  with check (
    organization_id = core.current_organization()
    and classification in (select id from registry.classification
                            where rank <= core.current_classification_rank())
  );

-- An update may not move a row out of the caller's reach, nor raise its classification
-- beyond what the caller may see. Both halves carry the ceiling, and both are rewritten:
-- leaving one behind would make the read and write sides of the same policy disagree.
alter policy object_update on core.object
  using (
    organization_id = core.current_organization()
    and classification in (select id from registry.classification
                            where rank <= core.current_classification_rank())
  )
  with check (
    organization_id = core.current_organization()
    and classification in (select id from registry.classification
                            where rank <= core.current_classification_rank())
  );

do $$
declare
  still_correlated integer;
  now_hashable     integer;
begin
  -- Fail closed on both sides. A migration that quietly rewrote nothing would report the read
  -- path fixed while it was not, and one that rewrote a policy into a shape nobody recognises
  -- would pass a check that only counted what it removed.
  select count(*) into still_correlated
    from pg_policies
   where schemaname = 'core' and tablename = 'object'
     and policyname in ('object_read', 'object_write', 'object_update')
     and (coalesce(qual, '') ~ 'SELECT classification\.rank'
          or coalesce(with_check, '') ~ 'SELECT classification\.rank');

  -- Matched against what PostgreSQL 18 actually renders, checked on a real server rather than
  -- assumed. `classification in (select id from registry.classification where …)` reads back
  -- as:
  --
  --     (classification IN ( SELECT classification.id
  --        FROM registry.classification
  --       WHERE (classification.rank <= core.current_classification_rank())))
  --
  -- so it is `IN (`, not the `= ANY (` that an `IN`-subquery is often said to become. The
  -- subquery's own text is required too: matching a bare `IN (` would be satisfied by any
  -- unrelated set comparison a later migration added to these policies, and would then report
  -- the ceiling hashed when it was not.
  select count(*) into now_hashable
    from pg_policies
   where schemaname = 'core' and tablename = 'object'
     and policyname in ('object_read', 'object_write', 'object_update')
     and (coalesce(qual, '') ~ 'IN \(\s*SELECT classification\.id'
          or coalesce(with_check, '') ~ 'IN \(\s*SELECT classification\.id');

  if still_correlated <> 0 then
    raise exception 'core.object still has % policy expression(s) using the per-row ceiling',
      still_correlated using errcode = 'check_violation';
  end if;
  if now_hashable <> 3 then
    raise exception
      'expected 3 core.object policies carrying the hashable ceiling, found %', now_hashable
      using errcode = 'check_violation';
  end if;
end $$;

-- migrate:down

alter policy object_read on core.object
  using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
        <= core.current_classification_rank()
  );

alter policy object_write on core.object
  with check (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
        <= core.current_classification_rank()
  );

alter policy object_update on core.object
  using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
        <= core.current_classification_rank()
  )
  with check (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
        <= core.current_classification_rank()
  );
