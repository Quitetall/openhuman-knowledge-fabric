import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from '../proxy';
import manifest from './manifest';

/**
 * The installable app (docs/workspace.md, "Use it on Windows").
 *
 * What this checks: the manifest carries every field Chrome and Edge require before they offer
 * "Install" (a name, a start URL, a standalone display, 192 and 512 pixel icons, a maskable one),
 * each icon it names exists with the size it claims, its colours are the design tokens, the proxy
 * passes the manifest and icons to a signed-out browser without a redirect, and no service worker
 * exists anywhere in the web app to cache an access-controlled page.
 *
 * What it does not check: that a browser actually offers the install (that needs HTTPS or
 * localhost and a real browser), or what nginx in front of the app does with these paths.
 */

const WEB = fileURLToPath(new URL('../..', import.meta.url));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('the installable app', () => {
  const m = manifest();

  it('has what Chrome and Edge require to offer "Install Knowledge Fabric"', () => {
    expect(m.name).toBe('Knowledge Fabric');
    expect(m.short_name).toBeTruthy();
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
    const sizes = (m.icons ?? []).filter((icon) => icon.type === 'image/png');
    expect(sizes.some((icon) => icon.sizes === '192x192' && icon.purpose === 'any')).toBe(true);
    expect(sizes.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any')).toBe(true);
    expect(sizes.some((icon) => icon.purpose === 'maskable')).toBe(true);
    expect((m.icons ?? []).some((icon) => icon.type === 'image/svg+xml')).toBe(true);
  });

  it('names only icons that exist, at the size each claims', () => {
    for (const icon of m.icons ?? []) {
      const path = join(WEB, 'public', icon.src);
      expect(existsSync(path), icon.src).toBe(true);
      if (icon.type !== 'image/png') continue;
      const [width, height] = (icon.sizes ?? '').split('x').map(Number);
      expect(pngSize(path), icon.src).toEqual({ width, height });
    }
  });

  it('takes its colours from the design tokens', () => {
    const css = readFileSync(join(WEB, 'src/app/globals.css'), 'utf8');
    const light = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    expect(light).toContain(`--kf-accent: ${m.theme_color};`);
    expect(light).toContain(`--kf-ground: ${m.background_color};`);
  });

  it('is served to a signed-out browser, with no redirect to sign in', () => {
    for (const path of ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']) {
      const response = proxy(new NextRequest(`http://kf.test${path}`));
      expect(response.status, path).toBeLessThan(300);
      expect(response.headers.get('location'), path).toBeNull();
      // Next's own marker that the request continues to the route, not a redirect or rewrite.
      expect(response.headers.get('x-middleware-next'), path).toBe('1');
    }
  });

  it('has no service worker: nothing may keep a page or a record offline', () => {
    const sources = [...filesUnder(join(WEB, 'src')), ...filesUnder(join(WEB, 'public'))];
    expect(
      sources.filter((path) => /(^|\/)(sw|service-?worker)[^/]*\.[cm]?[jt]sx?$/i.test(path)),
    ).toEqual([]);
    const registers = sources
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !path.endsWith('manifest.test.ts'))
      .filter((path) => readFileSync(path, 'utf8').includes('serviceWorker'));
    expect(registers).toEqual([]);
  });
});
