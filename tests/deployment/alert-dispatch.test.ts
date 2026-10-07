/**
 * The alert path actually delivers, and refuses rather than pretending when it cannot.
 *
 * `docs/threat-model/README.md` open item 5 recorded the absent alert unit as "a genuine gap",
 * because every scheduled unit routes `OnFailure=kf-alert@%n.service` at something that did not
 * exist. The reasoning for leaving it absent was sound — a default that goes nowhere is worse
 * than one that fails to start — and it means the replacement has to be held to that standard:
 * an alerter that silently does not deliver is the thing it was refusing to ship.
 *
 * So this runs the real script against a real HTTPS server. Not a mock: `curl` is invoked, TLS
 * is negotiated against a generated certificate trusted through `CURL_CA_BUNDLE`, and the body
 * that arrives is the body a webhook would receive. The script is not modified or flagged for
 * testing — the only thing the test supplies is a trust root, which is what a private CA would
 * supply in production anyway.
 *
 * The payload assertion is the one worth reading twice. It checks the key set EXACTLY, so a
 * future change that starts attaching a journal excerpt fails here. That is a data-boundary
 * rule, not a preference: the destination is a third-party endpoint outside this system, and
 * a log line from a failed backup or compilation can carry record content.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'alert-dispatch.sh');

let workspace: string;
let certificate: string;
let server: Server | undefined;
let port = 0;
/** Bodies the endpoint received, in order. */
let received: string[] = [];
let paths: string[] = [];
/** What the endpoint should answer with next. */
let status = 200;
let responseBody = '';

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'kf-alert-'));
  const key = join(workspace, 'key.pem');
  certificate = join(workspace, 'cert.pem');
  const openssl = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { encoding: 'utf8' },
  );
  expect(openssl.status, `openssl failed: ${openssl.stderr}`).toBe(0);

  server = createServer(
    {
      key: readFileSync(key),
      cert: readFileSync(certificate),
    },
    (request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        received.push(body);
        paths.push(request.url!);
        response.writeHead(status).end(responseBody);
      });
    },
  );
  // `listen` is asynchronous: `address()` is null until the socket is bound, and reading the
  // port immediately after gives a TypeError rather than a port.
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
}, 60_000);

afterAll(() => {
  server?.close();
  rmSync(workspace, { recursive: true, force: true });
});

afterEach(() => {
  received = [];
  paths = [];
  status = 200;
  responseBody = '';
});

/** Write a webhook-url secret with the given contents and mode. */
function urlFile(contents: string, mode = 0o600): string {
  const path = join(workspace, `url-${Math.abs(contents.length)}-${mode}`);
  writeFileSync(path, `${contents}\n`);
  chmodSync(path, mode);
  return path;
}

/**
 * Run the script, ASYNCHRONOUSLY, and collect its exit code and output.
 *
 * Asynchronously is load-bearing, not stylistic. The HTTPS endpoint above runs in THIS
 * process, and `spawnSync` blocks this process's event loop until the child exits — so the
 * server could never accept the connection the child was making, and every delivery test
 * failed with `curl: (28) Connection timed out` while a plain curl from a shell worked fine.
 * The test had deadlocked itself against its own server.
 */
async function dispatch(
  args: readonly string[],
  urlFilePath: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      env: {
        ...process.env,
        KF_ALERT_WEBHOOK_URL_FILE: urlFilePath,
        // What a private CA would supply on a real host. The script is unchanged.
        CURL_CA_BUNDLE: certificate,
        ...env,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stderr: output }));
  });
}

describe('the alert path', () => {
  it('refuses an incomplete native proof invocation before creating fixtures', () => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/deploy/test-alert-credentials.mjs')],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('run as root with one freshly compiled custody helper path\n');
  });

  it.each([
    ['alert-workstation-credentials.conf', 'kf-alert-%i'],
    ['alert-heartbeat-workstation-credentials.conf', 'kf-alert-heartbeat'],
    ['alert-ntfy-healthchecks.conf', 'kf-alert-%i'],
    ['alert-heartbeat-ntfy-healthchecks.conf', 'kf-alert-heartbeat'],
  ])('binds native endpoint custody and private unswapped runtime in %s', (file, runtime) => {
    const dropin = readFileSync(join(ROOT, 'deploy/systemd', file), 'utf8');
    expect(dropin).toContain('Environment=KF_SECRET_CUSTODY=systemd');
    expect(dropin).toContain(`RuntimeDirectory=${runtime}\n`);
    expect(dropin).toContain('RuntimeDirectoryMode=0700\n');
    expect(dropin).toContain(`Environment=TMPDIR=/run/${runtime}\n`);
    expect(dropin).toContain('MemorySwapMax=0\n');
    expect(dropin).toContain('LimitCORE=0\n');
    expect(dropin).toContain('ProcSubset=all\n');
  });

  it('retains the heartbeat liveness guard in the encrypted-credential drop-in', () => {
    const heartbeat = readFileSync(
      join(ROOT, 'deploy/systemd/alert-heartbeat-ntfy-healthchecks.conf'),
      'utf8',
    );
    expect(heartbeat).toContain('ExecStartPre=\n');
    expect(heartbeat).toContain(
      'ExecStartPre=/opt/kf/scripts/timer-liveness.sh kf-readiness.timer',
    );
    expect(heartbeat).toContain('LoadCredentialEncrypted=heartbeat-url:');
    expect(heartbeat).toContain('Environment=KF_ALERT_HEARTBEAT_URL_FILE=%d/heartbeat-url');
  });

  it('sends only a fixed generic message to a free ntfy topic', async () => {
    responseBody = JSON.stringify({
      event: 'message',
      message: 'Service needs attention. Check the service locally.',
    });
    const file = urlFile(`https://127.0.0.1:${port}/ntfy-topic`);
    const result = await dispatch(['failure', 'sensitive-unit.service'], file, {
      KF_ALERT_PROVIDER: 'ntfy-healthchecks',
    });
    expect(result.code, result.stderr).toBe(0);
    expect(received).toEqual(['Service needs attention. Check the service locally.']);
    expect(paths).toEqual(['/ntfy-topic']);
  });

  it('pushes a person’s urgent item as one fixed line that names nothing (KF-SAS-RQ-274)', async () => {
    responseBody = JSON.stringify({
      event: 'message',
      message: 'Something in Knowledge Fabric needs you. Open Needs you.',
    });
    const file = urlFile(`https://127.0.0.1:${port}/ntfy-urgent-topic`);
    // Arguments after the event are ignored: the push cannot be made to carry a title.
    const result = await dispatch(['urgent', 'Acquisition target is Halberd Aero'], file, {
      KF_ALERT_PROVIDER: 'ntfy-healthchecks',
    });
    expect(result.code, result.stderr).toBe(0);
    expect(received).toEqual(['Something in Knowledge Fabric needs you. Open Needs you.']);
    expect(received.join('')).not.toContain('Halberd');
  });

  it('refuses an urgent acknowledgement that does not echo the fixed line', async () => {
    responseBody = JSON.stringify({
      event: 'message',
      message: 'Service needs attention. Check the service locally.',
    });
    const file = urlFile(`https://127.0.0.1:${port}/ntfy-urgent-false`);
    const result = await dispatch(['urgent'], file, { KF_ALERT_PROVIDER: 'ntfy-healthchecks' });
    expect(result.code).not.toBe(0);
    expect(received).toHaveLength(3);
  }, 60_000);

  it('sends an urgent event to a webhook with no record content, as an exact key set', async () => {
    const file = urlFile(`https://127.0.0.1:${port}/urgent-hook`);
    expect((await dispatch(['urgent', 'Halberd'], file)).code).toBe(0);
    const body = JSON.parse(received[0]!) as Record<string, unknown>;
    expect(body.event).toBe('urgent');
    expect(body.unit).toBe('kf-notify-urgent.service');
    expect(Object.keys(body).sort()).toEqual(['at', 'event', 'host', 'logs', 'schema', 'unit']);
    expect(received[0]).not.toContain('Halberd');
  });

  it('sends an empty heartbeat to Healthchecks, not to ntfy', async () => {
    responseBody = 'OK';
    // Write distinct paths: the old helper names files from length, not from contents.
    const topic = urlFile(`https://127.0.0.1:${port}/topic`);
    const heartbeat = urlFile(`https://127.0.0.1:${port}/healthchecks-heartbeat`);
    const result = await dispatch(['heartbeat'], topic, {
      KF_ALERT_PROVIDER: 'ntfy-healthchecks',
      KF_ALERT_HEARTBEAT_URL_FILE: heartbeat,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(paths).toEqual(['/healthchecks-heartbeat']);
    expect(received).toEqual(['']);
  });

  it('refuses Healthchecks HTTP 200 responses for an unknown check', async () => {
    responseBody = 'OK (not found)';
    const file = urlFile(`https://127.0.0.1:${port}/unknown-check`);
    const result = await dispatch(['heartbeat'], file, {
      KF_ALERT_PROVIDER: 'ntfy-healthchecks',
      KF_ALERT_HEARTBEAT_URL_FILE: file,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('nobody has been told');
    expect(received).toHaveLength(3);
  }, 60_000);

  it('refuses a false ntfy acknowledgement without exposing its response', async () => {
    responseBody = JSON.stringify({ event: 'message', message: 'private-provider-content' });
    const file = urlFile(`https://127.0.0.1:${port}/false-ack`);
    const result = await dispatch(['failure', 'kf-backup.service'], file, {
      KF_ALERT_PROVIDER: 'ntfy-healthchecks',
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain('private-provider-content');
    expect(received).toHaveLength(3);
  }, 60_000);

  it('refuses an unknown provider before delivering anything', async () => {
    const result = await dispatch(['failure', 'kf-backup.service'], '/no-such-file', {
      KF_ALERT_PROVIDER: 'typo',
    });
    expect(result.code).toBe(2);
    expect(received).toEqual([]);
  });

  it('refuses a failure ping URL accidentally configured as a heartbeat', async () => {
    const file = urlFile(`https://127.0.0.1:${port}/check/fail`);
    const result = await dispatch(['heartbeat'], file, {
      KF_ALERT_PROVIDER: 'ntfy-healthchecks',
      KF_ALERT_HEARTBEAT_URL_FILE: file,
    });
    expect(result.code).not.toBe(0);
    expect(received).toEqual([]);
  });

  it('refuses multiline URL config injection', async () => {
    const result = await dispatch(
      ['failure', 'kf-backup.service'],
      urlFile(`https://127.0.0.1:${port}/hook\noutput = /tmp/not-allowed`),
    );
    expect(result.code).not.toBe(0);
    expect(received).toEqual([]);
  });

  it('delivers a failure alert over real TLS and says which unit and where the logs are', async () => {
    const file = urlFile(`https://127.0.0.1:${port}/hook`);
    const { code, stderr } = await dispatch(['failure', 'kf-backup.service'], file);
    expect(code, stderr).toBe(0);
    expect(received).toHaveLength(1);

    const body = JSON.parse(received[0]!) as Record<string, unknown>;
    expect(body.schema).toBe('kf.alert.v1');
    expect(body.event).toBe('failure');
    expect(body.unit).toBe('kf-backup.service');
    expect(typeof body.host).toBe('string');
    expect(body.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    // The alert tells the operator how to get the logs rather than carrying them.
    expect(String(body.logs)).toMatch(/^journalctl /);
  });

  it('carries no log content, asserted as an exact key set', async () => {
    const file = urlFile(`https://127.0.0.1:${port}/hook`);
    expect((await dispatch(['failure', 'kf-checkpoint.service'], file)).code).toBe(0);
    const body = JSON.parse(received[0]!) as Record<string, unknown>;

    // Exact, not a subset. A future change that attaches a journal excerpt to help debugging
    // would be a sensible-looking commit that starts shipping record content to a third-party
    // endpoint, and this is the assertion that stops it.
    const permitted = new Set([
      'schema',
      'event',
      'unit',
      'host',
      'at',
      'logs',
      'result',
      'exitStatus',
      'invocationId',
    ]);
    const unexpected = Object.keys(body).filter((key) => !permitted.has(key));
    expect(
      unexpected,
      'the alert payload grew a field. If it carries anything from a journal, it is sending ' +
        'record content off this system to an endpoint outside it.',
    ).toEqual([]);
  });

  it('sends a heartbeat, which is what makes a dead alert path detectable', async () => {
    const file = urlFile(`https://127.0.0.1:${port}/hook`);
    expect((await dispatch(['heartbeat'], file)).code).toBe(0);
    const body = JSON.parse(received[0]!) as Record<string, unknown>;
    expect(body.event).toBe('heartbeat');
  });

  it('fails loudly when the endpoint rejects, rather than reporting success to nobody', async () => {
    status = 500;
    const file = urlFile(`https://127.0.0.1:${port}/hook`);
    const { code, stderr } = await dispatch(['failure', 'kf-backup.service'], file);
    expect(code, 'a rejected alert must not exit 0').not.toBe(0);
    expect(stderr).toContain('nobody has been told');
    // Retried before giving up: a reload at the far end should not lose an alert.
    expect(received.length).toBeGreaterThan(1);
  }, 60_000);

  it('refuses a cleartext endpoint', async () => {
    const { code, stderr } = await dispatch(
      ['failure', 'kf-backup.service'],
      urlFile(`http://127.0.0.1:${port}/hook`),
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain('refusing to send an alert in clear text');
    expect(received).toHaveLength(0);
  });

  it('refuses a webhook URL readable beyond its owner', async () => {
    // The URL is a credential: whoever holds it can forge alerts from this deployment. Same
    // rule as every other secret here, enforced by the same helper.
    const { code, stderr } = await dispatch(
      ['failure', 'kf-backup.service'],
      urlFile(`https://127.0.0.1:${port}/hook`, 0o640),
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain('already disclosed');
    expect(received).toHaveLength(0);
  });

  it('refuses an unknown event instead of sending something undefined', async () => {
    const { code } = await dispatch(
      ['explode', 'kf-backup.service'],
      urlFile(`https://127.0.0.1:${port}/x`),
    );
    expect(code).toBe(2);
    expect(received).toHaveLength(0);
  });
});
