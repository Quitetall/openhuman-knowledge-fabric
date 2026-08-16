/**
 * The install nobody tests until the day they need it.
 *
 * Every other database test starts from `startHarness()`, which creates extensions before
 * applying migrations — and the restore script creates them too. So every path anybody
 * exercised worked, while `dbmate up` against a genuinely fresh database failed at the org
 * migration on `data type uuid has no default operator class for access method "gist"`.
 *
 * A dependency satisfied by every harness except the real one is the kind that gets
 * discovered during an install, by whoever is least equipped to diagnose it. This test is a
 * bare container and the migration directory, and nothing else.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool, withTransaction, type Pool } from '@kf/database';
import { POSTGRES_INITDB_ARGS } from './harness.js';

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'database', 'migrations');
const SEED = join(ROOT, 'generated', 'sql-registry', '001-ontology-seed.sql');

function upSection(sql: string): string {
  const start = sql.indexOf('-- migrate:up');
  const end = sql.indexOf('-- migrate:down');
  if (start < 0) throw new Error('migration has no -- migrate:up section');
  return sql.slice(start + '-- migrate:up'.length, end < 0 ? undefined : end);
}

function downSection(sql: string): string {
  const start = sql.indexOf('-- migrate:down');
  if (start < 0) throw new Error('migration has no -- migrate:down section');
  return sql.slice(start + '-- migrate:down'.length);
}

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool | undefined;

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('a completely fresh database', () => {
  it('applies every migration with NOTHING pre-created', async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('fresh_install')
      .withUsername('kf_owner')
      .withPassword('test-only-not-a-secret')
      .withEnvironment({ POSTGRES_INITDB_ARGS })
      .start();
    pool = createPool({ connectionString: container.getConnectionUri(), maxConnections: 2 });

    // No `create extension`, no seed, no fixtures. Exactly what an operator gets.
    const applied: string[] = [];
    const legacyCompilerRegistrationId = '01900000-0000-7000-8000-000000000050';
    for (const file of readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      if (file === '20260814000500_compiler_evidence_hardening.sql') {
        await withTransaction(pool, async (tx) => {
          await tx.query('set local session_replication_role = replica');
          await tx.query(
            `insert into content.document_compiler_registration
               (id, compiler_name, compiler_version, protocol, liminal_commit_sha,
                cargo_lock_digest, executable_digest, qualification_state,
                qualification_receipt_digest, qualification_ratified, registered_by)
             values ($1,'legacy-v004-compiler','0.4.0','kf-document-v1',$2,$3,$4,
                     'not_run',null,false,$5)`,
            [
              legacyCompilerRegistrationId,
              'a'.repeat(40),
              'b'.repeat(64),
              'c'.repeat(64),
              '01900000-0000-7000-8000-000000000051',
            ],
          );
        });
      }
      const sql = upSection(readFileSync(join(MIGRATIONS, file), 'utf8'));
      if (file === '20260814002500_ml_timestamp_wire_contract.sql') {
        const legacyLineageId = '01900000-0000-7000-8000-000000000025';
        await withTransaction(pool, async (tx) => {
          await tx.query('set local session_replication_role = replica');
          await tx.query(
            `insert into ml.run_lineage
               (id, run_ref_id, code_ref_id, recipe_ref_id, environment_ref_id,
                metric_policy_ref_id, lineage_sha256, recorded_at)
             values ($1,$2,$3,$4,$5,$6,$7,'2026-08-15T12:30:00.000001Z')`,
            [
              legacyLineageId,
              '01900000-0000-7000-8000-000000000026',
              '01900000-0000-7000-8000-000000000027',
              '01900000-0000-7000-8000-000000000028',
              '01900000-0000-7000-8000-000000000029',
              '01900000-0000-7000-8000-000000000030',
              '1'.repeat(64),
            ],
          );
        });

        await expect(
          withTransaction(pool, async (tx) => {
            await tx.query(sql);
          }),
        ).rejects.toThrow(/run_lineage_recorded_at_canonical_wire/i);

        const refused = await withTransaction(pool, (tx) =>
          tx.one<{
            recorded_at: string;
            canonical_function: string | null;
            canonical_constraint: string | null;
          }>(
            `select to_char(
                      recorded_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                    ) as recorded_at,
                    to_regprocedure(
                      'core.is_canonical_wire_timestamp(timestamp with time zone)'
                    )::text as canonical_function,
                    (
                      select conname
                        from pg_constraint
                       where conrelid = 'ml.run_lineage'::regclass
                         and conname = 'run_lineage_recorded_at_canonical_wire'
                    ) as canonical_constraint
               from ml.run_lineage
              where id = $1`,
            [legacyLineageId],
          ),
        );
        expect(refused).toEqual({
          recorded_at: '2026-08-15T12:30:00.000001Z',
          canonical_function: null,
          canonical_constraint: null,
        });

        await withTransaction(pool, async (tx) => {
          await tx.query('set local session_replication_role = replica');
          await tx.query('delete from ml.run_lineage where id = $1', [legacyLineageId]);
        });
      }
      if (file === '20260814002900_action_audit_timestamp_wire.sql') {
        const legacyActionId = '01900000-0000-7000-8000-000000000029';
        await withTransaction(pool, async (tx) => {
          await tx.query('set local session_replication_role = replica');
          await tx.query(
            `insert into core.action
               (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
                target_ids, parameters, preconditions, idempotency_key, recorded_at,
                effective_at, result_status, result)
             values ($1,$2,$3,'legacy-microsecond-action',$4,$5,$6::uuid[],'{}','{}',
                     'legacy-microsecond-action-0001',
                     '2026-08-15T12:30:00.000001Z','2026-08-15T12:30:00.000001Z',
                     'applied','{}')`,
            [
              legacyActionId,
              '01900000-0000-7000-8000-000000000030',
              '2'.repeat(64),
              '01900000-0000-7000-8000-000000000031',
              '01900000-0000-7000-8000-000000000032',
              ['01900000-0000-7000-8000-000000000033'],
            ],
          );
        });

        await expect(
          withTransaction(pool, async (tx) => {
            await tx.query(sql);
          }),
        ).rejects.toThrow(/action_effective_at_canonical_wire/i);

        const refused = await withTransaction(pool, (tx) =>
          tx.one<{ effective_at: string; action_constraint: string | null }>(
            `select to_char(
                      effective_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                    ) as effective_at,
                    (
                      select conname from pg_constraint
                       where conrelid = 'core.action'::regclass
                         and conname = 'action_effective_at_canonical_wire'
                    ) as action_constraint
               from core.action where id = $1`,
            [legacyActionId],
          ),
        );
        expect(refused).toEqual({
          effective_at: '2026-08-15T12:30:00.000001Z',
          action_constraint: null,
        });

        await withTransaction(pool, async (tx) => {
          await tx.query('set local session_replication_role = replica');
          await tx.query('delete from core.action where id = $1', [legacyActionId]);
        });
      }
      await withTransaction(pool, async (tx) => {
        await tx.query(sql);
      });
      if (file === '20260814000100_document_compiler.sql') {
        const migration = readFileSync(join(MIGRATIONS, file), 'utf8');
        await withTransaction(pool, async (tx) => {
          await tx.query(downSection(migration));
          const removed = await tx.one<{ subject: string | null; publication: string | null }>(
            `select to_regclass('content.document_subject')::text as subject,
                    to_regclass('content.document_publication')::text as publication`,
          );
          expect(removed).toEqual({ subject: null, publication: null });
          await tx.query(upSection(migration));
        });
      }
      if (file === '20260814000400_compiler_runtime.sql') {
        const migration = readFileSync(join(MIGRATIONS, file), 'utf8');
        await withTransaction(pool, async (tx) => {
          await tx.query(downSection(migration));
          const removed = await tx.one<{
            registration: string | null;
            basis_column: string | null;
          }>(
            `select to_regclass('content.document_compiler_registration')::text as registration,
                    (select column_name from information_schema.columns
                      where table_schema = 'content' and table_name = 'compilation_basis'
                        and column_name = 'compiler_registration_id') as basis_column`,
          );
          expect(removed).toEqual({ registration: null, basis_column: null });
          await tx.query(upSection(migration));
        });
      }
      if (file === '20260814000500_compiler_evidence_hardening.sql') {
        const migration = readFileSync(join(MIGRATIONS, file), 'utf8');
        const preserved = await withTransaction(pool, (tx) =>
          tx.one<{ runtime_closure_digest: string | null }>(
            `select runtime_closure_digest
               from content.document_compiler_registration where id = $1`,
            [legacyCompilerRegistrationId],
          ),
        );
        expect(preserved.runtime_closure_digest).toBeNull();
        await expect(
          withTransaction(pool, (tx) =>
            tx.query(
              `insert into content.document_compiler_registration
                 (compiler_name, compiler_version, protocol, liminal_commit_sha,
                  cargo_lock_digest, executable_digest, runtime_closure_digest,
                  qualification_state, qualification_receipt_digest,
                  qualification_ratified, registered_by)
               values ('new-unpinned-compiler','0.5.0','kf-document-v1',$1,$2,$3,null,
                       'not_run',null,false,$4)`,
              [
                'd'.repeat(40),
                'e'.repeat(64),
                'f'.repeat(64),
                '01900000-0000-7000-8000-000000000052',
              ],
            ),
          ),
        ).rejects.toThrow(/runtime-closure digest/i);
        await withTransaction(pool, async (tx) => {
          await tx.query(downSection(migration));
          const reverted = await tx.one<{
            registration_column: string | null;
            basis_column: string | null;
            runtime_request: string | null;
            provenance_guard: string | null;
          }>(
            `select
               (select column_name from information_schema.columns
                 where table_schema = 'content'
                   and table_name = 'document_compiler_registration'
                   and column_name = 'runtime_closure_digest') as registration_column,
               (select column_name from information_schema.columns
                 where table_schema = 'content' and table_name = 'compilation_basis'
                   and column_name = 'runtime_closure_digest') as basis_column,
               to_regprocedure('content.compiler_runtime_request(uuid)')::text
                 as runtime_request,
               to_regprocedure('content.enforce_compilation_provenance_basis()')::text
                 as provenance_guard`,
          );
          expect(reverted).toEqual({
            registration_column: null,
            basis_column: null,
            runtime_request: 'content.compiler_runtime_request(uuid)',
            provenance_guard: null,
          });
          await tx.query(upSection(migration));
        });
        await withTransaction(pool, async (tx) => {
          await tx.query('set local session_replication_role = replica');
          await tx.query('delete from content.document_compiler_registration where id = $1', [
            legacyCompilerRegistrationId,
          ]);
        });
      }
      if (file === '20260814000600_secure_object_role_authority.sql') {
        const migration = readFileSync(join(MIGRATIONS, file), 'utf8');
        await withTransaction(pool, async (tx) => {
          const hardened = await tx.one<{ definition: string }>(
            `select pg_get_functiondef(
               'secure_object.require_exact_action(text,uuid,jsonb)'::regprocedure
             ) as definition`,
          );
          expect(hardened.definition).toContain('ra.role_id = any(v_allowed_roles)');

          await tx.query(downSection(migration));
          const restored = await tx.one<{ definition: string }>(
            `select pg_get_functiondef(
               'secure_object.require_exact_action(text,uuid,jsonb)'::regprocedure
             ) as definition`,
          );
          expect(restored.definition).not.toContain('v_allowed_roles');
          expect(restored.definition).toContain(
            'secure-object action role is not active for owning organization',
          );

          await tx.query(upSection(migration));
          const reapplied = await tx.one<{ definition: string }>(
            `select pg_get_functiondef(
               'secure_object.require_exact_action(text,uuid,jsonb)'::regprocedure
             ) as definition`,
          );
          expect(reapplied.definition).toContain('ra.role_id = any(v_allowed_roles)');
        });
      }
      if (file === '20260814000800_ml_promotion_signature_authority.sql') {
        const migration = readFileSync(join(MIGRATIONS, file), 'utf8');
        await withTransaction(pool, async (tx) => {
          const hardened = await tx.one<{
            key_table: string | null;
            verification_view: string | null;
            append_function: string | null;
            revoke_function: string | null;
            raw_insert: boolean;
            raw_revoke_insert: boolean;
            append_execute: boolean;
            revoke_execute: boolean;
            alias_key_authority: boolean;
          }>(
            `select
               to_regclass('ml.promotion_signing_key')::text as key_table,
               to_regclass('ml.promotion_verification_key')::text as verification_view,
               to_regprocedure(
                 'ml.append_signed_promotion_receipt(uuid,text,uuid,uuid,uuid,uuid[],text,uuid,uuid,timestamp with time zone,text,text,text)'
               )::text as append_function,
               to_regprocedure(
                 'ml.append_signed_promotion_revocation(uuid,uuid,text,timestamp with time zone,text,text,text)'
               )::text as revoke_function,
               has_table_privilege(
                 'kf_ml_promoter', 'ml.promotion_receipt', 'INSERT'
               ) as raw_insert,
               has_table_privilege(
                 'kf_ml_promoter', 'ml.promotion_revocation', 'INSERT'
               ) as raw_revoke_insert,
               has_function_privilege(
                 'kf_ml_promoter',
                 'ml.append_signed_promotion_receipt(uuid,text,uuid,uuid,uuid,uuid[],text,uuid,uuid,timestamp with time zone,text,text,text)',
                 'EXECUTE'
               ) as append_execute,
               has_function_privilege(
                 'kf_ml_promoter',
                 'ml.append_signed_promotion_revocation(uuid,uuid,text,timestamp with time zone,text,text,text)',
                 'EXECUTE'
               ) as revoke_execute,
               pg_get_viewdef('ml.governed_alias'::regclass) like
                 '%promotion_signing_key_revocation%' as alias_key_authority`,
          );
          expect(hardened).toEqual({
            key_table: 'ml.promotion_signing_key',
            verification_view: 'ml.promotion_verification_key',
            append_function:
              'ml.append_signed_promotion_receipt(uuid,text,uuid,uuid,uuid,uuid[],text,uuid,uuid,timestamp with time zone,text,text,text)',
            revoke_function:
              'ml.append_signed_promotion_revocation(uuid,uuid,text,timestamp with time zone,text,text,text)',
            raw_insert: false,
            raw_revoke_insert: false,
            append_execute: true,
            revoke_execute: true,
            alias_key_authority: true,
          });

          await tx.query(downSection(migration));
          const reverted = await tx.one<{
            key_table: string | null;
            verification_view: string | null;
            append_function: string | null;
            revoke_function: string | null;
            raw_insert: boolean;
            raw_revoke_insert: boolean;
            alias_key_authority: boolean;
          }>(
            `select
               to_regclass('ml.promotion_signing_key')::text as key_table,
               to_regclass('ml.promotion_verification_key')::text as verification_view,
               to_regprocedure(
                 'ml.append_signed_promotion_receipt(uuid,text,uuid,uuid,uuid,uuid[],text,uuid,uuid,timestamp with time zone,text,text,text)'
               )::text as append_function,
               to_regprocedure(
                 'ml.append_signed_promotion_revocation(uuid,uuid,text,timestamp with time zone,text,text,text)'
               )::text as revoke_function,
               has_table_privilege(
                 'kf_ml_promoter', 'ml.promotion_receipt', 'INSERT'
               ) as raw_insert,
               has_table_privilege(
                 'kf_ml_promoter', 'ml.promotion_revocation', 'INSERT'
               ) as raw_revoke_insert,
               pg_get_viewdef('ml.governed_alias'::regclass) like
                 '%promotion_signing_key_revocation%' as alias_key_authority`,
          );
          expect(reverted).toEqual({
            key_table: null,
            verification_view: null,
            append_function: null,
            revoke_function: null,
            raw_insert: true,
            raw_revoke_insert: true,
            alias_key_authority: false,
          });

          await tx.query(upSection(migration));
          const reapplied = await tx.one<{
            key_table: string | null;
            verification_view: string | null;
            raw_insert: boolean;
            raw_revoke_insert: boolean;
            alias_key_authority: boolean;
          }>(
            `select
               to_regclass('ml.promotion_signing_key')::text as key_table,
               to_regclass('ml.promotion_verification_key')::text as verification_view,
               has_table_privilege(
                 'kf_ml_promoter', 'ml.promotion_receipt', 'INSERT'
               ) as raw_insert,
               has_table_privilege(
                 'kf_ml_promoter', 'ml.promotion_revocation', 'INSERT'
               ) as raw_revoke_insert,
               pg_get_viewdef('ml.governed_alias'::regclass) like
                 '%promotion_signing_key_revocation%' as alias_key_authority`,
          );
          expect(reapplied).toEqual({
            key_table: 'ml.promotion_signing_key',
            verification_view: 'ml.promotion_verification_key',
            raw_insert: false,
            raw_revoke_insert: false,
            alias_key_authority: true,
          });
        });
      }
      if (file === '20260814000900_ml_promotion_preservation_policy.sql') {
        const migration = readFileSync(join(MIGRATIONS, file), 'utf8');
        await withTransaction(pool, async (tx) => {
          const policyCount = async (): Promise<number> =>
            (
              await tx.one<{ count: number }>(
                `select count(*)::integer as count
                   from pg_policies
                  where schemaname = 'ml'
                    and policyname in (
                      'promotion_receipt_privileged',
                      'promotion_receipt_evidence_privileged',
                      'promotion_revocation_privileged'
                    )
                    and roles @> array['kf_auditor','kf_backup']::name[]`,
              )
            ).count;

          await expect(policyCount()).resolves.toBe(3);
          await tx.query(downSection(migration));
          await expect(policyCount()).resolves.toBe(0);
          await tx.query(upSection(migration));
          await expect(policyCount()).resolves.toBe(3);
        });
      }
      if (file === '20260814001000_compiler_enabled_visibility.sql') {
        const migration = readFileSync(join(MIGRATIONS, file), 'utf8');
        await withTransaction(pool, async (tx) => {
          const hardened = await tx.one<{
            internal_function: string | null;
            internal_app_execute: boolean;
            scoped_app_execute: boolean;
            worker_uses_internal: boolean;
          }>(
            `select
               to_regprocedure(
                 'content.document_compiler_enabled_internal(uuid,uuid)'
               )::text as internal_function,
               has_function_privilege(
                 'kf_app',
                 'content.document_compiler_enabled_internal(uuid,uuid)',
                 'EXECUTE'
               ) as internal_app_execute,
               has_function_privilege(
                 'kf_app', 'content.document_compiler_enabled(uuid,uuid)', 'EXECUTE'
               ) as scoped_app_execute,
               pg_get_functiondef(
                 'content.compiler_runtime_request(uuid)'::regprocedure
               ) like '%document_compiler_enabled_internal%' as worker_uses_internal`,
          );
          expect(hardened).toEqual({
            internal_function: 'content.document_compiler_enabled_internal(uuid,uuid)',
            internal_app_execute: false,
            scoped_app_execute: true,
            worker_uses_internal: true,
          });

          await tx.query(downSection(migration));
          const reverted = await tx.one<{
            internal_function: string | null;
            app_execute: boolean;
            worker_uses_internal: boolean;
          }>(
            `select
               to_regprocedure(
                 'content.document_compiler_enabled_internal(uuid,uuid)'
               )::text as internal_function,
               has_function_privilege(
                 'kf_app', 'content.document_compiler_enabled(uuid,uuid)', 'EXECUTE'
               ) as app_execute,
               pg_get_functiondef(
                 'content.compiler_runtime_request(uuid)'::regprocedure
               ) like '%document_compiler_enabled_internal%' as worker_uses_internal`,
          );
          expect(reverted).toEqual({
            internal_function: null,
            app_execute: true,
            worker_uses_internal: false,
          });

          await tx.query(upSection(migration));
          const reapplied = await tx.one<{
            internal_function: string | null;
            internal_app_execute: boolean;
          }>(
            `select
               to_regprocedure(
                 'content.document_compiler_enabled_internal(uuid,uuid)'
               )::text as internal_function,
               has_function_privilege(
                 'kf_app',
                 'content.document_compiler_enabled_internal(uuid,uuid)',
                 'EXECUTE'
               ) as internal_app_execute`,
          );
          expect(reapplied).toEqual({
            internal_function: 'content.document_compiler_enabled_internal(uuid,uuid)',
            internal_app_execute: false,
          });
        });
      }
      if (file === '20260814002800_legacy_action_digest_reservation.sql') {
        const migration = readFileSync(join(MIGRATIONS, file), 'utf8');
        const contract = async (): Promise<{ guard: boolean; constraint: boolean }> =>
          withTransaction(pool!, (tx) =>
            tx.one<{ guard: boolean; constraint: boolean }>(
              `select
                 position(
                   'reserved migration-019 legacy identity'
                   in pg_get_functiondef(
                     'core.assert_action_semantic_scope()'::regprocedure
                   )
                 ) > 0 as guard,
                 exists (
                   select 1 from pg_constraint constraint_row
                    where constraint_row.conrelid = 'core.action'::regclass
                      and constraint_row.conname = 'action_target_ids_canonical'
                 ) as constraint`,
            ),
          );

        await withTransaction(pool, (tx) => tx.query(downSection(migration)));
        expect(await contract()).toEqual({ guard: true, constraint: true });
        await withTransaction(pool, (tx) => tx.query(upSection(migration)));

        // Emulate an early database where 019 owned neither addition. Path-aware rollback
        // must remove 028-owned state, then a clean re-up must restore it.
        await withTransaction(pool, async (tx) => {
          await tx.query(
            `comment on function core.assert_action_semantic_scope() is
             '{"contract":"kf-migration-028-state-v1","guard_preexisting":false,"constraint_preexisting":false}'`,
          );
          await tx.query(downSection(migration));
        });
        expect(await contract()).toEqual({ guard: false, constraint: false });
        await withTransaction(pool, (tx) => tx.query(upSection(migration)));
        expect(await contract()).toEqual({ guard: true, constraint: true });
      }
      if (file === '20260814003000_legacy_action_schema_convergence.sql') {
        const migration = readFileSync(join(MIGRATIONS, file), 'utf8');
        const schemaContract = async (): Promise<{
          function_comment: string | null;
          table_comment: string | null;
          policy_qual: string;
          rollback_table: string | null;
        }> =>
          withTransaction(pool!, (tx) =>
            tx.one<{
              function_comment: string | null;
              table_comment: string | null;
              policy_qual: string;
              rollback_table: string | null;
            }>(
              `select
                 obj_description(
                   'core.assert_action_semantic_scope()'::regprocedure, 'pg_proc'
                 ) as function_comment,
                 obj_description(
                   'core.action_migration019_legacy'::regclass, 'pg_class'
                 ) as table_comment,
                 (
                   select pg_get_expr(policy.polqual, policy.polrelid)
                     from pg_policy policy
                    where policy.polrelid = 'core.action_migration019_legacy'::regclass
                      and policy.polname = 'action_migration019_legacy_read_scoped'
                 ) as policy_qual,
                 to_regclass('core.migration030_rollback_state')::text as rollback_table`,
            ),
          );

        const converged = await schemaContract();
        expect(converged.function_comment).toMatch(/canonical action targets/);
        expect(converged.table_comment).toMatch(/Exact migration-019 action cohort/);
        expect(converged.policy_qual).toContain('action.target_ids[1]');
        expect(converged.rollback_table).toBe('core.migration030_rollback_state');

        await withTransaction(pool, (tx) => tx.query(downSection(migration)));
        const reverted = await schemaContract();
        expect(reverted.function_comment).toContain('kf-migration-028-state-v1');
        expect(reverted.table_comment).toMatch(/Migration-owned allowlist/);
        expect(reverted.policy_qual).toContain('unnest(action.target_ids)');
        expect(reverted.rollback_table).toBeNull();

        await withTransaction(pool, (tx) => tx.query(upSection(migration)));
        expect(await schemaContract()).toEqual(converged);
      }
      applied.push(file);
    }
    expect(applied.length).toBeGreaterThan(15);
  }, 300_000);

  it('uses the builtin C.UTF-8 locale contract', async () => {
    const databaseLocale = await withTransaction(pool!, (tx) =>
      tx.one<{ provider: string; locale: string; encoding: string }>(
        `select datlocprovider as provider,
                datlocale as locale,
                pg_encoding_to_char(encoding) as encoding
           from pg_database
          where datname = current_database()`,
      ),
    );
    expect(databaseLocale).toEqual({ provider: 'b', locale: 'C.UTF-8', encoding: 'UTF8' });
  });

  it('created the extensions the schema depends on', async () => {
    const rows = await withTransaction(pool!, async (tx) =>
      tx.query<{ extname: string }>(
        "select extname from pg_extension where extname in ('btree_gist', 'pg_trgm', 'pgcrypto') order by extname",
      ),
    );
    // btree_gist: scalar types inside the GiST exclusion that refuses overlapping role
    // assignments. pg_trgm: the partial-identifier index. pgcrypto: public-key and content
    // identity checks in the secure-object ledger.
    expect(rows.map((r) => r.extname)).toEqual(['btree_gist', 'pg_trgm', 'pgcrypto']);
  });

  it('the constraint that needed btree_gist actually exists', async () => {
    // Not just "the extension is present" — the thing it was needed for.
    const row = await withTransaction(pool!, async (tx) =>
      tx.one<{ n: string }>(
        `select count(*)::text as n from pg_constraint
          where conname like '%role_assignment%' and contype = 'x'`,
      ),
    );
    expect(Number(row.n)).toBeGreaterThan(0);
  });

  it('installs the document publication authority schema', async () => {
    const rows = await withTransaction(pool!, async (tx) =>
      tx.query<{ relation: string | null }>(
        `select to_regclass(name)::text as relation
           from unnest(array[
             'content.document_subject',
             'content.document_publication_target',
             'content.document_publication_target_retirement',
             'content.document_publication'
           ]) as names(name)
          order by name`,
      ),
    );
    expect(rows.every((row) => row.relation !== null)).toBe(true);

    const columns = await withTransaction(pool!, async (tx) =>
      tx.query<{ column_name: string }>(
        `select column_name
           from information_schema.columns
          where table_schema = 'content'
            and table_name = 'document_publication'
          order by column_name`,
      ),
    );
    expect(columns.map((column) => column.column_name)).toEqual(
      expect.arrayContaining([
        'action_id',
        'compiled_view_digest',
        'controlled_content_version_id',
        'publication_target_policy_digest',
      ]),
    );

    const compilerRegistry = await withTransaction(pool!, (tx) =>
      tx.one<{ count: string }>(
        'select count(*)::text as count from content.document_compiler_registration',
      ),
    );
    expect(compilerRegistry.count).toBe('0');
  });

  it('installs the opaque secure-object ledger and backup-only preservation access', async () => {
    const tables = await withTransaction(pool!, (tx) =>
      tx.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'secure_object' and table_type = 'BASE TABLE'
          order by table_name`,
      ),
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'authority_signing_key',
      'authority_signing_key_revocation',
      'capability_consumption',
      'capability_issue',
      'capability_request',
      'capability_revocation',
      'erasure_request',
      'erasure_tombstone',
    ]);

    const digestTables = await withTransaction(pool!, (tx) =>
      tx.query<{ table_name: string }>(
        `select table_name from information_schema.columns
          where table_schema = 'secure_object'
            and column_name = 'external_content_sha256'
          order by table_name`,
      ),
    );
    expect(digestTables.map((row) => row.table_name)).toEqual([
      'capability_consumption',
      'capability_issue',
      'capability_request',
      'capability_revocation',
      'erasure_request',
      'erasure_tombstone',
    ]);

    const privileges = await withTransaction(pool!, (tx) =>
      tx.query<{ privilege_type: string; count: string }>(
        `select privilege_type, count(*)::text as count
           from information_schema.role_table_grants
          where grantee = 'kf_backup' and table_schema = 'secure_object'
          group by privilege_type order by privilege_type`,
      ),
    );
    expect(privileges).toEqual([{ privilege_type: 'SELECT', count: '8' }]);

    const backupPolicies = await withTransaction(pool!, (tx) =>
      tx.one<{ count: string }>(
        `select count(*)::text as count from pg_policies
          where schemaname = 'secure_object'
            and roles @> array['kf_backup']::name[]
            and cmd = 'SELECT'`,
      ),
    );
    expect(Number(backupPolicies.count)).toBe(8);
  });

  it('re-seeds a new ontology release without violating one-current-release', async () => {
    const first = readFileSync(SEED, 'utf8');
    const next = first
      .replaceAll('1.1.0-draft.1', '1.1.0-draft.2')
      .replaceAll(
        'e2e0283906bed576d89acee4e409cb14e475f04d4aad94bd80178f3f26b5afb9',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      );
    await withTransaction(pool!, async (tx) => {
      await tx.query(first.replace(/^begin;$|^commit;$/gm, ''));
    });
    await withTransaction(pool!, async (tx) => {
      await tx.query(next.replace(/^begin;$|^commit;$/gm, ''));
    });
    const current = await withTransaction(pool!, async (tx) =>
      tx.one<{ version: string }>(
        'select version from registry.schema_release where is_current = true',
      ),
    );
    expect(current.version).toBe('1.1.0-draft.2');
  });

  it('keeps migration-019 legacy provenance outside application write authority', async () => {
    const authority = await withTransaction(pool!, (tx) =>
      tx.one<{
        row_security: boolean;
        force_row_security: boolean;
        app_select: boolean;
        app_insert: boolean;
        migrator_select: boolean;
        migrator_insert: boolean;
        backup_select: boolean;
        canonical_constraint: boolean;
        rows: string;
      }>(
        `select class.relrowsecurity as row_security,
                class.relforcerowsecurity as force_row_security,
                has_table_privilege(
                  'kf_app', 'core.action_migration019_legacy', 'SELECT'
                ) as app_select,
                has_table_privilege(
                  'kf_app', 'core.action_migration019_legacy', 'INSERT'
                ) as app_insert,
                has_table_privilege(
                  'kf_migrator', 'core.action_migration019_legacy', 'SELECT'
                ) as migrator_select,
                has_table_privilege(
                  'kf_migrator', 'core.action_migration019_legacy', 'INSERT'
                ) as migrator_insert,
                has_table_privilege(
                  'kf_backup', 'core.action_migration019_legacy', 'SELECT'
                ) as backup_select,
                exists (
                  select 1 from pg_constraint constraint_row
                   where constraint_row.conrelid = 'core.action'::regclass
                     and constraint_row.conname = 'action_target_ids_canonical'
                     and constraint_row.convalidated
                ) as canonical_constraint,
                (select count(*)::text from core.action_migration019_legacy) as rows
           from pg_class class
          where class.oid = 'core.action_migration019_legacy'::regclass`,
      ),
    );
    expect(authority).toEqual({
      row_security: true,
      force_row_security: true,
      app_select: true,
      app_insert: false,
      migrator_select: true,
      migrator_insert: true,
      backup_select: true,
      canonical_constraint: true,
      rows: '0',
    });

    const migratorVisibility = await withTransaction(pool!, async (tx) => {
      await tx.query('set local role kf_migrator');
      return tx.one<{ rows: string }>(
        'select count(*)::text as rows from core.action_migration019_legacy',
      );
    });
    expect(migratorVisibility.rows).toBe('0');
  });

  it('makes audit digest timestamps losslessly representable on the shared wire', async () => {
    const constraints = await withTransaction(pool!, (tx) =>
      tx.query<{ table_name: string; constraint_name: string; validated: boolean }>(
        `select class.relname as table_name, constraint_row.conname as constraint_name,
                constraint_row.convalidated as validated
           from pg_constraint constraint_row
           join pg_class class on class.oid = constraint_row.conrelid
           join pg_namespace namespace on namespace.oid = class.relnamespace
          where namespace.nspname = 'core'
            and constraint_row.conname in (
              'action_effective_at_canonical_wire',
              'audit_event_effective_at_canonical_wire'
            )
          order by class.relname`,
      ),
    );
    expect(constraints).toEqual([
      {
        table_name: 'action',
        constraint_name: 'action_effective_at_canonical_wire',
        validated: true,
      },
      {
        table_name: 'audit_event',
        constraint_name: 'audit_event_effective_at_canonical_wire',
        validated: true,
      },
    ]);

    const chainHead = await withTransaction(pool!, (tx) =>
      tx.one<{
        seq: string;
        digest: string;
        trigger_enabled: string;
        app_digest_select: boolean;
        app_seq_select: boolean;
      }>(
        `select head.seq::text, head.digest,
                (
                  select trigger.tgenabled
                    from pg_trigger trigger
                   where trigger.tgrelid = 'core.audit_event'::regclass
                     and trigger.tgname = 'audit_event_global_chain_head'
                ) as trigger_enabled,
                has_column_privilege(
                  'kf_app', 'core.audit_chain_head', 'digest', 'SELECT'
                ) as app_digest_select,
                has_column_privilege(
                  'kf_app', 'core.audit_chain_head', 'seq', 'SELECT'
                ) as app_seq_select
           from core.audit_chain_head head`,
      ),
    );
    expect(chainHead).toEqual({
      seq: '0',
      digest: '0'.repeat(64),
      trigger_enabled: 'O',
      app_digest_select: true,
      app_seq_select: false,
    });
  });

  it('compares transaction identity at one width, so wraparound cannot silently stop writes', async () => {
    // Several authority functions refuse a caller who replays an already-committed action id
    // as fresh mutation authority, by requiring the action row to have been born in THIS
    // transaction. Written as `xmin::text = pg_current_xact_id()::text`, that test compares a
    // 32-bit xid against a 64-bit xid8 carrying an epoch: the text forms agree only while the
    // epoch is zero, and after the first wraparound the comparison can never hold again.
    //
    // Fail-closed — nothing leaks and nothing is forged, the subsystem simply stops, at a
    // moment nobody chose. A count is the honest assertion: the property is "no function does
    // this", and naming the three that used to would let a fourth appear unnoticed.
    const offenders = await withTransaction(pool!, async (tx) =>
      tx.query<{ fn: string }>(
        `select namespace.nspname || '.' || routine.proname as fn
           from pg_proc routine
           join pg_namespace namespace on namespace.oid = routine.pronamespace
          where routine.prosrc like '%xmin::text%'
          order by 1`,
      ),
    );
    expect(offenders.map((row) => row.fn)).toEqual([]);

    // And the replacement still discriminates, rather than being a cast that always matches:
    // true for a row written in this transaction, false for one that was not.
    const bornHere = await withTransaction(pool!, async (tx) => {
      await tx.query('create temporary table kf_xid_probe (id integer) on commit drop');
      await tx.query('insert into kf_xid_probe (id) values (1)');
      return tx.one<{ same: boolean }>(
        'select probe.xmin = pg_current_xact_id()::xid as same from kf_xid_probe probe',
      );
    });
    expect(bornHere.same).toBe(true);

    const bornEarlier = await withTransaction(pool!, async (tx) =>
      tx.one<{ same: boolean }>(
        `select relation.xmin = pg_current_xact_id()::xid as same
           from pg_class relation
          where relation.oid = 'core.object'::regclass`,
      ),
    );
    expect(bornEarlier.same).toBe(false);
  });
});
