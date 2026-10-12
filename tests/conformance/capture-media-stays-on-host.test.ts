/**
 * A photo or a voice note captured on a phone goes to the Fabric and nowhere else (ADR 0040
 * decisions 8 and 10; KF-SAS-RQ-271, RQ-273; SAS §100.60).
 *
 * The capture page stores the media as evidence and does not transcribe it. Transcription would be
 * generation over the person's content, which KF-SAS-RQ-271 routes by classification; no route
 * for it exists, so none may be built quietly into a page. The usual way that promise breaks is
 * small: the browser's own speech recognition (Chrome's sends the audio to its vendor), or one
 * `fetch` from the capture code to a speech or vision service. So:
 *
 *   1. nothing in the web application uses the browser's speech recognition;
 *   2. every request the capture code makes goes to the Fabric's API (`${apiBaseUrl()}…`), and it
 *      opens no other channel (beacon, XHR, socket, event source);
 *   3. the web's nginx block lets the page ask for the microphone for itself only, and the API's
 *      asks for nothing; the browser's own CSP keeps `connect-src` at 'self'
 *      (apps/web/src/lib/csp.test.ts).
 *
 * Each rule is also run on a planted tree and seen to fail by name. What this does NOT cover: what
 * the API does with the bytes after `POST /ingest` (it stores and scans them; the parser reads text
 * formats only), and a dependency that phones home on its own, which no source scan can see.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

const SOURCE = /\.(?:ts|tsx|mjs|js)$/u;
/** The capture surface: the page, its components and actions, and its API client. */
const CAPTURE = /^apps\/web\/src\/(?:app\/capture\/|lib\/api\/capture\.ts$)/u;
/** Assembled, so this file does not trip its own scan. */
const SPEECH = new RegExp(['Speech', 'Recognition'].join(''), 'u');
const CHANNELS = /\b(?:sendBeacon|XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection)\b/u;
/** A `fetch(` whose first argument does not begin with the API's base URL. */
const FOREIGN_FETCH = /\bfetch\(\s*(?!`\$\{apiBaseUrl\(\)\})/u;

export function mediaPathViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const { path, text } of files) {
    if (!path.startsWith('apps/web/src/') || !SOURCE.test(path) || /\.test\./u.test(path)) {
      continue;
    }
    if (SPEECH.test(text)) violations.push(`speech-recognition: ${path}`);
    if (!CAPTURE.test(path)) continue;
    if (CHANNELS.test(text)) violations.push(`side-channel: ${path}`);
    if (FOREIGN_FETCH.test(text)) violations.push(`foreign-fetch: ${path}`);
  }
  return violations;
}

/** The Permissions-Policy of each server block, by the port it proxies to. */
export function permissionsByUpstream(conf: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const block of conf.split(/\nserver\s*\{/u).slice(1)) {
    const upstream = /proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/u.exec(block)?.[1];
    const policy = /add_header Permissions-Policy "([^"]*)"/u.exec(block)?.[1];
    if (upstream === undefined || policy === undefined) continue;
    out.set(upstream, [...(out.get(upstream) ?? []), policy]);
  }
  return out;
}

export function permissionViolations(conf: string): string[] {
  const byUpstream = permissionsByUpstream(conf);
  const violations: string[] = [];
  const web = byUpstream.get('3000') ?? [];
  const api = byUpstream.get('4000') ?? [];
  if (web.length === 0) violations.push('no web block');
  if (api.length === 0) violations.push('no api block');
  for (const policy of web) {
    if (!/(?:^|, )microphone=\(self\)(?:,|$)/u.test(policy)) violations.push(`web: ${policy}`);
    if (!/(?:^|, )camera=\(\)(?:,|$)/u.test(policy)) violations.push(`web camera: ${policy}`);
  }
  for (const policy of api) {
    if (!/(?:^|, )microphone=\(\)(?:,|$)/u.test(policy)) violations.push(`api: ${policy}`);
  }
  return violations;
}

function webTree(): SourceFile[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.startsWith('apps/web/src/') && SOURCE.test(path))
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
}

const NGINX = ['deploy/nginx/knowledge-fabric.conf', 'deploy/nginx/knowledge-fabric-tailnet.conf'];

describe('captured media stays on the host (SAS §100.60)', () => {
  const tree = webTree();

  it('scans the capture surface it claims to', () => {
    const capture = tree.filter((file) => CAPTURE.test(file.path)).map((file) => file.path);
    expect(capture).toEqual(
      expect.arrayContaining([
        'apps/web/src/app/capture/actions.ts',
        'apps/web/src/app/capture/voice-note.tsx',
        'apps/web/src/lib/api/capture.ts',
      ]),
    );
    // Not vacuous: the client really does post the media and the note, to the API.
    const client = tree.find((file) => file.path === 'apps/web/src/lib/api/capture.ts')!;
    expect(client.text.match(/\bfetch\(/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(client.text).toContain('/ingest');
  });

  it('finds no speech recognition, no side channel and no request but to the API', () => {
    expect(mediaPathViolations(tree)).toEqual([]);
  });

  it('lets the web, and only the web, ask for the microphone', () => {
    for (const file of NGINX) {
      expect(permissionViolations(readFileSync(join(ROOT, file), 'utf8')), file).toEqual([]);
    }
  });

  it('refuses each planted violation, and only those', () => {
    const recognizer = ['webkit', 'Speech', 'Recognition'].join('');
    expect(
      mediaPathViolations([
        { path: 'apps/web/src/app/agent/listen.tsx', text: `new window.${recognizer}();` },
        {
          path: 'apps/web/src/app/capture/voice-note.tsx',
          text: "await fetch('https://speech.example.com/v1/transcribe', { body });",
        },
        { path: 'apps/web/src/lib/api/capture.ts', text: "navigator.sendBeacon('/x', blob);" },
        { path: 'apps/web/src/app/capture/actions.ts', text: 'fetch(url, { body: bytes });' },
        // Legitimate: the API's own base, and a fetch outside the capture surface.
        {
          path: 'apps/web/src/lib/api/capture.ts',
          text: 'await fetch(`${apiBaseUrl()}/ingest`, { method: "POST" });',
        },
        { path: 'apps/web/src/lib/api/search.ts', text: 'await fetch(url);' },
        { path: 'apps/web/src/app/capture/voice-note.test.ts', text: `${recognizer}` },
      ]),
    ).toEqual([
      'speech-recognition: apps/web/src/app/agent/listen.tsx',
      'foreign-fetch: apps/web/src/app/capture/voice-note.tsx',
      'side-channel: apps/web/src/lib/api/capture.ts',
      'foreign-fetch: apps/web/src/app/capture/actions.ts',
    ]);
    const conf = (web: string, api: string) =>
      `x\nserver {\n add_header Permissions-Policy "${web}" always;\n proxy_pass http://127.0.0.1:3000;\n}\n` +
      `server {\n add_header Permissions-Policy "${api}" always;\n proxy_pass http://127.0.0.1:4000;\n}\n`;
    expect(
      permissionViolations(
        conf('camera=(), microphone=(self)', 'camera=(), geolocation=(), microphone=()'),
      ),
    ).toEqual([]);
    expect(permissionViolations(conf('camera=(), microphone=*', 'microphone=()'))).toEqual([
      'web: camera=(), microphone=*',
    ]);
    expect(
      permissionViolations(conf('camera=(self), microphone=(self)', 'microphone=(self)')),
    ).toEqual(['web camera: camera=(self), microphone=(self)', 'api: microphone=(self)']);
  });
});
