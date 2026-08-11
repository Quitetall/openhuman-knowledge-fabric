-- migrate:up

-- Record how many events a checkpoint actually covered.
--
-- `to_seq - from_seq + 1` is NOT that number. `core.audit_event.seq` is a bigserial, and a
-- sequence value consumed by a transaction that then rolls back is never reissued — so a
-- perfectly healthy log has holes in it. Deriving the leaf count from the range would
-- therefore produce a different count than the one that was signed, and every verification
-- after the first rollback would report a forged checkpoint.
--
-- The signature covers the leaf count, so the leaf count has to be stored rather than
-- inferred. It is also the check that catches deletion: if events vanish from a range, the
-- recomputed tree has fewer leaves than the signature says, and that is visible before any
-- root comparison.
-- The table is append-only, so there is no backfill available: UPDATE is refused by trigger,
-- and inferring a value from the range is exactly the arithmetic this column exists to
-- replace. A pre-existing row therefore has no correct answer, and the migration says so
-- rather than inventing one.
do $$
begin
  if exists (select 1 from core.audit_checkpoint) then
    raise exception 'core.audit_checkpoint already holds rows with no recorded leaf_count; '
                    'the true count is only known to whoever signed them — re-derive it from '
                    'the archived checkpoint objects and load it deliberately';
  end if;
end $$;

alter table core.audit_checkpoint
  -- No default. A checkpoint that did not state its leaf count is not a checkpoint.
  add column leaf_count bigint not null;

-- A signed range must contain at least one event; an empty checkpoint attests to nothing.
alter table core.audit_checkpoint
  add constraint checkpoint_not_empty check (leaf_count > 0);

-- ...and cannot claim more leaves than the range could hold.
alter table core.audit_checkpoint
  add constraint checkpoint_leaf_count_fits check (leaf_count <= to_seq - from_seq + 1);

comment on column core.audit_checkpoint.leaf_count is
  'Number of audit events in the signed range. Stored, not derived: bigserial gaps from '
  'rolled-back transactions make from/to arithmetic wrong.';

-- migrate:down

alter table core.audit_checkpoint drop constraint checkpoint_leaf_count_fits;
alter table core.audit_checkpoint drop constraint checkpoint_not_empty;
alter table core.audit_checkpoint drop column leaf_count;
