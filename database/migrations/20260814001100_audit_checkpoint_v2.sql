-- migrate:up

-- v1 checkpoint leaves predate full-row commitment. Preserve their exact verification
-- semantics, then require every new signer to name its format explicitly. v2 commits every
-- audit-event column plus the action target set and signs the format identifier itself.
alter table core.audit_checkpoint
  add column format_version text not null default 'kf.audit-checkpoint.v1';

alter table core.audit_checkpoint
  add constraint audit_checkpoint_known_format check (
    format_version in ('kf.audit-checkpoint.v1', 'kf.audit-checkpoint.v2')
  );

alter table core.audit_checkpoint alter column format_version drop default;

comment on column core.audit_checkpoint.format_version is
  'Signed checkpoint/leaf contract. v1 is retained only for historical verification; new writes use v2.';

-- Checkpoint signer needs complete ledger visibility and only action target identities. It
-- still cannot change actions/events or read action parameters/results.
grant select (id, target_ids) on core.action to kf_checkpoint;
create policy audit_read_checkpoint on core.audit_event
  for select to kf_checkpoint using (true);

-- migrate:down

drop policy if exists audit_read_checkpoint on core.audit_event;
revoke select (id, target_ids) on core.action from kf_checkpoint;
alter table core.audit_checkpoint drop constraint audit_checkpoint_known_format;
alter table core.audit_checkpoint drop column format_version;
