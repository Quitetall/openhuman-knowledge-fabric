import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditChainDigest, compareCanonicalText } from '@kf/canonicalization';
import { withTransaction, type Tx } from '@kf/database';
import {
  bindContext,
  bindReader,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';

/**
 * The red-team forgeries of 2026-09-23, each now a required refusal (threat model T2).
 *
 * Every one of these SUCCEEDED when run as `kf_app` before 20260923000100/0200: the context was
 * the application's to write, and the rows that record authority accepted whatever it wrote. The
 * tests run as the application role — `harness.pool` — because that is the adversary; the owner
 * would pass every one of them for the wrong reason.
 *
 * Each refusal is paired, where it can be, with the legitimate version of the same write
 * succeeding. A test that only ever sees refusals cannot tell a precise guard from a table that
 * refuses everything.
 */
describe('the database binds the principal, and writes match it', () => {
  let h: Harness;
  let f: Fixtures;
  let other: Fixtures;

  beforeAll(async () => {
    h = await startHarness();
    f = await seedFixtures(h.adminPool);
    // A second tenant, with its own people, assignments and clearances.
    other = await seedFixtures(h.adminPool, { auditClearance: false });
  }, 240_000);

  afterAll(async () => {
    await h?.stop();
  });

  const asApp = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withTransaction(h.pool, fn);

  describe('the context is sealed', () => {
    it('reads a raw set_config as the unset context it is', async () => {
      const seen = await asApp(async (tx) => {
        await tx.query(`select set_config('kf.organization', $1, true)`, [f.organizationId]);
        await tx.query(`select set_config('kf.max_classification', 'restricted', true)`);
        return tx.one<{ org: string | null; rank: number; objects: number }>(
          `select core.current_organization()::text as org,
                  core.current_classification_rank() as rank,
                  (select count(*) from core.object)::int as objects`,
        );
      });
      expect(seen).toEqual({ org: null, rank: -1, objects: 0 });
    });

    it('does not accept a seal copied out of another transaction', async () => {
      const sealed = await asApp(async (tx) => {
        await bindReader(tx, f);
        return tx.one<{ value: string; seal: string }>(
          `select current_setting('kf.organization') as value,
                  current_setting('kf.organization_seal') as seal`,
        );
      });
      const replayed = await asApp(async (tx) => {
        await tx.query(`select set_config('kf.organization', $1, true)`, [sealed.value]);
        await tx.query(`select set_config('kf.organization_seal', $1, true)`, [sealed.seal]);
        return tx.one<{ org: string | null }>('select core.current_organization()::text as org');
      });
      expect(replayed.org).toBeNull();
    });

    it('leaves no function reading or writing a kf.* setting except the seal itself', async () => {
      const offenders = await withTransaction(h.adminPool, (tx) =>
        tx.query<{ fn: string }>(
          `select p.oid::regprocedure::text as fn
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname not in ('pg_catalog', 'information_schema')
              and p.prosrc ~ $re$(current_setting|set_config)\\(\\s*'kf\\.$re$
              and p.oid not in ('core.seal_setting(text,text,boolean)'::regprocedure,
                                'core.sealed_setting(text,boolean)'::regprocedure)`,
        ),
      );
      expect(offenders).toEqual([]);
    });
  });

  it('asks for the sealed context once per query, never once per row', async () => {
    // 20260923000300: an accessor call bare in a policy is a per-row filter that pays for the
    // HMAC on every row (17 ms became 296 ms over 12,000 rows). Wrapped in a scalar subquery it
    // is an InitPlan, asked once. A policy added later in the bare form fails here.
    const bare = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ policy: string }>(
        `select polrelid::regclass::text || '.' || polname as policy
           from pg_policy
          where coalesce(pg_get_expr(polqual, polrelid), '')
                || coalesce(pg_get_expr(polwithcheck, polrelid), '')
                ~ '(?<!SELECT )core\\.current_[a-z_]+\\(\\)'`,
      ),
    );
    expect(bare).toEqual([]);
    const bareViews = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ view: string }>(
        `select c.oid::regclass::text as view
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'v' and n.nspname not in ('pg_catalog', 'information_schema')
            and pg_get_viewdef(c.oid) ~ '(?<!SELECT )core\\.current_[a-z_]+\\(\\)'`,
      ),
    );
    expect(bareViews).toEqual([]);
  });

  describe('the application binds a principal, not an organization', () => {
    it('refuses an organization and ceiling with nobody behind them', async () => {
      await expect(
        asApp((tx) =>
          tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']),
        ),
      ).rejects.toThrow(/binds a principal, not an organization/);
    });

    it('still binds `public` with no principal, because it is anyone’s to read', async () => {
      const rank = await asApp(async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'public']);
        return (await tx.one<{ rank: number }>('select core.current_classification_rank() as rank'))
          .rank;
      });
      expect(rank).toBe(0);
    });

    it('binds a person under their own live assignment, and sees their organization', async () => {
      const seen = await asApp(async (tx) => {
        const ceiling = await tx.one<{ c: string }>(
          'select core.bind_principal($1, $2, $3, $4, $5) as c',
          [
            f.performerId,
            f.performerRoleId,
            f.organizationId,
            'internal',
            await h.attest({
              actorId: f.performerId,
              actingRoleId: f.performerRoleId,
              organizationId: f.organizationId,
              maxClassification: 'internal',
            }),
          ],
        );
        const org = await tx.one<{ org: string }>(
          'select core.current_organization()::text as org',
        );
        return { ceiling: ceiling.c, org: org.org };
      });
      expect(seen).toEqual({ ceiling: 'internal', org: f.organizationId });
    });

    it('refuses an assignment the person does not hold', async () => {
      await expect(
        asApp((tx) =>
          tx.query('select core.bind_principal($1, $2, $3, $4)', [
            f.performerId,
            f.reviewerRoleId,
            f.organizationId,
            'restricted',
          ]),
        ),
      ).rejects.toThrow(/is not held live/);
    });

    it('refuses a real assignment presented in another tenant', async () => {
      await expect(
        asApp((tx) =>
          tx.query('select core.bind_principal($1, $2, $3, $4)', [
            f.performerId,
            f.performerRoleId,
            other.organizationId,
            'restricted',
          ]),
        ),
      ).rejects.toThrow(/is not held live/);
    });

    it('lets a bound principal narrow, but not widen or move', async () => {
      await asApp(async (tx) => {
        await bindReader(tx, f, f.performerId, 'internal');
        await tx.query('savepoint s');
        await expect(
          tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']),
        ).rejects.toThrow(/exceeds the principal's ceiling/);
        await tx.query('rollback to savepoint s');
        // Not even at `public`: a bound principal stepping into another tenant could then act
        // there as themselves.
        await expect(
          tx.query('select core.set_access_context($1, $2)', [other.organizationId, 'public']),
        ).rejects.toThrow(/acts in organization/);
        await tx.query('rollback to savepoint s');
        await expect(
          tx.query('select core.set_access_context($1, $2)', [other.organizationId, 'internal']),
        ).rejects.toThrow(/acts in organization/);
        await tx.query('rollback to savepoint s');
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'public']);
      });
    });
  });

  describe('the actor is the principal', () => {
    it('refuses an actor that is nobody', async () => {
      await expect(
        asApp(async (tx) => {
          await bindReader(tx, f);
          const ghost = randomUUID();
          await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
            ghost,
            ghost,
            randomUUID(),
            'probe',
          ]);
        }),
      ).rejects.toThrow(/must be the bound principal/);
    });

    it('refuses acting as somebody other than the bound principal', async () => {
      await expect(
        asApp(async (tx) => {
          await bindReader(tx, f, f.performerId);
          await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
            f.reviewerId,
            f.reviewerRoleId,
            randomUUID(),
            'probe',
          ]);
        }),
      ).rejects.toThrow(/must be the bound principal/);
    });

    it('refuses acting under an assignment other than the bound one', async () => {
      await expect(
        asApp(async (tx) => {
          await bindReader(tx, f, f.performerId);
          await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
            f.performerId,
            f.reviewerRoleId,
            randomUUID(),
            'probe',
          ]);
        }),
      ).rejects.toThrow(/must be the bound principal/);
    });
  });

  /** Bind the performer and a fresh action id, and record that action as the context names it. */
  async function actAsPerformer(tx: Tx, targets: readonly string[]): Promise<string> {
    const actionId = randomUUID();
    await bindReader(tx, f, f.performerId);
    await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
      f.performerId,
      f.performerRoleId,
      actionId,
      'principal-binding-test',
    ]);
    await tx.query(
      `insert into core.action
         (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
          target_ids, idempotency_key, effective_at, result_status)
       values ($1, $2, repeat('a', 64), 'create_initiative', $3, $4, $5::uuid[], $6,
               date_trunc('milliseconds', now()), 'applied')`,
      [
        actionId,
        f.organizationId,
        f.performerId,
        f.performerRoleId,
        targets,
        `probe-${actionId.slice(0, 12)}`,
      ],
    );
    return actionId;
  }

  describe('the ledger records only the act the context names', () => {
    it('accepts the action row the context names', async () => {
      await expect(asApp((tx) => actAsPerformer(tx, [f.organizationId]))).resolves.toBeTypeOf(
        'string',
      );
    });

    it('refuses an action row credited to somebody else', async () => {
      await expect(
        asApp(async (tx) => {
          await bindContext(tx, f, f.performerId);
          await tx.query(
            `insert into core.action
               (organization_id, request_digest, action_type, actor_id, acting_role_id,
                target_ids, idempotency_key, effective_at, result_status)
             values ($1, repeat('a', 64), 'create_initiative', $2, $3, array[$1]::uuid[],
                     'forged-action-1', date_trunc('milliseconds', now()), 'applied')`,
            [f.organizationId, f.reviewerId, f.reviewerRoleId],
          );
        }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('the audit chain is computed by the database', () => {
    it('agrees with @kf/canonicalization byte for byte', async () => {
      const prev = 'ab'.repeat(32);
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const effectiveAt = '2026-09-23T08:05:22.578Z';
      const cases = [
        { before: null, after: null },
        { before: 'cd'.repeat(32), after: 'ef'.repeat(32) },
      ];
      for (const c of cases) {
        const expected = auditChainDigest(prev, {
          action_id: ids[0]!,
          action_type: 'create_initiative',
          actor_id: ids[1]!,
          acting_role_id: ids[2]!,
          object_ids: [...ids].sort(compareCanonicalText),
          effective_at: effectiveAt,
          before_digest: c.before,
          after_digest: c.after,
        });
        const computed = await withTransaction(h.adminPool, (tx) =>
          tx.one<{ d: string }>(
            `select core.audit_event_digest($1, $2, 'create_initiative', $3, $4, $5::uuid[],
                                            $6::timestamptz, $7, $8) as d`,
            [prev, ids[0], ids[1], ids[2], [...ids].reverse(), effectiveAt, c.before, c.after],
          ),
        );
        expect(computed.d).toBe(expected);
      }
    });

    async function appendEvent(tx: Tx, actionId: string, forgeDigest: boolean): Promise<void> {
      const head = await tx.one<{ digest: string }>(
        'select digest from core.audit_event order by seq desc limit 1',
      );
      const action = await tx.one<{ effective_at: Date; target_ids: string[] }>(
        'select effective_at, target_ids from core.action where id = $1',
        [actionId],
      );
      const effectiveAt = action.effective_at.toISOString();
      const real = auditChainDigest(head.digest, {
        action_id: actionId,
        action_type: 'create_initiative',
        actor_id: f.performerId,
        acting_role_id: f.performerRoleId,
        object_ids: [...action.target_ids].sort(compareCanonicalText),
        effective_at: effectiveAt,
        before_digest: null,
        after_digest: null,
      });
      await tx.query(
        `insert into core.audit_event
           (action_id, actor_id, acting_role_id, action_type, object_id, effective_at,
            prev_digest, digest)
         values ($1, $2, $3, 'create_initiative', $4, $5, $6, $7)`,
        [
          actionId,
          f.performerId,
          f.performerRoleId,
          f.organizationId,
          effectiveAt,
          head.digest,
          forgeDigest ? 'f'.repeat(64) : real,
        ],
      );
    }

    it('accepts an event whose digest it can reproduce', async () => {
      await expect(
        asApp(async (tx) => appendEvent(tx, await actAsPerformer(tx, [f.organizationId]), false)),
      ).resolves.toBeUndefined();
    });

    it('refuses an event whose digest nobody computed', async () => {
      await expect(
        asApp(async (tx) => appendEvent(tx, await actAsPerformer(tx, [f.organizationId]), true)),
      ).rejects.toThrow(/digest does not match its content/);
    });

    it('refuses an event for an action this transaction is not performing', async () => {
      await expect(
        asApp(async (tx) => {
          await actAsPerformer(tx, [f.organizationId]);
          await appendEvent(tx, f.clearanceActionId, false);
        }),
      ).rejects.toThrow(
        /does not describe its own action truthfully|this transaction is performing/,
      );
    });
  });

  describe('authority rows can only be closed', () => {
    it('refuses rewriting who holds a role', async () => {
      await expect(
        asApp(async (tx) => {
          await bindContext(tx, f, f.performerId);
          await tx.query(
            `update org.role_assignment set role_id = 'technical_authority' where id = $1`,
            [f.performerRoleId],
          );
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('ends an assignment, and refuses to reopen or extend it', async () => {
      // A throwaway assignment, so ending it does not disturb the fixtures.
      const assignment = await createObject(h.adminPool, f, {
        type: 'role_assignment',
        domain: 'organization',
        state: 'active',
        title: 'probe assignment',
        createdBy: f.reviewerId,
      });
      await withTransaction(h.adminPool, async (tx) => {
        await tx.query('select core.set_access_context($1, $2)', [f.organizationId, 'restricted']);
        await tx.query(
          `insert into org.role_assignment (id, subject_id, role_id, scope_id)
           values ($1, $2, 'reviewer', $3)`,
          [assignment, f.performerId, f.organizationId],
        );
      });
      await asApp(async (tx) => {
        await bindContext(tx, f, f.performerId);
        await tx.query(`update org.role_assignment set valid_to = now() where id = $1`, [
          assignment,
        ]);
      });
      for (const reopen of ['null', `now() + interval '1 year'`]) {
        await expect(
          asApp(async (tx) => {
            await bindContext(tx, f, f.performerId);
            await tx.query(`update org.role_assignment set valid_to = ${reopen} where id = $1`, [
              assignment,
            ]);
          }),
        ).rejects.toThrow(/cannot be (reopened|extended)/);
      }
    });

    it('refuses reopening a clearance', async () => {
      await expect(
        asApp(async (tx) => {
          await bindContext(tx, f, f.performerId);
          await tx.query(
            `update org.person_clearance set valid_to = null
              where subject_id = $1 and organization_id = $2`,
            [f.performerId, f.organizationId],
          );
        }),
      ).rejects.toThrow(/cannot be reopened/);
    });
  });

  describe('the application cannot mint authority', () => {
    // People, role assignments and identity links are written by the owner credential's admin
    // commands and nothing else, so the application role holds no INSERT on them at all.
    it('cannot link a login to a person, with or without a context', async () => {
      const link = (tx: Tx, subject: string) =>
        tx.query(
          `insert into org.external_identity (issuer, subject, person_id, linked_by)
           values ('https://attacker.example', $1, $2, $3)`,
          [subject, f.reviewerId, f.organizationId],
        );
      await expect(asApp((tx) => link(tx, 'evil'))).rejects.toThrow(/permission denied/);
      await expect(
        asApp(async (tx) => {
          await bindContext(tx, f, f.performerId);
          await link(tx, 'evil-2');
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('cannot create a role assignment', async () => {
      await expect(
        asApp(async (tx) => {
          await bindContext(tx, f, f.performerId);
          await tx.query(
            `insert into org.role_assignment (id, subject_id, role_id, scope_id)
             values ($1, $2, 'technical_authority', $3)`,
            [f.organizationId, f.performerId, f.organizationId],
          );
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('cannot grant a clearance to the actor granting it', async () => {
      await expect(
        asApp(async (tx) => {
          await bindContext(tx, f, f.performerId);
          await tx.query(
            `insert into org.person_clearance
               (subject_id, organization_id, max_classification, granted_by, granted_by_action,
                reason)
             values ($1, $2, 'restricted', $1, core.current_action_id(), 'self-granted clearance')`,
            [f.performerId, f.organizationId],
          );
        }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('a verification is the sealed actor’s own act', () => {
    it('refuses naming another person as verifier', async () => {
      const record = await createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'proposed',
        title: 'Verified by whom?',
        createdBy: f.reviewerId,
      });
      await expect(
        asApp(async (tx) => {
          const actionId = await actAsPerformer(tx, [record]);
          await tx.query(
            `insert into core.object_verification (object_id, verified_by, basis, recorded_by_action)
             values ($1, $2, 'reviewed_individually', $3)`,
            [record, f.reviewerId, actionId],
          );
        }),
      ).rejects.toThrow(/row-level security/);
    });

    it('refuses the record’s creator verifying it, and accepts somebody else', async () => {
      const record = await createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'proposed',
        title: 'Checked by its author?',
        createdBy: f.performerId,
      });
      const insertAs = (tx: Tx, actionId: string, verifier: string) =>
        tx.query(
          `insert into core.object_verification (object_id, verified_by, basis, recorded_by_action)
           values ($1, $2, 'reviewed_individually', $3)`,
          [record, verifier, actionId],
        );
      await expect(
        asApp(async (tx) => insertAs(tx, await actAsPerformer(tx, [record]), f.performerId)),
      ).rejects.toThrow(/row-level security/);

      await asApp(async (tx) => {
        const actionId = randomUUID();
        await bindReader(tx, f, f.reviewerId);
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          f.reviewerId,
          f.reviewerRoleId,
          actionId,
          'principal-binding-test',
        ]);
        await tx.query(
          `insert into core.action
             (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
              target_ids, idempotency_key, effective_at, result_status)
           values ($1, $2, repeat('b', 64), 'verify_record', $3, $4, array[$5]::uuid[], $6,
                   date_trunc('milliseconds', now()), 'applied')`,
          [
            actionId,
            f.organizationId,
            f.reviewerId,
            f.reviewerRoleId,
            record,
            `probe-${actionId.slice(0, 12)}`,
          ],
        );
        await insertAs(tx, actionId, f.reviewerId);
      });
    });
  });

  describe('definer lookups answer only for the bound organization', () => {
    it('does not band another tenant’s objects', async () => {
      const foreign = await createObject(h.adminPool, other, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'proposed',
        title: 'Not yours',
        createdBy: other.reviewerId,
      });
      const bands = await asApp(async (tx) => {
        await bindReader(tx, f);
        return tx.query<{ classification: string | null }>(
          'select classification from retrieval.slot_bands($1, array[$2]::uuid[])',
          [other.organizationId, foreign],
        );
      });
      expect(bands).toEqual([{ classification: null }]);
    });

    it('treats every uuid in an evidence reference as a citation', async () => {
      const unverified = await createObject(h.adminPool, f, {
        type: 'decision_record',
        domain: 'engineering',
        state: 'proposed',
        title: 'Cited before anyone checked it',
        createdBy: f.reviewerId,
      });
      const answers = await asApp(async (tx) => {
        await bindReader(tx, f);
        const ask = async (ref: string) =>
          (
            await tx.one<{ u: boolean }>('select work.evidence_ref_is_unverified_record($1) as u', [
              ref,
            ])
          ).u;
        return {
          bare: await ask(unverified),
          wrapped: await ask(`kf:${unverified}`),
          prose: await ask(`see ${unverified.toUpperCase()} for details`),
          unrelated: await ask('https://example.com/datasheet'),
        };
      });
      expect(answers).toEqual({ bare: true, wrapped: true, prose: true, unrelated: false });
    });
  });
});
