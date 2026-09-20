import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import { createDocumentActionAtoms } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * `verify_record` (KF-SAS-RQ-227, RQ-231).
 *
 * One act, one record. A gesture may dispatch five hundred of these; it may not dispatch one
 * covering five hundred, because that is the container decision RQ-021 forbids arriving by
 * another route, and the ledger would carry one entry where five hundred judgements were made.
 */
describe('verifying a record is an act, one record at a time', () => {
  let harness: Harness;
  let f: Fixtures;

  beforeAll(async () => {
    harness = await startHarness();
    f = await seedFixtures(harness.adminPool);
  }, 240_000);

  afterAll(async () => {
    await harness?.stop();
  });

  const dispatcher = () =>
    createFabricDispatcher(
      harness.pool,
      createDocumentActionAtoms({
        store: new InMemoryObjectStore(),
        parser: {
          async parse() {
            return undefined;
          },
        },
      }),
    );

  async function record(title: string): Promise<string> {
    return createObject(harness.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title,
      createdBy: f.performerId,
    });
  }

  const verify = (
    targets: readonly string[],
    payload: Readonly<Record<string, string>>,
    reason = 'read it',
  ) =>
    dispatcher()({
      actionType: 'verify_record',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [...targets],
      organizationId: f.organizationId,
      maxClassification: 'restricted',
      idempotencyKey: `verify-${randomUUID()}`,
      reason,
      payload,
    });

  async function basisOf(objectId: string): Promise<string | undefined> {
    return withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      const rows = await tx.query<{ basis: string }>(
        'select basis from core.object_verification where object_id = $1',
        [objectId],
      );
      return rows[0]?.basis;
    });
  }

  it('records the basis the act stated', async () => {
    const target = await record('Reviewed line by line');
    const outcome = await verify([target], { basis: 'reviewed_individually' });
    expect(outcome.status, JSON.stringify(outcome)).toBe('applied');
    expect(await basisOf(target)).toBe('reviewed_individually');
  });

  it('records a bulk promotion as a bulk promotion, not as review', async () => {
    const target = await record('Swept in with four hundred others');
    expect((await verify([target], { basis: 'promoted_in_bulk' })).status).toBe('applied');
    expect(
      await basisOf(target),
      'an auditor asking whether a person looked at this record must get a true answer',
    ).toBe('promoted_in_bulk');
  });

  it('refuses one act covering several records', async () => {
    const [a, b] = [await record('First'), await record('Second')];
    // Preconditions throw rather than returning a status; the dispatcher's contract is that a
    // refusal is an exception carrying a named code, never a value a caller can ignore.
    await expect(verify([a, b], { basis: 'promoted_in_bulk' })).rejects.toThrow(/KF-SAS-RQ-227/);
    expect(await basisOf(a), 'a refused act writes nothing').toBeUndefined();
    expect(await basisOf(b)).toBeUndefined();
  });

  it('refuses a basis outside the vocabulary', async () => {
    const target = await record('Looked alright');
    await expect(verify([target], { basis: 'looked_alright' })).rejects.toThrow(
      /basis must be one of/,
    );
    expect(await basisOf(target)).toBeUndefined();
  });

  it('refuses a verification with no reason', async () => {
    const target = await record('No reason given');
    await expect(verify([target], { basis: 'reviewed_individually' }, '  ')).rejects.toThrow(
      /reason/,
    );
    expect(await basisOf(target)).toBeUndefined();
  });

  it('refuses a second verification rather than silently replacing the first', async () => {
    const target = await record('Checked once');
    expect((await verify([target], { basis: 'reviewed_individually' })).status).toBe('applied');
    await expect(verify([target], { basis: 'promoted_in_bulk' })).rejects.toThrow(
      /already verified/,
    );
    expect(
      await basisOf(target),
      'a second verification is a different claim by a different person; overwriting would lose ' +
        'the first one silently',
    ).toBe('reviewed_individually');
  });

  it('names the act that recorded it', async () => {
    const target = await record('Traceable');
    await verify([target], { basis: 'reviewed_individually' });
    const row = await withTransaction(harness.pool, async (tx) => {
      await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
      const rows = await tx.query<{ action_type: string; verified_by: string }>(
        `select a.action_type, v.verified_by
           from core.object_verification v
           join core.action a on a.id = v.recorded_by_action
          where v.object_id = $1`,
        [target],
      );
      return rows[0];
    });
    expect(row?.action_type).toBe('verify_record');
    expect(row?.verified_by).toBe(f.reviewerId);
  });
});
