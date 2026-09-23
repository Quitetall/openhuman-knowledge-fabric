import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from '@kf/database';
import { registerActionRoutes } from '../actions.js';
import { DEFAULT_EFFECTIVE_AT_BOUNDS, effectiveAtOutOfBounds } from './effective-at.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('effectiveAtOutOfBounds', () => {
  it('accepts now, a little clock skew ahead, and a recent past', () => {
    for (const at of [NOW, NOW + 60_000, NOW - 29 * DAY]) {
      expect(
        effectiveAtOutOfBounds(new Date(at), 'approve', DEFAULT_EFFECTIVE_AT_BOUNDS, NOW),
      ).toBeUndefined();
    }
  });

  it('refuses the future beyond skew, for every action type', () => {
    const bounds = { ...DEFAULT_EFFECTIVE_AT_BOUNDS, backdatableActions: new Set(['approve']) };
    expect(effectiveAtOutOfBounds(new Date(NOW + DAY), 'approve', bounds, NOW)).toMatch(/future/);
  });

  it('refuses backdating past the window unless the action type is listed', () => {
    const old = new Date(NOW - 400 * DAY);
    expect(effectiveAtOutOfBounds(old, 'approve', DEFAULT_EFFECTIVE_AT_BOUNDS, NOW)).toMatch(
      /more than 30 day/,
    );
    const listed = { ...DEFAULT_EFFECTIVE_AT_BOUNDS, backdatableActions: new Set(['approve']) };
    expect(effectiveAtOutOfBounds(old, 'approve', listed, NOW)).toBeUndefined();
  });
});

describe('POST /actions/:actionType effectiveAt bounds', () => {
  it('refuses an out-of-bounds effective time before dispatch', async () => {
    const execute = vi.fn();
    const app = Fastify({ logger: false });
    await registerActionRoutes(app, {
      pool: {} as Pool,
      execute,
      trustHeaders: true,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/actions/create_initiative',
      headers: {
        'x-kf-actor': '01930000-0000-7000-8000-000000000001',
        'x-kf-acting-role': '01930000-0000-7000-8000-000000000002',
        'x-kf-organization': '01930000-0000-7000-8000-000000000003',
      },
      payload: {
        idempotencyKey: 'effective-at-bounds-0001',
        // Canonical, so the format check passes; a year ahead, so only the bound refuses it.
        effectiveAt: new Date(Date.now() + 365 * DAY).toISOString(),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'effective_at_out_of_bounds' });
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });
});
