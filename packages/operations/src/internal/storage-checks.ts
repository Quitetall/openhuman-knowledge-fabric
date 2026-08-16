import type { CheckFn } from './contracts.js';

export const secureObjectStorageEvidence: CheckFn = async (tx) => {
  const row = await tx.one<{
    approved_domains: string;
    encrypted_separate_backup: boolean;
  }>(
    `with current_objective as (
       select rpo_seconds
         from ops.recovery_objective
        order by declared_at desc, id desc
        limit 1
     )
     select (
              select count(distinct d.domain_ref)::text
                from ops.physical_failure_domain_evidence d
               where d.valid_until is null or d.valid_until > now()
            ) as approved_domains,
            exists (
              select 1
                from ops.encrypted_backup_evidence e
                join ops.physical_failure_domain_evidence d
                  on d.domain_ref = e.failure_domain_ref
                join ops.backup_copy c on c.id = e.backup_copy_id
                join ops.backup_run b on b.id = c.backup_run_id
                cross join current_objective o
               where e.encrypted
                 and e.separate_from_primary
                 and c.offsite
                 and (e.valid_until is null or e.valid_until > now())
                 and (d.valid_until is null or d.valid_until > now())
                 and b.finished_at >= now() - make_interval(secs => o.rpo_seconds)
            ) as encrypted_separate_backup`,
  );
  const domains = Number(row.approved_domains);
  const measured = {
    approved_physical_failure_domains: domains,
    required_physical_failure_domains: 3,
    encrypted_separate_backup: row.encrypted_separate_backup ? 'recorded' : 'missing',
  };

  if (domains < 3) {
    return {
      id: 'secure_object_storage_evidence',
      status: 'failed',
      detail:
        `Only ${domains} of 3 required physical failure domains have current approved ` +
        'evidence records. This check evaluates recorded approvals; it does not inspect the ' +
        'physical infrastructure.',
      measured,
    };
  }
  if (!row.encrypted_separate_backup) {
    return {
      id: 'secure_object_storage_evidence',
      status: 'failed',
      detail:
        'No current backup has approved evidence that it is encrypted and separate from the ' +
        'primary failure domain. This check does not inspect the external storage service.',
      measured,
    };
  }
  return {
    id: 'secure_object_storage_evidence',
    status: 'ok',
    detail:
      'Current approval evidence records cover 3 physical failure domains and a separate ' +
      'encrypted backup; external enforcement remains outside this process.',
    measured,
  };
};
