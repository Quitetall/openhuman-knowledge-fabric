/**
 * fixtures/veracier/stack/pidfile.sh: a pidfile names one process, and a reused pid is stale.
 *
 * On 2026-10-06, after a reboot, run/embed.pid held a number the kernel had since given to an
 * unrelated desktop application. `kill -0` succeeded, so `up` reported the embedder running and
 * never started it, and `down` would have signalled the stranger. These plant pidfiles pointing at
 * a live, unrelated `sleep` and require that it is treated as stale, the pidfile removed, and the
 * `sleep` left running — then check that a process the library DID start is recognised and
 * stopped.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const LIB = resolve(import.meta.dirname, '../../fixtures/veracier/stack/pidfile.sh');

let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kf-pidfile-'));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

/** Run `script` in bash with the library sourced; never throws, returns code and output. */
async function bash(script: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec('bash', ['-c', `. ${JSON.stringify(LIB)}\n${script}`], {
      timeout: 20_000,
    });
    return { code: 0, out: stdout + stderr };
  } catch (error: unknown) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, out: (failed.stdout ?? '') + (failed.stderr ?? '') };
  }
}

/** An unrelated live process: what a reused pid points at. */
function stranger(): ChildProcess {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  children.push(child);
  return child;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('stack pidfiles', () => {
  it('treats a legacy bare-pid pidfile naming an unrelated process as stale, and does not signal it', async () => {
    const other = stranger();
    const file = join(dir, 'embed.pid');
    writeFileSync(file, `${other.pid}\n`);

    const check = await bash(`pidfile_alive ${JSON.stringify(file)}`);
    expect(check.code).toBe(1);
    expect(check.out).toContain(`embed: pid ${other.pid} (legacy pidfile) is not embed any more`);
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, `${other.pid}\n`);
    const stop = await bash(`pidfile_stop ${JSON.stringify(file)} embed 0`);
    expect(stop.code).toBe(1);
    expect(existsSync(file)).toBe(false);
    await sleep(200);
    expect(alive(other.pid ?? 0)).toBe(true);
  });

  it('treats a recorded pid whose start time or boot differs as stale, and does not signal it', async () => {
    const other = stranger();
    const file = join(dir, 'api.pid');
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    for (const record of [`${other.pid} 1 ${boot}`, `${other.pid} 1 not-this-boot`]) {
      writeFileSync(file, `${record}\n`);
      const stop = await bash(`pidfile_stop ${JSON.stringify(file)} api 0`);
      expect(stop.code).toBe(1);
      expect(stop.out).toContain(`api: pid ${other.pid} is now another process`);
      expect(existsSync(file)).toBe(false);
    }
    await sleep(200);
    expect(alive(other.pid ?? 0)).toBe(true);
  });

  it('removes a pidfile whose process is gone, silently', async () => {
    const file = join(dir, 'worker.pid');
    writeFileSync(file, '2147483646 5 x\n');
    const check = await bash(`pidfile_alive ${JSON.stringify(file)}`);
    expect(check).toEqual({ code: 1, out: '' });
    expect(existsSync(file)).toBe(false);
  });

  it('recognises the process it started, then stops it', async () => {
    const file = join(dir, 'retrieval.pid');
    // The way stack.sh launches: the process records itself, then execs.
    const launched = spawn(
      'setsid',
      ['bash', '-c', '. "$1" && pidfile_record "$0" || exit 70; shift; exec sleep 300', file, LIB],
      { stdio: 'ignore', detached: true },
    );
    children.push(launched);
    const deadline = Date.now() + 5000;
    while (!existsSync(file) && Date.now() < deadline) await sleep(50);
    const [pid, start, boot] = readFileSync(file, 'utf8').trim().split(' ');
    expect(Number(pid)).toBeGreaterThan(0);
    expect(start).toMatch(/^\d+$/);
    expect(boot).toBe(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());

    expect((await bash(`pidfile_alive ${JSON.stringify(file)}`)).code).toBe(0);
    expect((await bash(`pidfile_stop ${JSON.stringify(file)} retrieval 50`)).code).toBe(0);
    expect(alive(Number(pid))).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('keeps a legacy pidfile whose process is still the one stack.sh starts under that name', async () => {
    // A stack started by the old script must stay stoppable: its pidfiles have no identity.
    const started = spawn('bash', ['-c', 'exec -a "python3 embed-server.py serve" sleep 300'], {
      stdio: 'ignore',
    });
    children.push(started);
    await sleep(200);
    const file = join(dir, 'embed.pid');
    writeFileSync(file, `${started.pid}\n`);
    expect((await bash(`pidfile_alive ${JSON.stringify(file)}`)).code).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});
