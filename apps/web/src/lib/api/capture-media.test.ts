import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Caller } from './client.js';
import {
  CaptureInputRefused,
  MAX_CAPTURE_MEDIA_BYTES,
  captureInputFromForm,
  captureMediaFromForm,
  classificationsUpTo,
  ingestCaptureMedia,
  ingestRequestBody,
  mediaOnlyBody,
} from './capture.js';

/**
 * A photo or a voice note on a capture (ADR 0040 decision 10; KF-SAS-RQ-273; SAS §100.60). The
 * media travels the one path a file takes in, `POST /ingest`, spelled exactly as that route reads
 * its body; the form refuses what is not a photo or a recording, and more than fits the web's own
 * body limit, before anything is sent.
 */

const caller: Caller = {
  authentication: 'development',
  actorId: 'actor-1',
  actingRoleId: 'role-1',
  organizationId: 'organization-1',
  maxClassification: 'confidential',
};
const ARTIFACT = '019ff405-2ec7-736e-898a-1f5687a80a49';
/** The fields `parseIngest` reads (apps/api/src/routes/documents/ingest-route.ts `IngestBody`). */
const INGEST_FIELDS = [
  'title',
  'artifactKind',
  'classification',
  'mediaType',
  'contentBase64',
  'revisionLabel',
  'reason',
  'idempotencyKey',
  'derivedFrom',
];

const originalApiUrl = process.env['KF_API_URL'];
afterEach(() => {
  vi.restoreAllMocks();
  if (originalApiUrl === undefined) delete process.env['KF_API_URL'];
  else process.env['KF_API_URL'] = originalApiUrl;
});

function file(name: string, type: string, size = 16): File {
  return new File([new Uint8Array(size).fill(7)], name, { type });
}

describe('media on a capture', () => {
  it('takes one photo and one voice note, by type, and ignores an empty file input', async () => {
    const data = new FormData();
    data.set('photo', file('IMG_0001.JPG', 'image/jpeg'));
    data.set('voice', file('voice-note.webm', 'audio/webm;codecs=opus'));
    const media = await captureMediaFromForm(data);
    expect(media.map((m) => [m.kind, m.name, m.mediaType, m.bytes.length])).toEqual([
      ['photo', 'IMG_0001.JPG', 'image/jpeg', 16],
      ['voice', 'voice-note.webm', 'audio/webm', 16],
    ]);
    const empty = new FormData();
    empty.set('photo', new File([], '', { type: 'application/octet-stream' }));
    expect(await captureMediaFromForm(empty)).toEqual([]);
  });

  it('refuses what is not a photo or a recording, two of one kind, and too much', async () => {
    const wrong = new FormData();
    wrong.set('photo', file('notes.txt', 'text/plain'));
    await expect(captureMediaFromForm(wrong)).rejects.toThrow(CaptureInputRefused);
    const swapped = new FormData();
    swapped.set('voice', file('photo.jpg', 'image/jpeg'));
    await expect(captureMediaFromForm(swapped)).rejects.toThrow(/not a voice note/);
    const two = new FormData();
    two.append('photo', file('a.jpg', 'image/jpeg'));
    two.append('photo', file('b.jpg', 'image/jpeg'));
    await expect(captureMediaFromForm(two)).rejects.toThrow(/one photo/);
    const large = new FormData();
    large.set('photo', file('a.jpg', 'image/jpeg', MAX_CAPTURE_MEDIA_BYTES - 8));
    large.set('voice', file('v.webm', 'audio/webm', 16));
    await expect(captureMediaFromForm(large)).rejects.toThrow(/over 10 MiB/);
  });

  it('holds the media limit under the web server-action body limit', () => {
    const config = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'next.config.mjs'),
      'utf8',
    );
    const limit = /bodySizeLimit: '(\d+)mb'/.exec(config);
    expect(limit).not.toBeNull();
    expect(MAX_CAPTURE_MEDIA_BYTES).toBeLessThan(Number(limit![1]) * 1000 * 1000);
  });

  it('lets a capture with media leave the note empty, and says what was captured', async () => {
    const data = new FormData();
    data.set('body', '  ');
    data.set('gestureId', 'gesture-0001');
    expect(() => captureInputFromForm(data)).toThrow(CaptureInputRefused);
    data.set('photo', file('a.jpg', 'image/jpeg'));
    const media = await captureMediaFromForm(data);
    const input = captureInputFromForm(data, media);
    expect(input.body).toBe(mediaOnlyBody(media));
    expect(input.body).toMatch(/a photo.*Not transcribed/);
  });

  it('offers only the classifications at or below the session ceiling', () => {
    expect(classificationsUpTo('internal')).toEqual(['public', 'internal']);
    expect(classificationsUpTo('restricted')).toHaveLength(4);
    expect(classificationsUpTo('nonsense')).toEqual([]);
  });

  it('sends each piece to /ingest as the route spells it, keyed by gesture and bytes', async () => {
    process.env['KF_API_URL'] = 'http://api.test';
    const data = new FormData();
    data.set('voice', file('voice-note.m4a', 'audio/mp4'));
    const [media] = await captureMediaFromForm(data);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ artifactId: ARTIFACT, replayed: false }), { status: 201 }),
      );
    const outcome = await ingestCaptureMedia(
      media!,
      { gestureId: 'gesture-0001', classification: 'internal', sha256: 'ab'.repeat(32) },
      caller,
    );
    expect(outcome).toEqual({
      kind: 'voice',
      artifactId: ARTIFACT,
      replayed: false,
      sha256: 'ab'.repeat(32),
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://api.test/ingest');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(Object.keys(body).every((k) => INGEST_FIELDS.includes(k))).toBe(true);
    expect(body).toEqual(
      ingestRequestBody(media!, {
        gestureId: 'gesture-0001',
        classification: 'internal',
        sha256: 'ab'.repeat(32),
      }),
    );
    expect(body['title']).toBe('Voice note: voice-note.m4a');
    expect(body['mediaType']).toBe('audio/mp4');
    expect(body['idempotencyKey']).toBe(`kf-capture-media-v1-gesture-0001-${'ab'.repeat(32)}`);
    expect(Buffer.from(String(body['contentBase64']), 'base64')).toEqual(Buffer.from(media!.bytes));
  });

  it('fails closed on an ingest answer that names no artifact', async () => {
    process.env['KF_API_URL'] = 'http://api.test';
    const data = new FormData();
    data.set('photo', file('a.jpg', 'image/jpeg'));
    const [media] = await captureMediaFromForm(data);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ replayed: false }), { status: 201 }),
    );
    await expect(
      ingestCaptureMedia(
        media!,
        { gestureId: 'gesture-0001', classification: 'internal', sha256: 'cd'.repeat(32) },
        caller,
      ),
    ).rejects.toThrow(/did not match/);
  });
});
