-- migrate:up

-- The checkpoint signer commits every audit event together with its action's target set
-- (kf.audit-checkpoint.v2, 20260814001100), so it reads core.action — and 20260814001100 granted
-- kf_checkpoint the two columns it needs, (id, target_ids), and a policy on core.audit_event, but
-- no policy on core.action. core.action forces row-level security; the only policy kf_checkpoint
-- falls under is action_scoped_read, which admits rows of the bound organization, and the signer
-- binds none. So, run through its own login, the signer's join saw no action at all and reported
-- "nothing pending" over an audit log full of events: the log was never signed on a host.
--
-- Nothing had ever run the signer as anything but the database owner (every test used the
-- harness's superuser pool) until the first rehearsal of the VPS install (KF-WAR-0001,
-- 2026-10-07). tests/audit-verification/ledger.test.ts now signs through a kf_checkpoint-only
-- login, and fails without this policy.
--
-- What it admits is unchanged from what 20260814001100 decided: every action row, but only the
-- two columns the column grant allows. kf_checkpoint still cannot read parameters or results,
-- and cannot write anything here.
create policy action_checkpoint_read on core.action
  for select to kf_checkpoint using (true);

-- migrate:down

drop policy if exists action_checkpoint_read on core.action;
