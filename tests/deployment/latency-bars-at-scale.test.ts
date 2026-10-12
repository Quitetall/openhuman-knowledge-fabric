/**
 * ADR 0024's object-view bar at the size of an organization (KF-SAS-RQ-201; SAS §100.42, §100.43).
 *
 * `latency-bars.test.ts` proves the harness can fail, on the harness fixtures' handful of records.
 * The costs SAS §100.42 and §100.43 name only appear at the size of a real organization: on the
 * 50 000-record multi-company fixture a view after any write in the organization recounted the
 * reader's whole corpus. This file measures the reads over a synthetic corpus of KF_LATENCY_CORPUS
 * records generated in this run's own throwaway database — never a live stack — through the
 * production API composition (`buildApp`, its own pool and statement timeout) and the harness's
 * own `measureViewAfterWrite`:
 *
 *   - a reader of the organization's public records compiles their master record (through the
 *     dispatcher, on a pool without the API's statement timeout: the compile is not a bar, and at
 *     this size on a loaded host it does not fit in one), and is timed reading an object view;
 *   - the view bar after another person's write the reader cannot see (`measureViewAfterWrite`);
 *   - the other master-record reads after such a write, timed and reported (not barred): the
 *     master document, the dashboard, a whole-corpus projection, the master-sections projection
 *     and the full record;
 *   - a view after a write that DID move the reader's corpus, which must answer 409.
 *
 * Skipped unless KF_LATENCY_CORPUS is set. KF_LATENCY_OUT names a JSON file for the figures, with
 * the load average beside every one, since the host is shared. Every answer is recorded with its
 * status and time, a refusal by the API's statement timeout included.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryObjectStore } from '@kf/artifacts';
import { createPool, registerAttestationIssuer, withTransaction, type Pool } from '@kf/database';
import { createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { buildApp } from '../../apps/api/src/app.js';
import {
  bindContext,
  populateSyntheticCorpus,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';
import { enrolPerson } from '../database/people.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ARTIFACT = join(ROOT, 'generated', 'projections', 'knowledge-fabric.projections.json');
const RECORDS = Number(process.env['KF_LATENCY_CORPUS'] ?? '0');
const SAMPLES = Number(process.env['KF_LATENCY_SAMPLES'] ?? '7');
const HOUR = 3_600_000;

interface Verdict {
  readonly id: string;
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly failures: readonly string[];
  readonly exceeded: boolean;
}
interface Harnessed {
  measureViewAfterWrite(options: {
    origin: string;
    samples?: number;
    afterWrite: {
      anchor: string;
      writerHeaders: Record<string, string>;
      readerHeaders: Record<string, string>;
    };
  }): Promise<{ bar: Verdict; refreshMs: number }>;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : sorted[Math.floor((sorted.length - 1) / 2)]!;
};

describe.skipIf(!(RECORDS > 0))('the object-view bar at the size of an organization', () => {
  let h: Harness;
  let f: Fixtures;
  let unbounded: Pool | undefined;
  let app: FastifyInstance;
  let origin: string;
  let anchor: string;
  let reader: { readonly personId: string; readonly roleId: string };
  const figures: Record<string, unknown> = {};

  beforeAll(async () => {
    h = await startHarness();
    f = await seedFixtures(h.adminPool);
    const started = performance.now();
    const corpus = await populateSyntheticCorpus(h.adminPool, f, {
      records: RECORDS,
      classification: 'public',
      createdBy: f.reviewerId,
    });
    anchor = corpus.decisionIds[5]!;
    // A reader of the organization's public records: an assignment over the organization whose
    // ceiling is `public`. The performer's notes are `internal`, so they never reach this reader's
    // corpus — every write the performer makes is one this reader's claim does not depend on,
    // which is exactly the write SAS §100.42 made everybody recount for.
    const enrolled = await enrolPerson(h.adminPool, f, {
      name: 'Public Reader',
      assignments: [{ role: 'performer', classificationCeiling: 'public' }],
    });
    reader = { personId: enrolled.personId, roleId: enrolled.assignmentIds[0]! };
    await withTransaction(h.adminPool, (tx) => tx.query('analyze'));
    figures['corpus'] = {
      records: RECORDS,
      generatedMs: performance.now() - started,
      loadAverage: loadavg(),
    };
    unbounded = createPool({
      connectionString: h.developmentDatabaseUrl,
      statementTimeoutMillis: 0,
    });
    registerAttestationIssuer(unbounded, h.attest);
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
  }, HOUR);

  // Written after every test, so a later failure — a statement refused, a connection lost while
  // the process was busy digesting a corpus — never takes the figures already taken with it.
  const flush = () => {
    const out = process.env['KF_LATENCY_OUT'];
    if (out !== undefined && out !== '')
      writeFileSync(out, `${JSON.stringify(figures, null, 2)}\n`);
  };
  afterEach(flush);

  afterAll(async () => {
    flush();
    await app?.close();
    if (unbounded !== undefined) {
      registerAttestationIssuer(unbounded, undefined);
      await unbounded.end();
    }
    await h?.stop();
  }, HOUR);

  const readerHeaders = () => ({
    'x-kf-actor': reader.personId,
    'x-kf-organization': f.organizationId,
    'x-kf-acting-role': reader.roleId,
    'x-kf-classification': 'restricted',
  });
  const performer = () => ({
    'x-kf-actor': f.performerId,
    'x-kf-organization': f.organizationId,
    'x-kf-acting-role': f.performerRoleId,
    'x-kf-classification': 'restricted',
  });

  const timed = async (
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<{ status: number; ms: number; bytes: number; load: number }> => {
    const startedAt = performance.now();
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = (await response.arrayBuffer()).byteLength;
    return {
      status: response.status,
      ms: performance.now() - startedAt,
      bytes,
      load: loadavg()[0]!,
    };
  };
  const summary = (samples: readonly { status: number; ms: number; load: number }[]) => ({
    statuses: [...new Set(samples.map((s) => s.status))],
    medianMs: median(samples.map((s) => s.ms)),
    ms: samples.map((s) => Math.round(s.ms)),
    load: samples.map((s) => s.load),
  });
  const note = (i: string) =>
    timed('POST', '/capture/observation', performer(), { body: `at-scale note ${i}` });

  it(
    'compiles the reader’s record, and times the view with nothing written since',
    async () => {
      const started = performance.now();
      const compiled = await createFabricDispatcher(
        unbounded!,
        createDocumentActionAtoms({
          store: new InMemoryObjectStore(),
          parser: {
            async parse() {
              return undefined;
            },
          },
        }),
      )({
        actionType: 'compile_master_record',
        actorId: reader.personId,
        actingRoleId: reader.roleId,
        targetIds: [reader.personId],
        organizationId: f.organizationId,
        maxClassification: 'restricted',
        idempotencyKey: `at-scale-${randomUUID()}`,
      });
      figures['compile'] = { ms: performance.now() - started, load: loadavg()[0] };
      expect(compiled.status).toBe('applied');
      await timed('GET', `/objects/${anchor}`, readerHeaders());
      const samples = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        samples.push(await timed('GET', `/objects/${anchor}`, readerHeaders()));
      }
      figures['viewNothingWritten'] = summary(samples);
      expect(samples.every((s) => s.status === 200)).toBe(true);
    },
    HOUR,
  );

  it(
    'measures the view bar after another person wrote',
    async () => {
      const bars = (await import(
        pathToFileURL(join(ROOT, 'scripts', 'latency-bars.mjs')).href
      )) as Harnessed;
      const report = await bars.measureViewAfterWrite({
        origin,
        samples: SAMPLES,
        afterWrite: { anchor, writerHeaders: performer(), readerHeaders: readerHeaders() },
      });
      figures['viewAfterWrite'] = { ...report.bar, refreshMs: report.refreshMs, load: loadavg() };
      // Recorded whatever it says: the comparison is the report's, not this assertion's.
      expect(report.bar.id).toBe('view-after-write');
    },
    HOUR,
  );

  it(
    'times the other master-record reads after another person wrote',
    async () => {
      const reads: Record<string, unknown> = {};
      const paths: readonly (readonly [string, string, number])[] = [
        ['masterDocument', '/master-document', SAMPLES],
        ['dashboard', '/dashboard', SAMPLES],
        [
          'agentContextProjection',
          '/master-record/projections/agent_context?token_budget=8000',
          SAMPLES,
        ],
        ['masterSectionsProjection', '/master-record/projections/master_sections', 1],
        ['fullRecord', '/master-record', 1],
      ];
      for (const [name, path, count] of paths) {
        const samples = [];
        for (let i = 0; i < count; i += 1) {
          const written = await note(`${name}-${String(i)}`);
          samples.push({ ...(await timed('GET', path, readerHeaders())), written: written.status });
        }
        reads[name] = {
          path,
          bytes: samples[0]?.bytes,
          writes: samples.map((s) => s.written),
          ...summary(samples),
        };
      }
      figures['reads'] = reads;
    },
    HOUR,
  );

  it(
    'answers 409 after a write that moved the reader’s corpus, and says how long it took',
    async () => {
      const samples = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        // A public record, written by a bound person in the organization: the reader may read it,
        // so their corpus has moved and their claim is stale.
        await withTransaction(h.pool, async (tx) => {
          await bindContext(tx, f, f.performerId);
          await tx.query(
            `insert into core.object
               (object_type, authority_domain, lifecycle_state, classification, retention_class,
                schema_version, organization_id, title, created_by, updated_by)
             values ('decision_record', 'engineering', 'draft', 'public', 'project_record',
                     $1, $2, $3, $4, $4)`,
            [f.schemaVersion, f.organizationId, `moved ${String(i)}`, f.performerId],
          );
        });
        samples.push(await timed('GET', `/objects/${anchor}`, readerHeaders()));
      }
      figures['staleView'] = summary(samples);
    },
    HOUR,
  );
});
