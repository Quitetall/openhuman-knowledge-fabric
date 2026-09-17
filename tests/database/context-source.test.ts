import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withReadTransaction, withTransaction } from '@kf/database';
import { digestBytes } from '@kf/canonicalization';
import { contextSourceReferencesIn, readContextSourceIn } from '@kf/documents';
import Fastify from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { linkIdentity, revokeIdentity, TokenVerifier } from '@kf/authorization';
import { registerContextSourceRoutes } from '../../apps/api/src/routes/context-source.js';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

let harness: Harness;
let fixtures: Fixtures;
beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);
afterAll(async () => {
  await harness?.stop();
});

const reader = () => ({
  actorId: fixtures.reviewerId,
  actingRoleId: fixtures.reviewerRoleId,
  organizationId: fixtures.organizationId,
  maxClassification: 'restricted',
});

describe('context source with real database authority', () => {
  it('aborts an active read, discards its connection and leaves the pool usable', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = withReadTransaction(harness.pool, controller.signal, async (tx) => {
      started();
      await tx.query('select pg_sleep(30) /* context_source_cancel_probe */');
      throw new Error('cancelled work continued');
    });
    const refused = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await entered;
    let running = false;
    for (let attempt = 0; attempt < 100 && !running; attempt += 1) {
      const observed = await withTransaction(harness.adminPool, (tx) =>
        tx.one<{ running: boolean }>(
          `select exists(select 1 from pg_stat_activity
          where query = 'select pg_sleep(30) /* context_source_cancel_probe */'
            and state = 'active' and wait_event = 'PgSleep') as running`,
        ),
      );
      running = observed.running;
      if (!running) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const start = performance.now();
    controller.abort();
    await refused;
    expect(running).toBe(true);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(await withTransaction(harness.pool, (tx) => tx.one('select 1 as ok'))).toEqual({
      ok: 1,
    });
  });

  it('does not start already cancelled read work', async () => {
    const controller = new AbortController();
    controller.abort();
    let entered = false;
    await expect(
      withReadTransaction(harness.pool, controller.signal, async () => {
        entered = true;
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(entered).toBe(false);
  });

  it('serves signed-token retrieval/read and refuses both after identity revocation', async () => {
    const issuer = 'https://context-source.invalid';
    const pair = await generateKeyPair('RS256', { extractable: true });
    const key = { ...(await exportJWK(pair.publicKey)), kid: 'context-test', alg: 'RS256' };
    const verifier = new TokenVerifier(
      { issuer, audience: 'kf', jwksUri: `${issuer}/keys` },
      createLocalJWKSet({ keys: [key] }),
    );
    const identity = await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures);
      return linkIdentity(tx, {
        issuer,
        subject: 'reader',
        personId: fixtures.reviewerId,
        providerLabel: 'Context test reader',
        linkedBy: fixtures.performerId,
      });
    });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'context-test' })
      .setIssuer(issuer)
      .setAudience('kf')
      .setSubject('reader')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
    const [reference] = await withTransaction(harness.pool, (tx) =>
      contextSourceReferencesIn(tx, reader(), [fixtures.organizationId]),
    );
    if (reference === undefined) throw new Error('expected authorized fixture');
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures);
      await tx.query('select search.index_object($1)', [fixtures.organizationId]);
    });
    const app = Fastify();
    await registerContextSourceRoutes(app, { pool: harness.pool, verifier });
    const request = {
      method: 'POST' as const,
      url: '/context-source/read',
      remoteAddress: '127.0.0.1',
      payload: reference,
      headers: {
        authorization: `Bearer ${token}`,
        'x-kf-actor': fixtures.performerId,
        'x-kf-acting-role': fixtures.reviewerRoleId,
        'x-kf-organization': fixtures.organizationId,
        'x-kf-classification': 'restricted',
      },
    };
    try {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const send = (input: { url: string; payload: unknown }) =>
        fetch(`${base}${input.url}`, {
          method: 'POST',
          headers: { ...request.headers, 'content-type': 'application/json' },
          body: JSON.stringify(input.payload),
          signal: AbortSignal.timeout(5000),
        });
      const response = await send(request);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ source: reference });
      const retrieval = {
        ...request,
        url: '/context-source/retrieve',
        payload: { query: 'OpenHuman', limit: 10 },
      };
      const found = await send(retrieval);
      expect(found.status).toBe(200);
      expect(await found.json()).toMatchObject({ references: expect.arrayContaining([reference]) });
      const blocker = await harness.adminPool.connect();
      const cancelledClient = new AbortController();
      let discarded = false;
      const removed = () => {
        discarded = true;
      };
      harness.pool.on('remove', removed);
      try {
        await blocker.query('begin');
        await blocker.query('lock table search.document in access exclusive mode');
        const pending = fetch(`${base}${retrieval.url}`, {
          method: 'POST',
          headers: { ...request.headers, 'content-type': 'application/json' },
          body: JSON.stringify(retrieval.payload),
          signal: cancelledClient.signal,
        });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
          const result = await withTransaction(harness.adminPool, (tx) =>
            tx.one<{ waiting: boolean }>(
              `select exists(select 1 from pg_stat_activity
              where state = 'active' and wait_event_type = 'Lock'
                and query like 'with visible as%') as waiting`,
            ),
          );
          waiting = result.waiting;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        cancelledClient.abort();
        await rejected;
        for (let attempt = 0; attempt < 100 && !discarded; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        expect(discarded).toBe(true);
      } finally {
        cancelledClient.abort();
        harness.pool.removeListener('remove', removed);
        await blocker.query('rollback');
        blocker.release();
      }
      const recovered = await send(retrieval);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        references: expect.arrayContaining([reference]),
      });
      await withTransaction(harness.adminPool, async (tx) => {
        await bindContext(tx, fixtures);
        await revokeIdentity(tx, identity);
      });
      const revokedRead = await send(request);
      expect(revokedRead.status).toBe(401);
      await revokedRead.arrayBuffer();
      const revokedRetrieval = await send(retrieval);
      expect(revokedRetrieval.status).toBe(401);
      await revokedRetrieval.arrayBuffer();
    } finally {
      await app.close();
    }
  });

  it('reads through the application role and rejects a changed revision', async () => {
    const id = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Context source revision probe',
      createdBy: fixtures.reviewerId,
    });
    const [reference] = await withTransaction(harness.pool, (tx) =>
      contextSourceReferencesIn(tx, reader(), [id]),
    );
    expect(reference?.record).toBe(id);
    if (reference === undefined) throw new Error('expected authorized fixture');
    const result = await withTransaction(harness.pool, (tx) =>
      readContextSourceIn(tx, reader(), reference),
    );
    expect(result?.source).toEqual(reference);
    if (result === undefined) throw new Error('expected source record');
    expect(digestBytes(Buffer.from(result.text, 'utf8'))).toBe(reference.digest);
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, fixtures);
      await tx.query(
        'update core.object set title = $2, row_version = row_version + 1 where id = $1',
        [id, 'Changed context source revision'],
      );
    });
    await expect(
      withTransaction(harness.pool, (tx) => readContextSourceIn(tx, reader(), reference)),
    ).rejects.toMatchObject({ reason: 'revision_mismatch' });
  });

  it('refuses a caller paired with another organization', async () => {
    const foreign = await seedFixtures(harness.adminPool);
    await expect(
      withTransaction(harness.pool, (tx) =>
        contextSourceReferencesIn(tx, { ...reader(), organizationId: foreign.organizationId }, [
          foreign.organizationId,
        ]),
      ),
    ).rejects.toThrow();
  });

  it('rechecks current clearance before replaying a previously readable reference', async () => {
    const isolated = await seedFixtures(harness.adminPool);
    const subject = {
      actorId: isolated.reviewerId,
      actingRoleId: isolated.reviewerRoleId,
      organizationId: isolated.organizationId,
      maxClassification: 'restricted',
    };
    const [reference] = await withTransaction(harness.pool, (tx) =>
      contextSourceReferencesIn(tx, subject, [isolated.organizationId]),
    );
    if (reference === undefined) throw new Error('expected authorized fixture');
    expect(
      await withTransaction(harness.pool, (tx) => readContextSourceIn(tx, subject, reference)),
    ).toBeDefined();
    await withTransaction(harness.adminPool, async (tx) => {
      await bindContext(tx, isolated);
      await tx.query(
        `insert into org.person_clearance_retirement
        (clearance_id, retired_by, retirement_reason, retired_by_action)
        select id, $1, 'Context source revocation fixture', granted_by_action
          from org.person_clearance where subject_id = $1 and organization_id = $2`,
        [isolated.reviewerId, isolated.organizationId],
      );
    });
    await expect(
      withTransaction(harness.pool, (tx) => readContextSourceIn(tx, subject, reference)),
    ).rejects.toThrow();
    await expect(
      withTransaction(harness.pool, (tx) =>
        contextSourceReferencesIn(tx, subject, [isolated.organizationId]),
      ),
    ).rejects.toThrow();
  });
});
