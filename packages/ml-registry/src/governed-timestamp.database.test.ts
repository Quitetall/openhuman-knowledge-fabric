import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import {
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../../../tests/database/harness.js';

let harness: Harness;
let fixtures: Fixtures;

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

describe('governed database timestamp and base64 authority', () => {
  it('makes every ML authority timestamp losslessly representable on the millisecond wire', async () => {
    const domain = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ exact: boolean; microsecond: boolean; extended: boolean; infinite: boolean }>(
        `select core.is_canonical_wire_timestamp(
                  '2026-08-15T12:30:00.123Z'::timestamptz
                ) as exact,
                core.is_canonical_wire_timestamp(
                  '2026-08-15T12:30:00.123001Z'::timestamptz
                ) as microsecond,
                core.is_canonical_wire_timestamp(
                  '10000-01-01T00:00:00.000Z'::timestamptz
                ) as extended,
                core.is_canonical_wire_timestamp('infinity'::timestamptz) as infinite`,
      ),
    );
    expect(domain).toEqual({ exact: true, microsecond: false, extended: false, infinite: false });

    const constraints = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ name: string }>(
        `select conname as name
           from pg_constraint
          where connamespace = 'ml'::regnamespace
            and conname like '%\\_canonical\\_wire' escape '\\'
          order by conname`,
      ),
    );
    expect(constraints.map(({ name }) => name)).toEqual([
      'metric_event_recorded_at_canonical_wire',
      'metric_event_timestamp_value_canonical_wire',
      'metric_write_authorization_authorized_at_canonical_wire',
      'promotion_authority_decision_effective_at_canonical_wire',
      'promotion_authority_decision_recorded_at_canonical_wire',
      'promotion_authority_decision_valid_until_canonical_wire',
      'promotion_receipt_promoted_at_canonical_wire',
      'promotion_receipt_recorded_at_canonical_wire',
      'promotion_revocation_recorded_at_canonical_wire',
      'promotion_revocation_revoked_at_canonical_wire',
      'promotion_signing_key_registered_at_canonical_wire',
      'promotion_signing_key_revoked_at_canonical_wire',
      'promotion_signing_key_valid_from_canonical_wire',
      'promotion_signing_key_valid_until_canonical_wire',
      'run_lineage_recorded_at_canonical_wire',
      'run_seal_recorded_at_canonical_wire',
      'run_seal_sealed_at_canonical_wire',
      'run_seal_signing_key_registered_at_canonical_wire',
      'run_seal_signing_key_revoked_at_canonical_wire',
      'run_seal_signing_key_valid_from_canonical_wire',
      'run_seal_signing_key_valid_until_canonical_wire',
    ]);

    const defaults = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ table_name: string; column_default: string }>(
        `select table_name, column_default
           from information_schema.columns
          where table_schema = 'ml'
            and column_name = 'recorded_at'
            and table_name = any($1::text[])
          order by table_name`,
        [
          [
            'run_lineage',
            'run_seal',
            'promotion_receipt',
            'promotion_revocation',
            'promotion_authority_decision',
          ],
        ],
      ),
    );
    expect(defaults.map(({ table_name }) => table_name)).toEqual([
      'promotion_authority_decision',
      'promotion_receipt',
      'promotion_revocation',
      'run_lineage',
      'run_seal',
    ]);
    expect(
      defaults.every(({ column_default }) =>
        /date_trunc\('milliseconds'::text, transaction_timestamp\(\)\)/u.test(column_default),
      ),
    ).toBe(true);

    const { publicKey } = generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    const privileges = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ role_name: string; can_execute: boolean }>(
        `select role_name,
                has_function_privilege(
                  role_name,
                  'core.is_canonical_wire_timestamp(timestamp with time zone)',
                  'EXECUTE'
                ) as can_execute
           from unnest($1::text[]) role_name
          order by role_name`,
        [['kf_app', 'kf_migrator', 'kf_ml_promoter', 'kf_worker']],
      ),
    );
    expect(privileges).toEqual([
      { role_name: 'kf_app', can_execute: true },
      { role_name: 'kf_migrator', can_execute: true },
      { role_name: 'kf_ml_promoter', can_execute: true },
      { role_name: 'kf_worker', can_execute: true },
    ]);

    await expect(
      withTransaction(harness.adminPool, async (tx) => {
        await tx.query('set local role kf_migrator');
        await tx.query(
          `insert into ml.promotion_signing_key
             (organization_id, key_id, algorithm, public_key_spki_der_base64,
              public_key_sha256, valid_from, valid_until, registered_at)
           values ($1,'canonical-nonowner-key','Ed25519',$2,$3,
                   '2020-01-01T00:00:00.000Z',null,
                   '2026-08-15T12:30:00.123Z')`,
          [
            fixtures.organizationId,
            der.toString('base64'),
            createHash('sha256').update(der).digest('hex'),
          ],
        );
      }),
    ).resolves.toBeUndefined();

    const { publicKey: microsecondPublicKey } = generateKeyPairSync('ed25519');
    const microsecondDer = microsecondPublicKey.export({ format: 'der', type: 'spki' });
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query(
          `insert into ml.promotion_signing_key
             (organization_id, key_id, algorithm, public_key_spki_der_base64,
              public_key_sha256, valid_from, valid_until, registered_at)
           values ($1,'microsecond-key-refused','Ed25519',$2,$3,
                   '2020-01-01T00:00:00.000Z',null,
                   '2026-08-15T12:30:00.000001Z')`,
          [
            fixtures.organizationId,
            microsecondDer.toString('base64'),
            createHash('sha256').update(microsecondDer).digest('hex'),
          ],
        ),
      ),
    ).rejects.toThrow(/promotion_signing_key_registered_at_canonical_wire/i);
  });

  it('accepts only finite four-digit-year, millisecond, nonfuture effective instants', async () => {
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query(
          `select core.require_governed_effective_timestamp(
             date_trunc('milliseconds', clock_timestamp() - interval '1 second'),
             'valid test timestamp'
           )`,
        ),
      ),
    ).resolves.toHaveLength(1);

    for (const value of [
      '-infinity',
      'infinity',
      '0001-01-01 BC',
      '10000-01-01T00:00:00.000Z',
      '2026-08-15T12:30:00.000001Z',
      '2098-08-15T12:30:00.000Z',
    ]) {
      await expect(
        withTransaction(harness.adminPool, (tx) =>
          tx.query(
            `select core.require_governed_effective_timestamp(
               $1::timestamptz, 'test governed timestamp'
             )`,
            [value],
          ),
        ),
      ).rejects.toThrow(/finite four-digit-year millisecond instant.*not (?:be )?in the future/i);
    }
  });

  it('attaches the shared guard to every governed effect and applies it on write', async () => {
    const triggerTables = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ table_name: string }>(
        `select event_object_schema || '.' || event_object_table as table_name
           from information_schema.triggers
          where trigger_name = 'zz_governed_effective_timestamp'
          order by table_name`,
      ),
    );
    expect(triggerTables.map((row) => row.table_name)).toEqual([
      'ml.promotion_receipt',
      'ml.promotion_revocation',
      'ml.promotion_signing_key_revocation',
      'ml.run_seal',
      'ml.run_seal_signing_key_revocation',
      'secure_object.authority_signing_key_revocation',
      'secure_object.erasure_tombstone',
    ]);

    const { publicKey } = generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    const keyRegistryId = await withTransaction(harness.adminPool, async (tx) => {
      const key = await tx.one<{ id: string }>(
        `insert into ml.run_seal_signing_key
           (organization_id, workload_identity_ref, key_id, algorithm,
            public_key_spki_der_base64, public_key_sha256,
            valid_from, valid_until, registered_at)
         values ($1,'workload:timestamp-authority','timestamp-authority-key','Ed25519',
                 $2,$3,'2020-01-01T00:00:00.000Z',null,
                 date_trunc('milliseconds', transaction_timestamp()))
         returning id`,
        [
          fixtures.organizationId,
          der.toString('base64'),
          createHash('sha256').update(der).digest('hex'),
        ],
      );
      return key.id;
    });
    await expect(
      withTransaction(harness.adminPool, (tx) =>
        tx.query(
          `insert into ml.run_seal_signing_key_revocation
             (signing_key_registry_id, reason_code, revoked_at)
           values ($1,'administrative','2098-08-15T12:30:00.000Z')`,
          [keyRegistryId],
        ),
      ),
    ).rejects.toThrow(/must not be in the future/i);
  });

  it('makes alias effectivity and secure-object base64 canonicality explicit in schema', async () => {
    const view = await withTransaction(harness.adminPool, (tx) =>
      tx.one<{ definition: string }>(
        `select pg_get_viewdef('ml.governed_alias'::regclass, true) as definition`,
      ),
    );
    expect(view.definition).toMatch(/promoted_at <= evaluation(?:_1)?\.evaluated_at/i);
    expect(view.definition).toMatch(/revoked_at <= evaluation\.evaluated_at/i);

    const constraints = await withTransaction(harness.adminPool, (tx) =>
      tx.query<{ name: string; definition: string }>(
        `select conname as name, pg_get_constraintdef(oid, true) as definition
           from pg_constraint
          where conname in (
            'authority_signing_key_canonical_base64',
            'erasure_tombstone_signature_canonical_base64'
          )
          order by conname`,
      ),
    );
    expect(constraints.map((constraint) => constraint.name)).toEqual([
      'authority_signing_key_canonical_base64',
      'erasure_tombstone_signature_canonical_base64',
    ]);
    expect(constraints.every((constraint) => /encode\(decode\(/i.test(constraint.definition))).toBe(
      true,
    );
  });
});
