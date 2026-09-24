/**
 * Nothing new is needed to run the fabric locally.
 *
 * On 2026-09-23 the API stopped defaulting an unset NODE_ENV to `development` — correctly: a
 * unit that forgot it came up trusting identity headers. The cost landed on every workstation,
 * where `pnpm dev` from a shell that had not sourced `.env` now died at boot. Each app's `dev`
 * script says what it is instead, so the refusal stays on hosts and off laptops.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

const devScripts = readdirSync(join(ROOT, 'apps'))
  .map((app) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'apps', app, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return [app, manifest.scripts?.['dev']] as const;
  })
  .filter((entry): entry is readonly [string, string] => entry[1] !== undefined);

describe('local development sets its own NODE_ENV', () => {
  it('finds the dev scripts it is checking', () => {
    expect(devScripts.map(([app]) => app).sort()).toEqual(['api', 'attestor', 'web', 'worker']);
  });

  it.each(devScripts)('apps/%s: `dev` runs with NODE_ENV=development', (_app, script) => {
    expect(script).toMatch(/^NODE_ENV=development /);
  });

  it('the dogfood loader does too', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts['dogfood:load']).toContain(
      'NODE_ENV=development pnpm --filter @kf/api dogfood',
    );
  });
});

describe('the dogfood profile starts without hand steps', () => {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };

  it('`pnpm dev` stays the development profile: it does not start kf-attestor', () => {
    // Under the development profile the API attests in-process through kf_api_dev; an attestor
    // started beside it would die for want of OIDC_* and take `pnpm dev` down with it.
    expect(root.scripts['dev']).toContain('--filter "./apps/**"');
    expect(root.scripts['dev']).toContain('--filter "!@kf/attestor"');
  });

  it('`pnpm dogfood:logins` creates the two logins as the loader does, NODE_ENV=development', () => {
    expect(root.scripts['dogfood:logins']).toContain(
      'NODE_ENV=development pnpm --filter @kf/api dogfood:logins',
    );
  });

  it('`pnpm dev:dogfood` builds the attestor and runs the ordered starter', () => {
    expect(root.scripts['dev:dogfood']).toMatch(/--filter @kf\/attestor\.\.\. build/);
    expect(root.scripts['dev:dogfood']).toMatch(/node scripts\/dev-dogfood\.mjs$/);
  });
});
