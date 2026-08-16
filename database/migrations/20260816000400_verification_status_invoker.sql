-- migrate:up

-- `engineering.verification_status` was the one view in the schema that runs as its owner.
--
-- A PostgreSQL view without `security_invoker` resolves its underlying tables with the
-- privileges — and the row-level security — of the view's OWNER, not the caller's. Eleven of
-- the twelve views here declare `security_invoker = true` for exactly that reason; this one,
-- the oldest, was written before the convention and never revisited.
--
-- It mattered less when the tables it reads had no policies of their own. It matters now:
-- `20260816000300_typed_table_row_security.sql` put `engineering.test_execution`,
-- `engineering.verification_link` and `engineering.test_definition` under row-level security,
-- and this view aggregates all three. It is also the view the application actually queries —
-- `packages/product-quality/src/internal/readers.ts` reads it to decide whether a risk control
-- is verified.
--
-- The view does join `core.object`, which FORCES row-level security, so in a deployment whose
-- owner is not a superuser the result is scoped anyway. That is the problem rather than the
-- mitigation: whether this view is scoped depends on whether its owner happens to hold
-- superuser, which is a property of how the database was provisioned and not of anything
-- anybody decided. A visibility rule with that shape is not a rule.
--
-- `security_invoker` makes the answer the same either way: the caller's context decides, as
-- it does for every other view and every table underneath.

alter view engineering.verification_status set (security_invoker = true);

comment on view engineering.verification_status is
  'Verification rollup per subject. security_invoker: the caller''s row-level security decides '
  'what it aggregates, not the view owner''s.';

-- migrate:down

-- Forward-only. Reverting would return a view over four row-level-security-protected tables
-- to resolving them as its owner.
