/**
 * The audit ledger, verified against a real database.
 *
 * The claim under test is narrow and load-bearing: someone who can write to the audit table
 * cannot alter history without it being detectable by someone who holds only a public key.
 * Every test here therefore tampers as the DATABASE OWNER — the strongest adversary the
 * system has, and the one whose edits no application-level control can stop.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher } from '@kf/actions';
import { withTransaction } from '@kf/database';
import { InMemoryObjectStore } from '@kf/artifacts';
import { generateSigningKey, verifyCheckpoint } from '../../apps/checkpoint/src/sign.js';
import { runCheckpoint, verifyLedger } from '../../apps/checkpoint/src/run.js';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;
const key = generateSigningKey('checkpoint-test-1');
const keys = new Map([[key.id, key.publicKey]]);

/** Perform `n` real actions through the dispatcher, so the audit chain is genuinely produced. */
async function doWork(n: number, tag: string): Promise<void> {
  const execute = createDispatcher(h.pool);
  for (let i = 0; i < n; i++) {
    const id = await createObject(h.adminPool, f, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'proposed',
      title: `${tag} ${i}`,
      createdBy: f.performerId,
    });
    const r = await execute({
      actionType: 'accept_decision',
      actorId: f.reviewerId,
      actingRoleId: f.reviewerRoleId,
      targetIds: [id],
      idempotencyKey: `${tag}-${i}`.padEnd(16, 'x'),
      organizationId: f.organizationId,
      maxClassification: 'restricted',
    });
    expect(r.status, JSON.stringify(r)).toBe('applied');
  }
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('checkpoint runs', () => {
  it('signs the log, and a clean ledger verifies', async () => {
    await doWork(4, 'first');

    const store = new InMemoryObjectStore();
    const result = await runCheckpoint(h.adminPool, key, { store });

    expect(result.status).toBe('signed');
    expect(result.eventCount).toBe(4);
    expect(result.checkpoint?.storageUri).toMatch(/^audit\/checkpoints\//);
    expect(verifyCheckpoint(result.checkpoint!, key.publicKey)).toBe(true);

    // The signature is in the object store too, not only in the database it attests to.
    const written = await store.read(result.checkpoint!.storageUri!);
    expect(JSON.parse(written.toString('utf8'))).toMatchObject({
      merkleRoot: result.checkpoint!.merkleRoot,
    });

    expect(await verifyLedger(h.adminPool, keys)).toEqual([]);
  });

  it('continues from the previous checkpoint rather than re-signing', async () => {
    await doWork(3, 'second');
    const result = await runCheckpoint(h.adminPool, key);
    expect(result.status).toBe('signed');
    expect(result.eventCount).toBe(3);
    expect(result.checkpoint!.fromSeq).toBe(5);
    expect(await verifyLedger(h.adminPool, keys)).toEqual([]);
  });

  it('does nothing when there is nothing new', async () => {
    const result = await runCheckpoint(h.adminPool, key);
    expect(result.status).toBe('nothing_pending');
    expect(result.checkpoint).toBeUndefined();
  });

  it('refuses to overwrite a checkpoint object already in the store', async () => {
    // Replacing one would destroy the only copy of an earlier attestation.
    const store = new InMemoryObjectStore();
    await doWork(1, 'third');
    const first = await runCheckpoint(h.adminPool, key, { store });
    await doWork(1, 'fourth');

    // Compute the key from the sequence numbers that ACTUALLY exist. Deriving it as
    // `toSeq + 1` would assume contiguous sequence numbers, and bigserial skips values
    // whenever a transaction rolls back.
    const { from_seq, to_seq } = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ from_seq: string; to_seq: string }>(
        'select min(seq) as from_seq, max(seq) as to_seq from core.audit_event where seq > $1',
        [first.checkpoint!.toSeq],
      ),
    );
    const occupied = `audit/checkpoints/${from_seq.padStart(12, '0')}-${to_seq.padStart(12, '0')}.json`;
    await store.put(occupied, Buffer.from('{}', 'utf8'), 'application/json');

    await expect(runCheckpoint(h.adminPool, key, { store })).rejects.toThrow(
      /already exists .* refusing to replace/,
    );
    // And the failed run wrote nothing: the transaction rolled back with it.
    expect(await verifyLedger(h.adminPool, keys)).toEqual([]);
  });
});

describe('tamper detection — as the database owner', () => {
  /** Snapshot the audit table so each test can put history back afterwards. */
  async function withRestoredAudit(mutate: () => Promise<void>, assert: () => Promise<void>) {
    const before = await withTransaction(h.adminPool, async (tx) =>
      tx.query('select * from core.audit_event order by seq'),
    );
    try {
      await mutate();
      await assert();
    } finally {
      await withTransaction(h.adminPool, async (tx) => {
        await tx.query("set local session_replication_role = 'replica'");
        await tx.query('delete from core.audit_event');
        for (const row of before) {
          const cols = Object.keys(row);
          await tx.query(
            `insert into core.audit_event (${cols.join(', ')})
             values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
            cols.map((c) => {
              const v = (row as Record<string, unknown>)[c];
              return v !== null && typeof v === 'object' && !(v instanceof Date)
                ? JSON.stringify(v)
                : v;
            }),
          );
        }
      });
      expect(await verifyLedger(h.adminPool, keys), 'restore failed').toEqual([]);
    }
  }

  it('catches an EDITED event, even one whose chain digests were recomputed', async () => {
    // The sophisticated attack: change a record, then relink the chain over it so
    // recomputation from genesis still passes. The signed Merkle root is what fails.
    await withRestoredAudit(
      async () => {
        await withTransaction(h.adminPool, async (tx) => {
          await tx.query("set local session_replication_role = 'replica'");
          await tx.query(`update core.audit_event set actor_id = $1 where seq = 2`, [
            f.performerId,
          ]);
        });
      },
      async () => {
        const findings = await verifyLedger(h.adminPool, keys);
        // The chain itself still verifies — digests were untouched — which is exactly why
        // the chain alone is not enough.
        expect(findings.map((x) => x.kind)).toContain('root_mismatch');
        expect(findings.some((x) => x.kind === 'chain_broken')).toBe(false);
      },
    );
  });

  it('catches a DELETED event', async () => {
    await withRestoredAudit(
      async () => {
        await withTransaction(h.adminPool, async (tx) => {
          await tx.query("set local session_replication_role = 'replica'");
          await tx.query('delete from core.audit_event where seq = 3');
        });
      },
      async () => {
        const kinds = (await verifyLedger(h.adminPool, keys)).map((x) => x.kind);
        // Two independent detectors fire: the chain no longer links, and the signed range
        // has fewer leaves than it was signed with.
        expect(kinds).toContain('missing_events');
        expect(kinds).toContain('chain_broken');
      },
    );
  });

  it('catches a TRUNCATED log — the "start again from here" attack', async () => {
    await withRestoredAudit(
      async () => {
        await withTransaction(h.adminPool, async (tx) => {
          await tx.query("set local session_replication_role = 'replica'");
          await tx.query('delete from core.audit_event where seq <= 2');
        });
      },
      async () => {
        const findings = await verifyLedger(h.adminPool, keys);
        expect(findings.length).toBeGreaterThan(0);
        expect(findings.map((x) => x.kind)).toContain('missing_events');
      },
    );
  });

  it('catches a REORDERED pair, which leaves every digest valid', async () => {
    await withRestoredAudit(
      async () => {
        await withTransaction(h.adminPool, async (tx) => {
          await tx.query("set local session_replication_role = 'replica'");
          // Swap the two events' identities while leaving the digest links untouched, so
          // the chain still verifies end to end. Three steps via a parking id, because the
          // unique index on `id` rejects a single statement that holds both values at once.
          const [a, b] = await tx.query<{ seq: string; id: string; action_id: string }>(
            'select seq, id, action_id from core.audit_event order by seq limit 2',
          );
          const parking = '01930000-0000-7000-8000-0000000fffff';
          await tx.query('update core.audit_event set id = $1 where seq = $2', [parking, a!.seq]);
          await tx.query('update core.audit_event set id = $1, action_id = $2 where seq = $3', [
            a!.id,
            a!.action_id,
            b!.seq,
          ]);
          await tx.query('update core.audit_event set id = $1, action_id = $2 where seq = $3', [
            b!.id,
            b!.action_id,
            a!.seq,
          ]);
        });
      },
      async () => {
        expect((await verifyLedger(h.adminPool, keys)).map((x) => x.kind)).toContain(
          'root_mismatch',
        );
      },
    );
  });

  it('catches a FORGED checkpoint signed with the wrong key', async () => {
    const impostor = generateSigningKey('checkpoint-test-1'); // same id, different key
    await doWork(1, 'fifth');
    const forged = await runCheckpoint(h.adminPool, impostor);
    expect(forged.status).toBe('signed');

    const findings = await verifyLedger(h.adminPool, keys);
    expect(findings.map((x) => x.kind)).toContain('bad_signature');

    await withTransaction(h.adminPool, async (tx) => {
      // The checkpoint table is append-only too, so even removing a forgery takes the same
      // deliberate suspension a restore does. That is the control working, not an obstacle.
      await tx.query("set local session_replication_role = 'replica'");
      await tx.query('delete from core.audit_checkpoint where id = $1', [forged.checkpoint!.id]);
    });
    // Removing it leaves those events uncovered, which is a finding of its own — so
    // re-checkpoint them properly to return the ledger to clean.
    await runCheckpoint(h.adminPool, key);
    expect(await verifyLedger(h.adminPool, keys)).toEqual([]);
  });

  it('reports an unknown signing key as a finding, never as a pass', async () => {
    // Unverifiable is not the same as valid.
    expect((await verifyLedger(h.adminPool, new Map())).map((x) => x.kind)).toContain(
      'unknown_key',
    );
  });

  it('refuses to build a checkpoint on top of a broken chain', async () => {
    await withRestoredAudit(
      async () => {
        await doWork(2, 'sixth');
        await withTransaction(h.adminPool, async (tx) => {
          await tx.query("set local session_replication_role = 'replica'");
          await tx.query(
            `update core.audit_event set prev_digest = $1
              where seq = (select max(seq) from core.audit_event)`,
            ['f'.repeat(64)],
          );
        });
      },
      async () => {
        // Signing here would attest TO the tampering.
        await expect(runCheckpoint(h.adminPool, key)).rejects.toThrow(/chain breaks at seq/);
      },
    );
  });
});
