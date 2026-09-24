import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from './client.js';
import {
  CaptureInputRefused,
  captureInputFromForm,
  captureObservation,
  parseCaptureOutcome,
} from './capture.js';
import { UNVERIFIED_LABEL } from './verification.js';

/**
 * The web capture form reaches the one capture route (KF-SAS-RQ-203) and sends the note and
 * nothing about authority (RQ-200). What it sends is asserted exactly; what it shows is the
 * API's verification label, parsed fail-closed.
 */

const caller: Caller = {
  authentication: 'development',
  actorId: 'actor-1',
  actingRoleId: 'role-1',
  organizationId: 'organization-1',
  maxClassification: 'internal',
};

const SUBJECT = '019ff405-2ec7-736e-898a-1f5687a80a48';
/** Exactly the fields POST /capture/observation accepts (apps/api/src/routes/capture.ts). */
const ROUTE_FIELDS = new Set(['body', 'subjects', 'tags', 'observed_at', 'gesture_id']);

const originalApiUrl = process.env['KF_API_URL'];
afterEach(() => {
  vi.restoreAllMocks();
  if (originalApiUrl === undefined) delete process.env['KF_API_URL'];
  else process.env['KF_API_URL'] = originalApiUrl;
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const answered = {
  observationId: 'obs-1',
  actionId: 'act-1',
  replayed: false,
  gestureId: 'gesture-0001',
  actingRoleId: 'role-1',
  lifecycleState: 'captured',
  verification: { verified: false, label: UNVERIFIED_LABEL },
};

describe('the capture form', () => {
  it('posts the note to the capture route with no role, key or version in the body', async () => {
    process.env['KF_API_URL'] = 'http://api.test';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(answered), { status: 201 }));
    const outcome = await captureObservation(
      captureInputFromForm(
        form({
          body: 'Board B noise floor',
          gestureId: 'gesture-0001',
          tags: 'bench, eeg',
          subjects: SUBJECT,
        }),
      ),
      caller,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test/capture/observation');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      body: 'Board B noise floor',
      gesture_id: 'gesture-0001',
      tags: ['bench', 'eeg'],
      subjects: [SUBJECT],
    });
    for (const key of Object.keys(body)) expect(ROUTE_FIELDS.has(key), key).toBe(true);
    // The session's role is a header, as on every request — never a body field.
    expect((init?.headers as Record<string, string>)['x-kf-acting-role']).toBe('role-1');
    expect(outcome.verification).toEqual({ verified: false, label: UNVERIFIED_LABEL });
  });

  it('refuses an empty note and a malformed subject before asking the API', () => {
    expect(() => captureInputFromForm(form({ body: '  ', gestureId: 'gesture-0001' }))).toThrow(
      CaptureInputRefused,
    );
    expect(() =>
      captureInputFromForm(form({ body: 'x', gestureId: 'gesture-0001', subjects: 'board-b' })),
    ).toThrow(/not an object id/);
    expect(() => captureInputFromForm(form({ body: 'x', gestureId: 'short' }))).toThrow(/expired/);
  });

  it('shows an unproven verification as unverified, never as verified', () => {
    expect(
      parseCaptureOutcome({
        ...answered,
        verification: { verified: true, label: 'verified, trust me' },
      }).verification,
    ).toEqual({ verified: false, label: UNVERIFIED_LABEL });
    expect(() => parseCaptureOutcome({ observationId: 'x' })).toThrow(/contract/);
  });
});
