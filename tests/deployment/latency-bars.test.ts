/**
 * The latency harness can fail (KF-SAS-RQ-201, ADR 0024, SAS §100.18).
 *
 * A bar nobody measures is prose, and a harness that cannot report a breach is the same prose with
 * a script attached. So this proves both directions:
 *
 *   - against a scripted API on a virtual clock, deterministically: within every bar it passes,
 *     and a delay on one path exceeds exactly that bar — including a delay just past the bar, and
 *     a failed sample however fast the rest were;
 *   - against the real stack — the API process listening on a port, a real database, the worker's
 *     outbox drain running beside it — it measures all three bars from real requests, and a real
 *     600 ms delay put in the act's path makes the act bar exceed.
 *
 * With KF_LATENCY_RECORD=1 the real run also writes its dated section to generated/latency-bars.md,
 * labelled as workstation numbers. That is how the committed section was produced; ordinary runs
 * leave the file alone.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { buildApp } from '../../apps/api/src/app.js';
import { drainOutbox } from '../../apps/worker/src/outbox.js';
import { seedFixtures, startHarness, type Fixtures, type Harness } from '../database/harness.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ARTIFACT = join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json');

interface BarVerdict {
  readonly id: 'act' | 'search' | 'view';
  readonly limitMs: number;
  readonly adr: string;
  readonly samples: number;
  readonly p95: number;
  readonly max: number;
  readonly failures: readonly string[];
  readonly exceeded: boolean;
}
interface Report {
  readonly bars: readonly BarVerdict[];
  readonly exceeded: readonly string[];
}
interface Harnessed {
  readonly BARS: readonly { id: string; limitMs: number; adr: string }[];
  measureLatencyBars(options: {
    origin: string;
    headers: Record<string, string>;
    samples?: number;
    fetchImpl?: typeof fetch;
    clock?: () => number;
    indexTimeoutMs?: number;
  }): Promise<Report>;
  renderSection(report: Report, provenance: Record<string, string>): string;
  writeReport(root: string, report: Report, provenance: Record<string, string>): string;
  defaultProvenance(root: string, target: string): Record<string, string>;
}

let bars: Harnessed;

beforeAll(async () => {
  bars = (await import(pathToFileURL(join(ROOT, 'scripts', 'latency-bars.mjs')).href)) as Harnessed;
});

describe('the bars are ADR 0024’s, exactly', () => {
  it('states the three measured bars as the ADR does', () => {
    expect(bars.BARS.map((b) => [b.id, b.limitMs, b.adr])).toEqual([
      ['act', 500, 'under 500 ms at the API'],
      ['search', 2000, 'first useful result under 2 seconds'],
      ['view', 1000, 'under 1 second'],
    ]);
  });
});

/**
 * A scripted API on a virtual clock. Each path costs what `costs` says, in virtual
 * milliseconds; nothing sleeps, so the verdicts are exact.
 */
function scripted(costs: { capture: number; search: number; view: number }, failView = false) {
  let now = 0;
  let n = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.pathname === '/capture/observation') {
      now += costs.capture;
      n += 1;
      return new Response(
        JSON.stringify({ observationId: `obs-${String(n)}`, actingRoleId: 'role-1' }),
        { status: 201 },
      );
    }
    if (url.pathname === '/search') {
      now += costs.search;
      return new Response(JSON.stringify({ hits: [{ objectId: 'obs-1' }] }), { status: 200 });
    }
    if (method === 'POST' && url.pathname.endsWith('/refresh')) {
      now += 50;
      return new Response('{}', { status: 200 });
    }
    now += costs.view;
    return new Response('{}', { status: failView ? 500 : 200 });
  }) as typeof fetch;
  return { fetchImpl, clock: () => now };
}

const run = (s: ReturnType<typeof scripted>) =>
  bars.measureLatencyBars({ origin: 'http://api.test', headers: {}, samples: 10, ...s });

describe('the verdict, on a virtual clock', () => {
  it('passes when every path is inside its bar', async () => {
    const report = await run(scripted({ capture: 120, search: 300, view: 200 }));
    expect(report.exceeded).toEqual([]);
    expect(report.bars.map((b) => [b.id, b.samples, b.p95])).toEqual([
      ['act', 10, 120],
      ['search', 10, 300],
      ['view', 10, 200],
    ]);
  });

  it('fails the act bar, and only it, when a delay is put in the act’s path', async () => {
    const report = await run(scripted({ capture: 120 + 600, search: 300, view: 200 }));
    expect(report.exceeded).toEqual(['act']);
  });

  it('fails at the bar itself, not only above it: "under 500 ms" excludes 500', async () => {
    expect((await run(scripted({ capture: 499, search: 1999, view: 999 }))).exceeded).toEqual([]);
    expect((await run(scripted({ capture: 500, search: 2000, view: 1000 }))).exceeded).toEqual([
      'act',
      'search',
      'view',
    ]);
  });

  it('fails a bar whose samples failed, however fast they were', async () => {
    const report = await run(scripted({ capture: 10, search: 10, view: 10 }, true));
    expect(report.exceeded).toEqual(['view']);
    expect(report.bars[2]!.failures[0]).toMatch(/answered 500/);
  });
});

describe('against the real stack', () => {
  let h: Harness;
  let f: Fixtures;
  let app: FastifyInstance;
  let origin: string;
  let draining = true;
  let drainer: Promise<void>;

  beforeAll(async () => {
    h = await startHarness();
    f = await seedFixtures(h.adminPool);
    app = await buildApp(
      {
        host: '127.0.0.1',
        port: 0,
        logLevel: process.env['LOG_LEVEL'] ?? 'silent',
        databaseUrl: h.developmentDatabaseUrl,
        environment: 'test',
        deploymentProfile: 'development',
        tlsTerminatedUpstream: false,
        identity: undefined,
        projectionsArtifact: ARTIFACT,
      },
      { objectStore: new InMemoryObjectStore() },
    );
    origin = await app.listen({ host: '127.0.0.1', port: 0 });
    // The worker's job, beside the API as on a host: search is fed by the outbox.
    drainer = (async () => {
      while (draining) {
        await drainOutbox(h.adminPool).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
  }, 180_000);

  afterAll(async () => {
    draining = false;
    await drainer;
    await app?.close();
    await h?.stop();
  });

  /** The reviewer, with NO acting role: the capture route forms it, as for any person. */
  const headers = () => ({
    'x-kf-actor': f.reviewerId,
    'x-kf-organization': f.organizationId,
    'x-kf-classification': 'restricted',
  });

  it('measures all three bars from real requests', async () => {
    const report = await bars.measureLatencyBars({ origin, headers: headers(), samples: 10 });
    for (const bar of report.bars) {
      expect(bar.failures, bar.id).toEqual([]);
      expect(bar.samples, bar.id).toBe(10);
      expect(bar.p95, bar.id).toBeGreaterThan(0);
      // The verdict is the numbers', whatever this machine's load made them.
      expect(bar.exceeded, bar.id).toBe(!(bar.p95 < bar.limitMs));
    }
    if (process.env['KF_LATENCY_RECORD'] === '1') {
      bars.writeReport(ROOT, report, {
        ...bars.defaultProvenance(ROOT, 'in-process test harness'),
        target:
          'in-process: API on 127.0.0.1 in the test process, Testcontainers PostgreSQL 18, ' +
          'outbox drained every 50 ms (tests/deployment/latency-bars.test.ts)',
      });
    }
  }, 120_000);

  it('exceeds the act bar when a real delay is put in the act’s path', async () => {
    const delayed = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/capture/observation')) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return fetch(input, init);
    }) as typeof fetch;
    const report = await bars.measureLatencyBars({
      origin,
      headers: headers(),
      samples: 3,
      fetchImpl: delayed,
    });
    expect(report.exceeded).toContain('act');
    expect(report.bars[0]!.p95).toBeGreaterThanOrEqual(600);
  }, 120_000);
});
