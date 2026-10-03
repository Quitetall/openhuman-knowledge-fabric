import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/deploy/preservation-consumer.sh');

// Ordinary process tests prove refusal, not PID 1 custody or actual preservation.
describe('closed native preservation consumer binding', () => {
  it('refuses arbitrary commands, extra arguments and payload disclosure', () => {
    for (const args of [
      [],
      ['unknown'],
      ['backup', 'destination'],
      ['drill', '--allow-local-fallback'],
    ]) {
      const result = spawnSync('/usr/bin/bash', [SCRIPT, ...args], {
        env: { PATH: '/usr/bin:/bin', UNRELATED_SECRET: 'never-print-this' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(64);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('usage: preservation-consumer.sh backup|offsite|drill\n');
    }
  });

  it('refuses ordinary callers rather than falling back to legacy credentials', () => {
    for (const role of ['backup', 'offsite', 'drill']) {
      const result = spawnSync('/usr/bin/bash', [SCRIPT, role], {
        env: {
          PATH: '/usr/bin:/bin',
          DATABASE_URL: 'never-print-this',
          PRESERVATION_SIGNING_KEY_PATH: '/legacy/signer',
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('native preservation binding requires PID 1 custody\n');
    }
  });

  it('binds fixed inputs and resets conflicting legacy invocation for each role', () => {
    const expectations = [
      ['backup', 'backup', ['database-url', 'preservation-signing-key']],
      [
        'offsite-b2',
        'offsite',
        ['database-url', 'b2-endpoint', 'b2-bucket', 'b2-key-id', 'b2-key'],
      ],
      [
        'drill-b2',
        'drill',
        [
          'database-url',
          'backup-decryption-key',
          's3-secret-access-key',
          'b2-endpoint',
          'b2-bucket',
          'b2-key-id',
          'b2-key',
        ],
      ],
    ] as const;
    for (const [name, role, fields] of expectations) {
      const unit = readFileSync(
        join(ROOT, `deploy/systemd/${name}-workstation-credentials.conf`),
        'utf8',
      );
      const names = [...unit.matchAll(/^LoadCredential=([^:\r\n]+):/gm)]
        .map((match) => match[1])
        .sort();
      expect(names).toEqual([...fields].sort());
      for (const field of fields) {
        const realm = !field.startsWith('b2-')
          ? role
          : role === 'drill' && ['b2-key', 'b2-key-id'].includes(field)
            ? 'drill-b2'
            : 'b2';
        expect(unit).toContain(
          `LoadCredential=${field}:/run/kf-workstation-${realm}-credentials/current/${field}`,
        );
      }
      expect(unit).toContain(
        `ExecStart=/usr/bin/bash /opt/kf/scripts/deploy/preservation-consumer.sh ${role}`,
      );
      expect(unit).toMatch(/^ExecStart=$/m);
      expect(unit).toMatch(/^ExecStartPre=$/m);
      expect(unit).toMatch(/^LoadCredential=$/m);
      expect(unit).toMatch(/^LoadCredentialEncrypted=$/m);
      expect(unit).toContain('RuntimeDirectoryMode=0700');
      expect(unit).toContain(`RuntimeDirectory=kf-${role}-work`);
      expect(unit).toContain('Environment=KF_SECRET_CUSTODY=systemd');
      expect(unit).toContain('LimitCORE=0');
      expect(unit).toContain('MemorySwapMax=0');
      if (role === 'drill') {
        expect(unit).toMatch(/^StateDirectory=$/m);
        expect(unit).toContain(
          'LoadCredential=b2-key:/run/kf-workstation-drill-b2-credentials/current/b2-key',
        );
        expect(unit).not.toContain('LoadCredential=b2-key:/run/kf-workstation-b2-credentials/');
      }
    }
  });
});
