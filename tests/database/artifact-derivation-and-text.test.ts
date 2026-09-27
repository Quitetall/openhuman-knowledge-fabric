import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryObjectStore, digestOf } from '@kf/artifacts';
import { withTransaction } from '@kf/database';
import {
  atomsFromPandoc,
  createDocumentActionAtoms,
  documentConversionLossDigest,
  documentProjectionDigest,
  type DocumentParser,
} from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
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
 * A file's text reaches search, and a derived file names what it came from (2026-09-24).
 *
 *   1. `search.text_for` indexes an ARTIFACT's newest parsed text, not only its title
 *      (20260926000100). Until then every `kf ingest` / `POST /ingest` file was found by title
 *      alone although `attach_evidence` had parsed it in the same act.
 *   2. `attach_evidence` accepts `derived_from`: the artifact this one was made from — here an
 *      extracted text and the PDF it came out of. The edge is drawn by the act, and the named
 *      artifact must be one the actor can READ: an artifact they are not granted, a record that is
 *      not an artifact, or an id that names nothing are all the same refusal, and nothing is
 *      written.
 *
 * What this does not cover: how good the extracted text is, or which parser produced it. The
 * text here is a fixture; the corpus extraction is fixtures/veracier/extract-text.mjs.
 */

let harness: Harness;
let fixtures: Fixtures;
let capped: { personId: string; assignmentId: string };

const store = new InMemoryObjectStore();

/** A parser that reads text/plain as one paragraph per line, and declines everything else. */
const parser: DocumentParser = {
  async parse(bytes, mediaType) {
    if (mediaType !== 'text/plain') return undefined;
    const lines = bytes
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    const atoms = atomsFromPandoc({
      'pandoc-api-version': [1, 23, 1],
      blocks: lines.map((line) => ({
        t: 'Para',
        c: line
          .trim()
          .split(/\s+/)
          .flatMap((word, index) =>
            index === 0 ? [{ t: 'Str', c: word }] : [{ t: 'Space' }, { t: 'Str', c: word }],
          ),
      })),
    });
    const claims = atoms.map(({ digest: _digest, ...claim }) => claim);
    return {
      parser: 'test-parser',
      parserVersion: '1',
      projectionContract: 'test.atoms.v1',
      sourceDigest: digestOf(bytes),
      atoms,
      conversionLoss: [],
      lossDigest: documentConversionLossDigest([]),
      contentDigest: documentProjectionDigest('test.atoms.v1', claims, []),
    };
  },
};

const execute = () =>
  createFabricDispatcher(harness.pool, createDocumentActionAtoms({ store, parser }));

async function attach(
  actor: { actorId: string; actingRoleId: string },
  key: string,
  bytes: Buffer,
  mediaType: string,
  extra: Record<string, unknown> = {},
) {
  const sha256 = digestOf(bytes);
  const storageUri = `ingest/${fixtures.organizationId}/${sha256}`;
  await store.put(storageUri, bytes, mediaType);
  return execute()({
    ...actor,
    organizationId: fixtures.organizationId,
    maxClassification: 'restricted',
    targetIds: [],
    actionType: 'attach_evidence',
    idempotencyKey: key,
    payload: {
      title: key,
      artifact_kind: 'document',
      classification: 'internal',
      sha256,
      size_bytes: bytes.length,
      media_type: mediaType,
      storage_uri: storageUri,
      ...extra,
    },
  });
}

const reviewer = () => ({ actorId: fixtures.reviewerId, actingRoleId: fixtures.reviewerRoleId });

beforeAll(async () => {
  harness = await startHarness();
  fixtures = await seedFixtures(harness.adminPool);
  // A person whose role reads only `public` organization-wide: cleared for more, granted nothing.
  const personId = await createObject(harness.adminPool, fixtures, {
    type: 'person',
    domain: 'organization',
    state: 'active',
    title: 'Capped reader',
    createdBy: fixtures.reviewerId,
  });
  const assignmentId = await createObject(harness.adminPool, fixtures, {
    type: 'role_assignment',
    domain: 'organization',
    state: 'active',
    title: 'performer assignment (capped)',
    createdBy: fixtures.reviewerId,
  });
  await withTransaction(harness.adminPool, async (tx) => {
    await bindContext(tx, fixtures, fixtures.reviewerId);
    await tx.query('insert into org.person (id, display_name, organization) values ($1, $2, $3)', [
      personId,
      'Capped reader',
      fixtures.organizationId,
    ]);
    await tx.query(
      `insert into org.person_clearance
         (subject_id, organization_id, max_classification, granted_by, granted_by_action, reason)
       values ($1, $2, 'restricted', $3, $4, 'fixture clearance for the capped reader')`,
      [personId, fixtures.organizationId, fixtures.reviewerId, fixtures.clearanceActionId],
    );
    await tx.query(
      `insert into org.role_assignment
         (id, subject_id, role_id, scope_id, classification_ceiling, valid_to)
       values ($1, $2, 'performer', $3, 'public', now() + interval '300 days')`,
      [assignmentId, personId, fixtures.organizationId],
    );
  });
  capped = { personId, assignmentId };
}, 180_000);

afterAll(async () => {
  await harness?.stop();
});

async function derivations(artifactId: string) {
  return withTransaction(harness.pool, async (tx) => {
    await bindReader(tx, fixtures, fixtures.reviewerId);
    return tx.query<{ target_id: string; authorizing_action: string | null }>(
      `select target_id, authorizing_action from core.relation
        where source_id = $1 and relation_type = 'derived_from'`,
      [artifactId],
    );
  });
}

describe('an artifact is found by its text, and a derived artifact names its source', () => {
  it('indexes the artifact by its parsed text, and draws derived_from under the act', async () => {
    const pdf = await attach(
      reviewer(),
      'veracier-pdf-0001',
      Buffer.from('%PDF-1.4 scanned bytes, no text layer'),
      'application/pdf',
    );
    const pdfId = pdf.objectIds[0]!;
    const text = await attach(
      reviewer(),
      'veracier-text-0001',
      Buffer.from(
        'Rapport de non-conformite\nPorosite interne detectee par controle ultrasonore\n',
      ),
      'text/plain',
      { derived_from: pdfId },
    );
    const textId = text.objectIds[0]!;

    expect(await derivations(textId)).toEqual([
      { target_id: pdfId, authorizing_action: text.actionId },
    ]);

    // The worker re-indexes what an act touched; here the same function is called directly.
    const hits = await withTransaction(harness.pool, async (tx) => {
      await bindReader(tx, fixtures, fixtures.reviewerId);
      await tx.query('select search.index_object($1)', [textId]);
      await tx.query('select search.index_object($1)', [pdfId]);
      return tx.query<{ object_id: string }>(
        `select object_id from search.document
          where document @@ websearch_to_tsquery('english', 'ultrasonore porosite')
          order by object_id`,
      );
    });
    // The text is found by what it says; the PDF, which has no parse, by its title only.
    expect(hits.map((row) => row.object_id)).toEqual([textId]);

    // A replay records nothing twice.
    const replay = await attach(
      reviewer(),
      'veracier-text-0001',
      Buffer.from(
        'Rapport de non-conformite\nPorosite interne detectee par controle ultrasonore\n',
      ),
      'text/plain',
      { derived_from: pdfId },
    );
    expect(replay.replayed).toBe(true);
    expect(await derivations(textId)).toHaveLength(1);
  });

  it('refuses derived_from naming an artifact the actor is not granted, and writes nothing', async () => {
    const source = await attach(
      reviewer(),
      'veracier-pdf-0002',
      Buffer.from('%PDF-1.4 an internal source'),
      'application/pdf',
    );
    const sourceId = source.objectIds[0]!;
    const asCapped = { actorId: capped.personId, actingRoleId: capped.assignmentId };
    const bytes = Buffer.from('texte extrait du document interne\n');
    await expect(
      attach(asCapped, 'veracier-text-0002', bytes, 'text/plain', {
        derived_from: sourceId,
        classification: 'public',
      }),
    ).rejects.toMatchObject({ failure: 'precondition_failed' });
    const leftover = await withTransaction(harness.adminPool, (tx) =>
      tx.query('select 1 from core.action where idempotency_key = $1', ['veracier-text-0002']),
    );
    expect(leftover).toHaveLength(0);

    // Granted, the same act is accepted: it was the grant that decided, not the shape.
    await execute()({
      ...reviewer(),
      organizationId: fixtures.organizationId,
      maxClassification: 'restricted',
      targetIds: [sourceId],
      actionType: 'grant_access',
      idempotencyKey: 'veracier-grant-0002',
      reason: 'the capped reader transcribes this document',
      payload: { principal_kind: 'person', principal_id: capped.personId, capability: 'read' },
    });
    const accepted = await attach(asCapped, 'veracier-text-0002', bytes, 'text/plain', {
      derived_from: sourceId,
      classification: 'public',
    });
    expect(await derivations(accepted.objectIds[0]!)).toEqual([
      { target_id: sourceId, authorizing_action: accepted.actionId },
    ]);
  });

  it('refuses derived_from naming a record that is not an artifact, one that does not exist, or not a uuid', async () => {
    const decision = await createObject(harness.adminPool, fixtures, {
      type: 'decision_record',
      domain: 'engineering',
      state: 'draft',
      title: 'Not an artifact',
      createdBy: fixtures.reviewerId,
    });
    for (const [key, derivedFrom] of [
      ['veracier-text-0003', decision],
      ['veracier-text-0004', 'not-a-uuid'],
      ['veracier-text-0005', '01950000-0000-7000-8000-00000000ffff'],
    ] as const) {
      await expect(
        attach(reviewer(), key, Buffer.from(`${key}\n`), 'text/plain', {
          derived_from: derivedFrom,
        }),
      ).rejects.toMatchObject({ failure: 'precondition_failed' });
    }
  });
});
