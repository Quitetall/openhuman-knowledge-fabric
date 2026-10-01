/** Real user-systemd coordination, never the system manager or the KF VM. Opt in explicitly. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { recoveryBarrier } from '../../scripts/deploy/recovery-barrier.mjs';

it.runIf(process.env['KF_RECOVERY_SYSTEMD_TEST'] === '1')(
  'a real cache holder cannot survive recovery or start while held',
  async () => {
    const runtime = process.env['XDG_RUNTIME_DIR'];
    if (!runtime) throw new Error('user systemd requires XDG_RUNTIME_DIR');
    const unitDirectory = join(runtime, 'systemd', 'user');
    const additional = `kf-recovery-test-${randomUUID()}.service`;
    const holders = ['kf-api.service', 'kf-worker.service', additional];
    const manager = (args: string[]) => {
      const result = spawnSync('/usr/bin/systemctl', ['--user', ...args], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (result.status !== 0) throw new Error(`systemd ${args[0]} failed: ${result.stderr}`);
      return result.stdout;
    };
    // Refuse to touch an existing user's unit, including masked or unloaded files.
    for (const unit of holders) {
      expect(manager(['show', unit, '--property=LoadState']).trim()).toBe('LoadState=not-found');
      expect(existsSync(join(unitDirectory, unit))).toBe(false);
      expect(existsSync(join(unitDirectory, `${unit}.d`))).toBe(false);
    }
    const work = mkdtempSync(join(tmpdir(), 'kf-recovery-runtime-'));
    const source = join(work, 'database-fixture.json');
    const snapshot = join(work, 'cached.json');
    const processFile = join(work, 'cache-holder.mjs');
    const stateDirectory = join(work, 'state');
    const created: string[] = [];
    mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(source, JSON.stringify({ bandVersion: 'e1:7', classification: 'public' }));
    writeFileSync(
      processFile,
      `import { readFileSync, writeFileSync } from 'node:fs';
const cached = JSON.parse(readFileSync(process.argv[2], 'utf8'));
writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, ...cached }));
setInterval(() => {}, 1000);
`,
    );
    const options = { stateDirectory, unitDirectory, ownerUid: process.getuid!(), manager };
    const readSnapshot = () =>
      JSON.parse(readFileSync(snapshot, 'utf8')) as { pid: number; classification: string };
    const waitForSnapshot = async () => {
      for (let attempt = 0; attempt < 100 && !existsSync(snapshot); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return readSnapshot();
    };
    try {
      for (const unit of holders) {
        writeFileSync(
          join(unitDirectory, unit),
          `[Service]\nType=simple\nKillMode=control-group\nExecStart=${unit === additional ? `${process.execPath} ${processFile} ${source} ${snapshot}` : '/usr/bin/sleep infinity'}\n`,
          { flag: 'wx' },
        );
        created.push(unit);
      }
      manager(['daemon-reload']);
      manager(['start', ...holders]);
      const before = await waitForSnapshot();
      expect(before.classification).toBe('public');
      recoveryBarrier('hold', [additional], options);
      expect(() => process.kill(before.pid, 0)).toThrow();
      manager(['start', additional]); // A failed condition is a skipped start, not a CLI failure.
      expect(manager(['show', additional, '--property=ActiveState']).trim()).toBe(
        'ActiveState=inactive',
      );
      // The restored history reuses the same band version with different membership.
      writeFileSync(source, JSON.stringify({ bandVersion: 'e1:7', classification: 'restricted' }));
      rmSync(snapshot);
      recoveryBarrier('resume-confirmed', [], options);
      const after = await waitForSnapshot();
      expect(after.pid).not.toBe(before.pid);
      expect(after.classification).toBe('restricted');
    } finally {
      if (created.length) manager(['stop', ...created]);
      for (const unit of created) {
        rmSync(join(unitDirectory, unit));
        rmSync(join(unitDirectory, `${unit}.d`), { recursive: true, force: true });
      }
      manager(['daemon-reload']);
      rmSync(work, { recursive: true, force: true });
    }
  },
  15000,
);
