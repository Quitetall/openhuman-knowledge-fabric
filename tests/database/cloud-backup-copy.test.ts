/** Real PostgreSQL constraints and least-privilege writes, not provider or physical-domain evidence. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
let runId: string;
const digest = 'a'.repeat(64);
const identity = {
  format: 'kf-offsite-object-v1',
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'opaque-backups',
  key: `kf-backups/v1/${digest}.tar.gpg`,
  versionId: 'historical-version-1',
  sha256: digest,
  sizeBytes: 123,
};
beforeAll(async () => {
  h = await startHarness();
  runId = await withTransaction(
    h.adminPool,
    async (tx) =>
      (
        await tx.one<{ id: string }>(
          `insert into ops.backup_run (started_at, finished_at, kind, location, manifest_digest, byte_size, database_name)
     values (now(), now(), 'logical', 'fixture/cloud-backup', $1, 123, current_database()) returning id`,
          [digest],
        )
      ).id,
  );
});
afterAll(async () => {
  if (h) await h.stop();
});

async function record(
  value: unknown,
  basis = 'remote-object',
  ciphertext: string | null = digest,
  offsite = true,
): Promise<string> {
  return withTransaction(h.adminPool, async (tx) => {
    await tx.query('set local role kf_backup');
    return (
      await tx.one<{ id: string }>(
        `insert into ops.backup_copy (backup_run_id, destination_label, offsite, manifest_digest, offsite_basis, ciphertext_sha256, provider_object)
       values ($1, gen_random_uuid()::text, $2, $3, $4, $5, $6::jsonb) returning id`,
        [runId, offsite, digest, basis, ciphertext, value === null ? null : JSON.stringify(value)],
      )
    ).id;
  });
}
describe('a cloud copy preserves one closed historical identity in the existing ledger', () => {
  it('allows the backup role to append a valid remote object without granting domain approval', async () => {
    const id = await record(identity);
    const row = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ provider_object: unknown; failure_domain_ref: string | null }>(
        'select provider_object, failure_domain_ref from ops.backup_copy where id = $1',
        [id],
      ),
    );
    expect(row.provider_object).toEqual(identity);
    expect(row.failure_domain_ref).toBeNull();
    await expect(
      withTransaction(h.adminPool, async (tx) => {
        await tx.query('set local role kf_backup');
        await tx.query(
          "insert into ops.physical_failure_domain_evidence (domain_ref, evidence_ref, approved_by, approved_at) values ('invented', 'invented', gen_random_uuid(), now())",
        );
      }),
    ).rejects.toThrow();
    await expect(
      withTransaction(h.adminPool, (tx) =>
        tx.query('update ops.backup_copy set provider_object = provider_object where id = $1', [
          id,
        ]),
      ),
    ).rejects.toThrow();
  });
  it.each(
    [
      { ...identity, format: 'other' },
      { ...identity, endpoint: 'http://insecure.invalid' },
      { ...identity, bucket: 'bad/name' },
      { ...identity, key: 'not-the-recorded-ciphertext' },
      { ...identity, sha256: 'b'.repeat(64) },
      { ...identity, versionId: 'null' },
      { ...identity, versionId: '' },
      { ...identity, versionId: null },
      { ...identity, sizeBytes: '123' },
      { ...identity, sizeBytes: 0 },
      { ...identity, sizeBytes: 1.5 },
      { ...identity, sizeBytes: 5368709121 },
      { ...identity, applicationKey: 'must-never-be-recorded' },
      { format: identity.format },
      [],
      'unstructured',
    ].map((value) => ({ value })),
  )('refuses malformed, unbound or credential-bearing provider identity: %j', async ({ value }) => {
    await expect(record(value)).rejects.toThrow();
  });
  it('requires cloud identity, a ciphertext digest and a truthful cloud basis', async () => {
    await expect(record(null)).rejects.toThrow();
    await expect(record(identity, 'remote-object', null)).rejects.toThrow();
    await expect(record(identity, 'remote-host')).rejects.toThrow();
    await expect(record(identity, 'remote-object', digest, false)).rejects.toThrow();
  });
  it('keeps historical and rsync copies representable without fabricating cloud metadata', async () => {
    await expect(record(null, 'remote-host')).resolves.toEqual(expect.any(String));
    await expect(record(null, 'local-unattested', digest, false)).resolves.toEqual(
      expect.any(String),
    );
  });
});
