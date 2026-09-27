import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CAPTURE_BODY_FIELDS } from '../routes/capture.js';
import { noteRequest, parseNoteArgs, runNoteCommand } from './cli.js';

/**
 * `kf note` sends the note and nothing about authority (KF-SAS-RQ-200), to the one capture route
 * every surface shares (RQ-203). What it sends is asserted exactly; that the route then records
 * it is tests/end-to-end/observation-capture.test.ts, against a real stack.
 */

const ORG = '019ff405-2ec7-736e-898a-1f5687a80a48';
const ROLE = '019ff405-2ecb-7e77-96cb-00990ac6f24c';

async function tokenFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kf-note-'));
  const path = join(dir, 'token');
  await writeFile(path, 'tok.en.value\n', { mode: 0o600 });
  return path;
}

function sink(): Writable & { text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write: (chunk: Buffer, _enc, done) => {
      chunks.push(chunk.toString());
      done();
    },
  }) as Writable & { text(): string };
  stream.text = () => chunks.join('');
  return stream;
}

describe('parseNoteArgs', () => {
  it('takes one quoted note, and repeatable tags and subjects', () => {
    const args = parseNoteArgs([
      'Noise floor 2.1 µV',
      '--tag',
      'bench',
      '--tag=eeg',
      '--subject',
      ROLE,
      '--token-file',
      't',
      '--organization',
      ORG,
    ]);
    expect(args).toMatchObject({
      text: 'Noise floor 2.1 µV',
      tags: ['bench', 'eeg'],
      subjects: [ROLE],
      identity: 'oidc',
    });
    expect(args.actingRoleId).toBeUndefined();
  });

  it('refuses no note, two notes, and an unknown flag', () => {
    expect(() => parseNoteArgs(['--organization', ORG])).toThrow(/nothing to note/);
    expect(() => parseNoteArgs(['one', 'two'])).toThrow(/one note per gesture/);
    expect(() => parseNoteArgs(['x', '--idempotency-key', 'k'])).toThrow(/unknown option/);
  });
});

describe('the request kf note sends', () => {
  it('carries no role, key or version: the body is the note, the headers are identity', async () => {
    const { url, init } = noteRequest(
      parseNoteArgs(['Board B', '--token-file', await tokenFile(), '--organization', ORG]),
      { KF_API_ORIGIN: 'https://api.kf.internal/' },
    );
    expect(url).toBe('https://api.kf.internal/capture/observation');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ body: 'Board B' });
    for (const key of Object.keys(body)) expect(CAPTURE_BODY_FIELDS.has(key)).toBe(true);
    const headers = init.headers as Record<string, string>;
    expect(headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer tok.en.value',
      'x-kf-organization': ORG,
    });
  });

  it('names an assignment only when the person chose one, and passes a gesture id through', async () => {
    const { init } = noteRequest(
      parseNoteArgs([
        'Board B',
        '--token-file',
        await tokenFile(),
        '--organization',
        ORG,
        '--acting-role',
        ROLE,
        '--gesture',
        'gesture-retry-1',
        '--tag',
        'bench',
      ]),
      { KF_API_ORIGIN: 'https://api.kf.internal' },
    );
    expect((init.headers as Record<string, string>)['x-kf-acting-role']).toBe(ROLE);
    expect(JSON.parse(String(init.body))).toEqual({
      body: 'Board B',
      tags: ['bench'],
      gesture_id: 'gesture-retry-1',
    });
  });

  it('refuses development identity outside a development environment', () => {
    expect(() =>
      noteRequest(parseNoteArgs(['x', '--identity', 'dev']), {
        KF_API_ORIGIN: 'http://127.0.0.1:4000',
        NODE_ENV: 'production',
        KF_DEV_ACTOR: ROLE,
        KF_DEV_ORGANIZATION: ORG,
      }),
    ).toThrow(/requires NODE_ENV=development/);
  });
});

describe('runNoteCommand', () => {
  it('prints the observation, its verification label and the gesture to retry with', async () => {
    const out = sink();
    const err = sink();
    const fake = (async () =>
      new Response(
        JSON.stringify({
          observationId: 'obs-1',
          actionId: 'act-1',
          replayed: false,
          gestureId: 'g-1',
          actingRoleId: ROLE,
          lifecycleState: 'captured',
          verification: { verified: false, label: 'UNVERIFIED — nobody has checked this record' },
        }),
        { status: 201 },
      )) as typeof fetch;
    const code = await runNoteCommand(
      ['Board B', '--token-file', await tokenFile(), '--organization', ORG],
      { KF_API_ORIGIN: 'https://api.kf.internal' },
      out,
      err,
      fake,
    );
    expect(code, err.text()).toBe(0);
    expect(out.text()).toContain('recorded: observation obs-1');
    expect(out.text()).toContain('UNVERIFIED — nobody has checked this record');
    expect(out.text()).toContain('--gesture g-1');
  });

  it('prints the assignments to choose from when the server will not guess, and exits 2', async () => {
    const out = sink();
    const err = sink();
    const fake = (async () =>
      new Response(
        JSON.stringify({
          error: 'acting_assignment_ambiguous',
          message: 'name one',
          assignments: [
            { assignmentId: ROLE, roleId: 'performer', scopeId: ORG },
            { assignmentId: ORG, roleId: 'reviewer', scopeId: ORG },
          ],
        }),
        { status: 422 },
      )) as typeof fetch;
    const code = await runNoteCommand(
      ['Board B', '--token-file', await tokenFile(), '--organization', ORG],
      { KF_API_ORIGIN: 'https://api.kf.internal' },
      out,
      err,
      fake,
    );
    expect(code).toBe(2);
    expect(err.text()).toContain('not recorded: 422 acting_assignment_ambiguous');
    expect(err.text()).toContain(`${ROLE}  performer`);
    expect(err.text()).toContain('--acting-role');
  });
});
