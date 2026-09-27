-- migrate:up

-- content.master_record_input_exemption (20260926110100) is under row security like every other
-- table (KF-SAS-RQ-186).
--
-- It is a static list of table names and reasons, changed only by migrations, and only the backup
-- login is granted it. It was created without row security, so readiness's reconciliation of the
-- declared row security against the catalog named it (undeclared_without_row_security): a login
-- inheriting the owner, or any login later granted the table, would read it under no policy. The
-- list holds nothing about any organization, so the one policy admits every row to the one
-- login that may read it.

alter table content.master_record_input_exemption enable row level security;
alter table content.master_record_input_exemption force row level security;

create policy master_record_input_exemption_backup_read on content.master_record_input_exemption
  for select to kf_backup
  using (true);

-- migrate:down

drop policy master_record_input_exemption_backup_read on content.master_record_input_exemption;
alter table content.master_record_input_exemption no force row level security;
alter table content.master_record_input_exemption disable row level security;
