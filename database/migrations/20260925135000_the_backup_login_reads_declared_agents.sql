-- migrate:up

-- org.declared_agent (20260925100000) and the backup login's reach (20260925130000) were built on
-- sibling branches, so the declarations were the one table the backup login could not read:
-- pg_dump, which locks every table it dumps, refused the whole backup. The declarations belong in
-- a backup — a database restored from one should know which agents the owner declared — even
-- though the canonical export leaves them out by design (re-declared after an import). The table
-- carries no row security (it is read only by core.issue_attestation, and no application role
-- has any grant), so a SELECT grant is the whole of it.
grant select on org.declared_agent to kf_backup;

-- migrate:down
revoke select on org.declared_agent from kf_backup;
