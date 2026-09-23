-- migrate:up

-- An off-site copy records what the copy script DID, not what an operator typed afterwards.
--
-- Until this migration `ops.backup_copy.offsite` was set by `backup-offsite.sh` to true for
-- every destination unless the operator remembered `--same-host` — so a copy to a second disk
-- in the same chassis counted as off-site by default. And `ops.encrypted_backup_evidence`, the
-- row `secure_object_storage_evidence` reads, could only be written by hand: nothing the
-- backup path executed ever said whether the bytes that left were encrypted.
--
-- Three facts are now recorded by the script, from its own run:
--
--   offsite_basis      WHY `offsite` has the value it has: the destination is another host
--                      (`remote-host`), a local path attested to be a separate physical failure
--                      domain (`attested-domain`, naming it), declared same-host, or a local
--                      path nobody attested (`local-unattested`, never off-site).
--   failure_domain_ref the approved domain an attested copy landed in.
--   ciphertext_sha256  the digest of the encrypted archive that left the host, re-measured at
--                      the destination. The restore drill pulls this exact object back.
--
-- Nullable because rows written before this migration carry none of it; the checks bind only
-- rows that do.

alter table ops.backup_copy
  add column offsite_basis text
    check (offsite_basis in ('remote-host', 'attested-domain', 'same-host', 'local-unattested')),
  add column failure_domain_ref text
    references ops.physical_failure_domain_evidence (domain_ref),
  add column ciphertext_sha256 text
    check (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  -- `offsite` must agree with its stated basis. An unattested local path cannot be off-site.
  add constraint backup_copy_offsite_matches_basis
    check (offsite_basis is null
           or offsite = (offsite_basis in ('remote-host', 'attested-domain'))),
  -- An attestation names the domain it attests, and nothing else names one.
  add constraint backup_copy_attestation_names_domain
    check (offsite_basis is null
           or (offsite_basis = 'attested-domain') = (failure_domain_ref is not null));

comment on column ops.backup_copy.offsite_basis is
  'Why offsite is true or false, as determined by scripts/backup-offsite.sh. Null only for '
  'rows recorded before 20260923100100.';
comment on column ops.backup_copy.ciphertext_sha256 is
  'SHA-256 of the encrypted archive re-measured at the destination. The restore drill pulls '
  'this object back and refuses it if the digest differs.';

-- The backup role records encryption evidence for copies it made itself. It still cannot
-- approve a failure domain: `physical_failure_domain_evidence` stays human-written, and the
-- foreign key means evidence can only name a domain a person already approved.
grant insert on ops.encrypted_backup_evidence to kf_backup;

-- migrate:down

revoke insert on ops.encrypted_backup_evidence from kf_backup;
alter table ops.backup_copy
  drop constraint if exists backup_copy_attestation_names_domain,
  drop constraint if exists backup_copy_offsite_matches_basis,
  drop column if exists ciphertext_sha256,
  drop column if exists failure_domain_ref,
  drop column if exists offsite_basis;
