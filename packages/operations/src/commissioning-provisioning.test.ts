/**
 * Commissioning points at the command that fixes what it finds missing, and sees a unit-private
 * credential as the secret it is.
 *
 * Kept apart from `commissioning.test.ts`, which is the recorded qualification battery of the
 * `kf.host.commissioning` gate: these add no fault class, so they must not change its digest.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMISSIONING_DEFAULTS } from './internal/commissioning/contracts.js';
import { parseUnit, secretPosture } from './internal/commissioning/units.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('commissioning and provisioning', () => {
  it('points a host with missing secret files at provision-host.sh --check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kf-commissioning-provision-'));
    roots.push(root);
    await writeFile(
      join(root, 'kf-fixture.service'),
      `[Service]\nUser=kf-api\nEnvironment=DATABASE_URL_FILE=${join(root, 'absent')}\n`,
    );
    // Every default, so a new input (the attestor socket, the passwd/group paths) reaches the
    // check as it would on a host rather than as undefined.
    const result = await secretPosture({
      ...COMMISSIONING_DEFAULTS,
      systemdDirectory: root,
      shippedUnitDirectory: root,
    });
    expect(result.status).toBe('unverifiable');
    expect(result.detail).toContain('provision-host.sh --check');
  });

  it('counts a LoadCredentialEncrypted= path as a secret of that unit alone', () => {
    const facts = parseUnit(
      'kf-restore-drill.service',
      '[Service]\nUser=kf-drill\n' +
        'LoadCredentialEncrypted=backup-decryption-key:/etc/kf/credstore.encrypted/backup-decryption-key\n',
    );
    expect(facts.secretPaths).toEqual(['/etc/kf/credstore.encrypted/backup-decryption-key']);
  });
});
