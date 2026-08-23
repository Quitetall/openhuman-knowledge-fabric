/**
 * Moving a policy predicate into a function must not move the security boundary.
 *
 * `20260822000200_composition_input_visibility_function.sql` takes the `composition_input_scope`
 * predicate out of the policy and puts the identical expression inside a PL/pgSQL function, to
 * stop PostgreSQL inlining six recursive policy chains into every calling query. The whole claim
 * is "same rows, different plan", and that claim is worth exactly as much as the evidence that
 * the rows really are the same.
 *
 * There are TWO checks here, and the second exists because the first cannot fail on its own.
 *
 * 1. ROW-LEVEL, before against after. The harness starts at the schema version BEFORE the
 *    migration, records what is visible from a matrix of access contexts, applies the migration to
 *    that same live database, and records again. Real rows, real policy, real drift detection.
 *
 * 2. DIFFERENTIAL, function against the predicate it replaced. Necessary because check 1 is blind
 *    to the entire `CASE`. `add_document_composition` enforces KF-DOC-CLASS-002 — "composition
 *    classification must be at least its highest visible input" — and
 *    `content.authored_fragment_revision` is append-only, so no referent can be created above its
 *    composition or reclassified above it later. Every referent is therefore at least as visible
 *    as its parent, the leading `exists(composition_revision)` decides every row by itself, and
 *    the six branches never change a visible row. No fixture makes them observable through the
 *    policy.
 *
 *    That is measured, not argued: a defect planted in the function — `return true` straight after
 *    the parent check, discarding the whole CASE — passed check 1 and both of its controls. So the
 *    branches are compared directly against the original predicate, lifted verbatim out of the
 *    bytes of `20260814000100_document_compiler.sql` rather than retyped, over argument tuples
 *    including referents that do not exist. A retyped reference can be wrong in the same way twice
 *    and agree with itself; the file cannot.
 *
 * Both checks were confirmed able to fail, by planting the `return true` above and, separately, by
 * dropping the `composition` branch. All five `input_role` branches reach the differential check;
 * `binding` and `generated_view` are exercised on their false side only, since typed_binding and
 * compiled_view rows come from the Liminal compiler and standing it up here would test the
 * compiler rather than the predicate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore, digestOf } from '@kf/artifacts';
import { digest } from '@kf/canonicalization';
import { createPool, setAccessContext, withTransaction, type Pool } from '@kf/database';
import { atomsFromPandoc, createDocumentActionAtoms, type DocumentParser } from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { seedFixtures, startHarness, type Fixtures, type Harness } from './harness.js';

const MIGRATION = '20260822000200_composition_input_visibility_function.sql';

let harness: Harness;
let fixtures: Fixtures;

/** One row of the matrix: what a given access context can see. */
interface Visible {
  readonly label: string;
  readonly rows: readonly string[];
}

let before: readonly Visible[];
let after: readonly Visible[];
let subplansBefore: number;
let subplansAfter: number;

const parentRevisionId = '01950000-0000-7000-8000-0000000e0006';
/** Real ids, so the differential matrix can exercise the TRUE side of each branch too. */
let referents: {
  compositionRevisionId: string;
  fragmentRevisionId: string;
  childCompositionRevisionId: string;
  resourceVersionId: string;
};

/**
 * The predicate this migration replaced, lifted verbatim out of the migration that created it.
 *
 * Extracted rather than retyped, and that is the whole point: a hand-copied "reference" can be
 * wrong in exactly the same way as the thing it is checking and agree with itself. This reads the
 * bytes that defined the policy before today.
 */
function originalPredicate(): string {
  const source = readFileSync(
    join(process.cwd(), 'database/migrations/20260814000100_document_compiler.sql'),
    'utf8',
  );
  const at = source.indexOf('create policy composition_input_scope on content.composition_input');
  if (at < 0) throw new Error('composition_input_scope is no longer in its original migration');
  const open = source.indexOf('using (', at) + 'using ('.length;
  const close = source.indexOf(')\n  with check (', open);
  if (open < 'using ('.length || close < 0) {
    throw new Error('could not lift the using(...) expression; the migration text moved');
  }
  const expression = source.slice(open, close).trim();
  // Guard the extraction itself: if this ever silently grabs the wrong span, the differential
  // test below would compare the function against nonsense and pass.
  if (!expression.includes('case input_role') || !expression.includes('generated_view')) {
    throw new Error(`lifted the wrong span: ${expression.slice(0, 120)}`);
  }
  return expression;
}

/**
 * Contexts chosen to straddle the boundary rather than sit safely inside it. The composition and
 * its fragment are `internal`, so a `public` ceiling must hide them and an `internal` one must
 * not — which is what makes an unconditional `true` fail this.
 */
const CONTEXTS = [
  { label: 'own org, restricted ceiling', maxClassification: 'restricted' as const },
  { label: 'own org, internal ceiling', maxClassification: 'internal' as const },
  { label: 'own org, public ceiling', maxClassification: 'public' as const },
];

async function snapshot(pool: Pool, organizationId: string): Promise<readonly Visible[]> {
  const out: Visible[] = [];
  for (const context of CONTEXTS) {
    const rows = await withTransaction(pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId,
        maxClassification: context.maxClassification,
      });
      return tx.query<{ key: string }>(
        `select composition_revision_id || ':' || ordinal || ':' || input_role as key
           from content.composition_input
          order by composition_revision_id, ordinal`,
      );
    });
    out.push({ label: context.label, rows: rows.map((r) => r.key) });
  }
  // No access context at all. Nothing should be visible; this is the case that catches a
  // predicate accidentally made unconditional.
  const unscoped = await withTransaction(pool, (tx) =>
    tx.query<{ key: string }>(
      `select composition_revision_id || ':' || ordinal || ':' || input_role as key
         from content.composition_input
        order by composition_revision_id, ordinal`,
    ),
  );
  out.push({ label: 'no access context', rows: unscoped.map((r) => r.key) });
  return out;
}

/**
 * How many subplans the planner emits for one `count(*)`.
 *
 * Asserted instead of a duration because it is the thing that actually changed: the inlining.
 * A wall-clock bound on a machine running 33 PostgreSQL containers is a flake generator, and
 * this repository has already paid for that lesson once (#156).
 */
async function subplanCount(pool: Pool, organizationId: string): Promise<number> {
  const lines = await withTransaction(pool, async (tx) => {
    await setAccessContext(tx, { organizationId, maxClassification: 'restricted' });
    return tx.query<Record<string, string>>(
      'explain (costs off) select count(*) from content.composition_input',
    );
  });
  const text = lines.map((line) => Object.values(line)[0] ?? '').join('\n');
  return (text.match(/SubPlan \d+/g) ?? []).length;
}

beforeAll(async () => {
  harness = await startHarness({ skipMigrations: new Set([MIGRATION]) });
  fixtures = await seedFixtures(harness.adminPool);

  // Build real composition_input rows through the action dispatcher rather than by hand, so the
  // rows and their parents satisfy every constraint the writer path enforces. The parser is
  // inline and synthetic: this test is about a policy, and shelling out to pandoc would make it
  // about pandoc.
  const store = new InMemoryObjectStore();
  const parser: DocumentParser = {
    async parse(sourceBytes) {
      const atoms = atomsFromPandoc({
        'pandoc-api-version': [1, 23, 1],
        blocks: [{ t: 'Header', c: [1, ['h', [], []], [{ t: 'Str', c: 'H' }]] }],
      });
      const atomClaims = atoms.map(({ digest: _digest, ...claim }) => claim);
      return {
        parser: 'test-parser',
        parserVersion: '1',
        projectionContract: 'test.atoms.v1',
        sourceDigest: digestOf(sourceBytes),
        atoms,
        conversionLoss: [],
        lossDigest: digest([]),
        contentDigest: digest({
          projectionContract: 'test.atoms.v1',
          atoms: atomClaims,
          conversionLoss: [],
        }),
      };
    },
  };
  const execute = createFabricDispatcher(
    harness.pool,
    createDocumentActionAtoms({ store, parser }),
  );
  const caller = {
    actorId: fixtures.reviewerId,
    actingRoleId: fixtures.reviewerRoleId,
    organizationId: fixtures.organizationId,
    maxClassification: 'restricted',
    targetIds: [],
  } as const;

  const attach = async (
    key: string,
    bytes: Buffer,
    mediaType: string,
    title: string,
  ): Promise<string> => {
    const sha256 = digestOf(bytes);
    await store.put(`document-imports/${sha256}`, bytes, mediaType);
    const artifact = await execute({
      ...caller,
      actionType: 'attach_evidence',
      idempotencyKey: key,
      payload: {
        title,
        artifact_kind: 'specification',
        sha256,
        size_bytes: bytes.length,
        media_type: mediaType,
        storage_uri: `document-imports/${sha256}`,
        revision_label: 'R01',
      },
    });
    return withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      return (
        await tx.one<{ id: string }>(
          'select id from content.artifact_version where artifact_id = $1',
          [artifact.objectIds[0]],
        )
      ).id;
    });
  };

  const fragmentVersionId = await attach(
    'equiv-fragment-artifact',
    Buffer.from('# H\n'),
    'text/markdown',
    'fragment.md',
  );
  const resourceVersionId = await attach(
    'equiv-resource-artifact',
    Buffer.from('resource bytes'),
    'application/octet-stream',
    'resource.bin',
  );
  const manifestVersionId = await attach(
    'equiv-manifest-artifact',
    Buffer.from(JSON.stringify([{ documentNumber: 'OH-DOC-EQV-001', revision: 'R01' }])),
    'application/json',
    'manifest.json',
  );
  const childManifestVersionId = await attach(
    'equiv-child-manifest-artifact',
    Buffer.from(JSON.stringify([{ documentNumber: 'OH-DOC-EQV-002', revision: 'R01' }])),
    'application/json',
    'child-manifest.json',
  );

  const fragmentRevisionId = '01950000-0000-7000-8000-0000000e0002';
  await execute({
    ...caller,
    actionType: 'add_authored_fragment',
    idempotencyKey: 'equiv-fragment',
    payload: {
      title: 'Equivalence fragment',
      stable_key: 'equivalence.fragment',
      holder_id: '01950000-0000-7000-8000-0000000e0001',
      holder: {
        kind: 'fabric_native',
        artifact_version_id: fragmentVersionId,
        content_digest: digestOf(Buffer.from('# H\n')),
      },
      revision_id: fragmentRevisionId,
      media_type: 'text/markdown',
      classification: 'internal',
      document_policy: 'ordinary',
    },
  });

  // A referent classified ABOVE its composition, and the single most important row in this
  // fixture. Without it the CASE branches are never load-bearing: every other input's referent is
  // exactly as visible as its parent composition_revision, so the leading
  // `exists(composition_revision)` check alone decides the outcome and the six branches could
  // return anything at all without changing a single visible row.
  //
  // That is not hypothetical. The first version of this test lacked this row, and a planted
  // defect that made the predicate return TRUE for every row whose parent was visible passed all
  // four assertions. This row is what makes the branch result observable: at an `internal`
  // ceiling its parent composition is visible while this fragment revision is not, so the input
  // row must be hidden BY THE BRANCH.
  const restrictedFragmentRevisionId = '01950000-0000-7000-8000-0000000e0008';
  await execute({
    ...caller,
    actionType: 'add_authored_fragment',
    idempotencyKey: 'equiv-restricted-fragment',
    payload: {
      title: 'Equivalence restricted fragment',
      stable_key: 'equivalence.restricted-fragment',
      holder_id: '01950000-0000-7000-8000-0000000e0007',
      holder: {
        kind: 'fabric_native',
        artifact_version_id: fragmentVersionId,
        content_digest: digestOf(Buffer.from('# H\n')),
      },
      revision_id: restrictedFragmentRevisionId,
      media_type: 'text/markdown',
      classification: 'internal',
      document_policy: 'ordinary',
    },
  });

  // Child composition first, so the parent can reference its revision through the `composition`
  // branch of the CASE.
  const childRevisionId = '01950000-0000-7000-8000-0000000e0004';
  await execute({
    ...caller,
    actionType: 'add_document_composition',
    idempotencyKey: 'equiv-child-composition',
    payload: {
      title: 'Equivalence child composition',
      stable_key: 'equivalence.child-composition',
      holder_id: '01950000-0000-7000-8000-0000000e0003',
      holder: {
        kind: 'fabric_native',
        artifact_version_id: childManifestVersionId,
        content_digest: digestOf(
          Buffer.from(JSON.stringify([{ documentNumber: 'OH-DOC-EQV-002', revision: 'R01' }])),
        ),
      },
      revision_id: childRevisionId,
      classification: 'internal',
      document_policy: 'ordinary',
      inputs: [{ ordinal: 1, role: 'fragment', fragment_revision_id: fragmentRevisionId }],
    },
  });

  await execute({
    ...caller,
    actionType: 'add_document_composition',
    idempotencyKey: 'equiv-parent-composition',
    payload: {
      title: 'Equivalence parent composition',
      stable_key: 'equivalence.parent-composition',
      holder_id: '01950000-0000-7000-8000-0000000e0005',
      holder: {
        kind: 'fabric_native',
        artifact_version_id: manifestVersionId,
        content_digest: digestOf(
          Buffer.from(JSON.stringify([{ documentNumber: 'OH-DOC-EQV-001', revision: 'R01' }])),
        ),
      },
      revision_id: parentRevisionId,
      classification: 'internal',
      document_policy: 'ordinary',
      inputs: [
        { ordinal: 1, role: 'fragment', fragment_revision_id: fragmentRevisionId },
        {
          ordinal: 2,
          role: 'resource',
          resource_version_id: resourceVersionId,
          content_digest: digestOf(Buffer.from('resource bytes')),
        },
        // `composition_revision_id` in the payload, not `child_composition_revision_id`: the
        // action names the referent, and the COLUMN it lands in is the child pointer.
        { ordinal: 3, role: 'composition', composition_revision_id: childRevisionId },
        { ordinal: 4, role: 'fragment', fragment_revision_id: restrictedFragmentRevisionId },
      ],
    },
  });

  referents = {
    compositionRevisionId: parentRevisionId,
    fragmentRevisionId,
    childCompositionRevisionId: childRevisionId,
    resourceVersionId,
  };

  before = await snapshot(harness.pool, fixtures.organizationId);
  subplansBefore = await subplanCount(harness.pool, fixtures.organizationId);

  // Apply the migration under test to this same live database.
  const sql = readFileSync(join(process.cwd(), 'database/migrations', MIGRATION), 'utf8');
  const up = sql.slice(
    sql.indexOf('-- migrate:up') + '-- migrate:up'.length,
    sql.indexOf('-- migrate:down'),
  );
  await withTransaction(harness.adminPool, (tx) => tx.query(up));

  after = await snapshot(harness.pool, fixtures.organizationId);
  subplansAfter = await subplanCount(harness.pool, fixtures.organizationId);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

describe('moving the composition_input predicate into a function', () => {
  it('exercised a visible row and a hidden one — otherwise the comparison proves nothing', () => {
    const visible = before.filter((entry) => entry.rows.length > 0);
    const hidden = before.filter((entry) => entry.rows.length === 0);

    expect(
      visible.map((entry) => entry.label),
      'no context could see any composition_input row, so an always-false predicate would pass',
    ).not.toHaveLength(0);
    expect(
      hidden.map((entry) => entry.label),
      'every context saw everything, so an always-true predicate would pass',
    ).not.toHaveLength(0);

    // The rows that exist at all: four inputs on the parent, one on the child.
    expect(visible[0]!.rows.length).toBeGreaterThanOrEqual(5);
    expect(before.at(-1)).toEqual({ label: 'no access context', rows: [] });
  });

  it('agrees with the original predicate on every branch, including the false side', async () => {
    // WHY THIS EXISTS, and it is the most important comment in the file.
    //
    // The row-level comparison above cannot see the CASE at all. `add_document_composition`
    // enforces KF-DOC-CLASS-002 — "composition classification must be at least its highest
    // visible input" — and `content.authored_fragment_revision` is append-only, so a referent can
    // neither be created above its composition nor reclassified above it afterwards. Every
    // referent is therefore at least as visible as its parent, which means the leading
    // `exists(composition_revision)` decides the outcome on its own and the six branches never
    // change a visible row. There is no fixture, reachable or contrived, that makes them
    // observable through the policy.
    //
    // That is not a theory. A defect planted in the function — `return true` immediately after
    // the parent check, discarding the entire CASE — passed the row-level comparison and both of
    // its controls. A security equivalence test that cannot fail is worse than none.
    //
    // So the branches are checked directly instead: the function against the predicate it
    // replaced, lifted out of the 2026-08-14 migration's own bytes, over argument tuples that
    // include referents which do not exist. Both are evaluated as the app role with an access
    // context set, so RLS applies inside both.
    const expression = originalPredicate();
    const missing = '01950000-0000-7000-8000-0000000effff';
    const tuples: readonly (readonly [string, ...(string | null)[]])[] = [
      // [label, composition_revision, role, fragment, child, resource, binding, view]
      [
        'fragment, present',
        referents.compositionRevisionId,
        'fragment',
        referents.fragmentRevisionId,
        null,
        null,
        null,
        null,
      ],
      [
        'fragment, missing',
        referents.compositionRevisionId,
        'fragment',
        missing,
        null,
        null,
        null,
        null,
      ],
      [
        'composition, present',
        referents.compositionRevisionId,
        'composition',
        null,
        referents.childCompositionRevisionId,
        null,
        null,
        null,
      ],
      [
        'composition, missing',
        referents.compositionRevisionId,
        'composition',
        null,
        missing,
        null,
        null,
        null,
      ],
      [
        'resource, present',
        referents.compositionRevisionId,
        'resource',
        null,
        null,
        referents.resourceVersionId,
        null,
        null,
      ],
      [
        'resource, missing',
        referents.compositionRevisionId,
        'resource',
        null,
        null,
        missing,
        null,
        null,
      ],
      [
        'binding, missing',
        referents.compositionRevisionId,
        'binding',
        null,
        null,
        null,
        missing,
        null,
      ],
      [
        'generated_view, missing',
        referents.compositionRevisionId,
        'generated_view',
        null,
        null,
        null,
        null,
        missing,
      ],
      [
        'unknown role',
        referents.compositionRevisionId,
        'not_a_role',
        referents.fragmentRevisionId,
        null,
        null,
        null,
        null,
      ],
      [
        'null role',
        referents.compositionRevisionId,
        null,
        referents.fragmentRevisionId,
        null,
        null,
        null,
        null,
      ],
      ['parent missing', missing, 'fragment', referents.fragmentRevisionId, null, null, null, null],
      ['parent null', null, 'fragment', referents.fragmentRevisionId, null, null, null, null],
      ['all null', null, null, null, null, null, null, null],
    ];

    const compared = await withTransaction(harness.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: fixtures.organizationId,
        maxClassification: 'restricted',
      });
      const out: { label: string; original: boolean | null; replacement: boolean | null }[] = [];
      for (const [label, ...args] of tuples) {
        const row = await tx.one<{ original: boolean | null; replacement: boolean | null }>(
          `select (${expression}) as original,
                  content.composition_input_visible(
                    composition_revision_id, input_role, fragment_revision_id,
                    child_composition_revision_id, resource_version_id, binding_id,
                    compiled_view_id) as replacement
             from (select $1::uuid as composition_revision_id,
                          $2::text as input_role,
                          $3::uuid as fragment_revision_id,
                          $4::uuid as child_composition_revision_id,
                          $5::uuid as resource_version_id,
                          $6::uuid as binding_id,
                          $7::uuid as compiled_view_id) as composition_input`,
          args,
        );
        out.push({ label, original: row.original, replacement: row.replacement });
      }
      return out;
    });

    for (const row of compared) {
      expect(row.replacement, `${row.label}: replacement disagrees with the original`).toBe(
        row.original,
      );
    }

    // Controls. Both outcomes must appear, or the agreement is agreement about nothing — and at
    // least one TRUE has to come from a branch rather than from the parent check alone.
    expect(compared.some((row) => row.original === true)).toBe(true);
    expect(compared.some((row) => row.original === false)).toBe(true);
    expect(compared.find((row) => row.label === 'fragment, present')?.original).toBe(true);
    expect(compared.find((row) => row.label === 'fragment, missing')?.original).toBe(false);
  });

  it('shows every access context exactly the rows it saw before', () => {
    expect(after).toEqual(before);
  });

  it('covers the fragment, resource and composition branches of the CASE', () => {
    const roles = new Set(before.flatMap((entry) => entry.rows.map((key) => key.split(':')[2]!)));
    expect([...roles].sort()).toEqual(['composition', 'fragment', 'resource']);
  });

  it('does not leak one access context into the next on a reused connection', async () => {
    // The one way a function could differ from an inline predicate and still look correct
    // everywhere else, so it is tested rather than reasoned about.
    //
    // PL/pgSQL caches its statements' plans per SESSION, and switches to a generic plan after a
    // handful of executions. The queries inside this function read RLS-protected tables whose
    // policies depend on `kf.organization` and the classification ceiling — session GUCs that
    // `core.set_access_context` rewrites per transaction. If any of that were folded into a
    // cached generic plan, a pooled connection would serve one caller's rows to the next caller,
    // which is the worst failure this change could possibly have and would be invisible to every
    // other test in this file: they each use a fresh context on a pool of five connections.
    //
    // maxConnections: 1 pins every query to ONE backend, and the loop runs well past the
    // generic-plan threshold, alternating a ceiling that sees the rows with one that must not.
    //
    // Shown able to fail by swapping the function to SECURITY DEFINER — the alternative design
    // ADR 0007 rejects. The body then runs as the owner, RLS inside it is bypassed, visibility
    // stops tracking the caller, and this reports `a public round saw rows: 5,5,5,5,5,5,5,5`.
    // That makes SECURITY INVOKER an observed property rather than an asserted one.
    const appUri = new URL(harness.connectionString);
    appUri.username = 'kf_app_login';
    appUri.password = 'test-only-not-a-secret';
    const single = createPool({ connectionString: appUri.toString(), maxConnections: 1 });
    try {
      const seen: { ceiling: string; count: number }[] = [];
      for (let round = 0; round < 8; round += 1) {
        for (const ceiling of ['restricted', 'public'] as const) {
          const rows = await withTransaction(single, async (tx) => {
            await setAccessContext(tx, {
              organizationId: fixtures.organizationId,
              maxClassification: ceiling,
            });
            return tx.query<{ key: string }>(
              'select ordinal::text as key from content.composition_input',
            );
          });
          seen.push({ ceiling, count: rows.length });
        }
      }

      // Every `restricted` round sees the same non-zero set; every `public` round sees nothing.
      // A stale plan shows up as a `public` round inheriting the previous `restricted` count.
      const restricted = seen.filter((s) => s.ceiling === 'restricted').map((s) => s.count);
      const publicOnly = seen.filter((s) => s.ceiling === 'public').map((s) => s.count);
      expect(new Set(restricted).size, `restricted rounds drifted: ${restricted.join(',')}`).toBe(
        1,
      );
      expect(restricted[0]).toBeGreaterThan(0);
      expect(publicOnly, `a public round saw rows: ${publicOnly.join(',')}`).toEqual(
        publicOnly.map(() => 0),
      );
    } finally {
      await single.end();
    }
  });

  it('stops the planner inlining the recursive policy chains', () => {
    // The measured shape, not a duration.
    //
    // Counting DISTINCT `SubPlan N` mentions in the plan. Worth being precise about, because the
    // first thing I wrote about this defect said "1300+ subplans" on the strength of seeing
    // `SubPlan 1306` in an EXPLAIN. That number is the planner's global subplan COUNTER, not a
    // count of subplans in the plan — it counts work done during planning, including subplans
    // that never reach the final tree. Both are symptoms of the same blowup, but only one of
    // them is a thing you can count in the output.
    //
    // Measured: 74 here, 37 on the dev database, 0 after the migration on both. Zero is the
    // honest bound for `after` — the predicate becomes a single opaque function call, so there
    // is nothing left for the planner to expand.
    expect(subplansBefore).toBeGreaterThan(20);
    expect(subplansAfter).toBe(0);
  });
});
