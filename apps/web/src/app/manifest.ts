import type { MetadataRoute } from 'next';

/**
 * The web app manifest, served at /manifest.webmanifest: what makes Knowledge Fabric installable
 * from Edge or Chrome as an app with its own window and a Start-menu and taskbar icon
 * (docs/workspace.md, "Use it on Windows").
 *
 * Current Chrome and Edge need only this — a name, a start URL, a standalone display and 192 and
 * 512 pixel icons, over HTTPS or on localhost — and no service worker, so there is none. That is
 * deliberate as well as sufficient: records are access-controlled, and nothing here may keep a
 * page or a record where a later reader of the same machine, or the same person after losing
 * access, could open it. The installed app is the same site in its own window; it works only
 * while the server is reachable, and every page is fetched and access-checked as in a tab.
 *
 * The manifest names no record and needs no session, so the proxy serves it to a signed-out
 * browser like any static file; the icons are in `public/icons`.
 *
 * What this does not cover: there is no packaged installer (SAS §100.73), and an install still
 * needs a server the PC can reach (a hosted one is roadmap M6).
 */

/** The design tokens of globals.css, light theme: ledger-green accent on the pale stone ground. */
const THEME_COLOR = '#1d5c4f';
const BACKGROUND_COLOR = '#f3f5f4';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Knowledge Fabric',
    short_name: 'Knowledge Fabric',
    description:
      'Your organization’s documents and records in one place: ask a question or search, and see only what you are allowed to see.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
      { src: '/icons/knowledge-fabric.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
