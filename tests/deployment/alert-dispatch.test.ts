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
/** What the endpoint should answer with next. */
let status = 200;

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
        response.writeHead(status).end('');
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
  status = 200;
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
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      env: {
        ...process.env,
        KF_ALERT_WEBHOOK_URL_FILE: urlFilePath,
        // What a private CA would supply on a real host. The script is unchanged.
        CURL_CA_BUNDLE: certificate,
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
