-- migrate:up

-- dbmate owns this operational table outside the governed schemas. A complete
-- pg_dump needs its rows: restoring without the applied-version ledger would
-- make a later migration runner treat an existing schema as unapplied. The
-- backup role may read it, but must not alter migration history or own it.
grant select on public.schema_migrations to kf_backup;

-- migrate:down
revoke select on public.schema_migrations from kf_backup;
