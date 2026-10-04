import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const command = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: command }),
}));
import {
  observeSystemd,
  SYSTEMD_PROPERTIES,
} from './internal/commissioning/systemd-observation.js';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  command.mockReset();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kf-collector-command-'));
  roots.push(root);
  command.mockImplementation(async (_executable, arguments_: string[]) => {
    if (arguments_.includes('--property=UnitPath')) return { stdout: root + '\n' };
    if (arguments_.includes('list-units')) return { stdout: '[]\n' };
    return {
      stdout:
        SYSTEMD_PROPERTIES.map(
          (property) => `${property}=${property === 'Id' ? 'kf-api.service' : ''}`,
        ).join('\n') + '\n',
    };
  });
  return root;
}
describe('the live collector uses a fixed local bounded machine interface', () => {
  it('uses only local systemctl with sanitized environment, bounded commands, no reload/start', async () => {
    const root = await fixture();
    const result = await observeSystemd({ units: ['kf-api.service'], templates: [] });
    expect(result).toMatchObject({ unitPaths: [root], units: [{ Id: 'kf-api.service' }] });
    expect(command).toHaveBeenCalledTimes(2);
    for (const [executable, arguments_, options] of command.mock.calls) {
      expect(executable).toBe('/usr/bin/systemctl');
      expect(arguments_).toContain('--system');
      expect(arguments_).not.toContain('start');
      expect(arguments_).not.toContain('daemon-reload');
      expect(options.env).toEqual({
        PATH: '/usr/bin:/bin',
        LC_ALL: 'C',
        LANG: 'C',
        SYSTEMD_PAGER: 'cat',
        SYSTEMD_COLORS: '0',
      });
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(5000);
      expect(options.killSignal).toBe('SIGKILL');
      expect(options.maxBuffer).toBe(4 * 1024 * 1024);
    }
  });
  it('suppresses subprocess error output rather than returning stderr', async () => {
    command.mockRejectedValue(new Error('PUBLIC_UNTRUSTED_STDERR'));
    await expect(observeSystemd({ units: ['kf-api.service'], templates: [] })).rejects.toThrow(
      'manager observation unavailable',
    );
  });
  it('refuses a command timeout and does not restart the observation', async () => {
    command.mockRejectedValue(
      Object.assign(new Error('PUBLIC_TIMEOUT'), { killed: true, signal: 'SIGKILL' }),
    );
    await expect(observeSystemd({ units: ['kf-api.service'], templates: [] })).rejects.toThrow(
      'manager observation unavailable',
    );
    expect(command).toHaveBeenCalledTimes(1);
  });
  it('refuses an expired aggregate command deadline', async () => {
    await fixture();
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(20001);
    await expect(observeSystemd({ units: ['kf-api.service'], templates: [] })).rejects.toThrow(
      'timed out',
    );
    expect(command).not.toHaveBeenCalled();
  });
  it('refuses omitted requested records', async () => {
    await fixture();
    await expect(
      observeSystemd({ units: ['kf-api.service', 'kf-checkpoint.service'], templates: [] }),
    ).rejects.toThrow('incomplete');
  });
  it('refuses malformed template discovery rather than querying unscoped units', async () => {
    const root = await fixture();
    command.mockResolvedValueOnce({ stdout: root + '\n' }).mockResolvedValueOnce({
      stdout: '[{"unit":"foreign.service","description":"PUBLIC_UNTRUSTED"}]',
    });
    await expect(observeSystemd({ units: [], templates: ['kf-alert@.service'] })).rejects.toThrow(
      'instance refused',
    );
    expect(command).toHaveBeenCalledTimes(2);
  });
});
