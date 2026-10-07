/**
 * Qualification is evidence against a versioned pack — in the database (ADR 0038; SAS §24A,
 * KF-SAS-RQ-254 to RQ-261; 20261007400000; KF-WAR-0007 OBL-001 to OBL-005).
 *
 * Every act goes through the real fabric dispatcher on the application login, attested as
 * kf-attestor attests. The packs are the Véracier fixture's (`fixtures/veracier/qualification.mjs`),
 * built over records this harness creates, with the harness's roles as their authorities.
 *
 * First a persona is walked from assignment to qualified, through the five stages, to a first
 * Warrant credited as evidence. Then ADR 0038's "How we will know" table, one planted case per
 * row. Then each guard is FALSIFIED: dropped inside a transaction, the forbidden thing happens,
 * so the assertion that it does not is an assertion about the guard and not about the setup.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionRejected, type ActionRequest, type ActionResult } from '@kf/actions';
import type { JsonValue } from '@kf/canonicalization';
import {
  attestationFor,
  issueAttestation,
  withTransaction,
  type Principal,
  type Tx,
} from '@kf/database';
import { createFabricDispatcher } from '@kf/orchestrator';
import {
  agentGuideContext,
  loadRecordEvaluation,
  startHere,
  startHereIsGenerated,
  type PackDocument,
  type RecordEvaluation,
} from '@kf/qualification';
import { runDeclareAgent } from '../../apps/api/src/admin/declare-agent.js';
import {
  AERO,
  CEO,
  COMMON,
  KEYS,
  veracierPacks,
  type VeracierPacks,
} from '../../fixtures/veracier/qualification.mjs';
import {
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from './harness.js';
import { enrolPerson, fixtureProject } from './people.js';

const ROOT = join(import.meta.dirname, '..', '..');
const AGENT = 'joining-guide-agent';

let h: Harness;
let f: Fixtures;
let execute: ReturnType<typeof createFabricDispatcher>;

interface Person {
  readonly id: string;
  readonly role: string;
}
const P: Record<'reviewer' | 'quality' | 'lucie' | 'ben' | 'dana' | 'cara' | 'outsider', Person> =
  {} as never;

interface Resources {
  readonly overview: string;
  readonly procedures: string;
  readonly ncrExample: string;
  readonly authorityMatrix: string;
  readonly av3000: string;
  readonly otherProgramme: string;
}
let R: Resources;
let packs: VeracierPacks;
const packIds: Record<string, string> = {};

const principal = (p: Person): Principal => ({
  actorId: p.id,
  actingRoleId: p.role,
  organizationId: f.organizationId,
  maxClassification: 'restricted',
});

const attest = (p: Person, agent?: string): Promise<string> =>
  withTransaction(h.attestorPool, (tx) =>
    issueAttestation(
      tx,
      principal(p),
      undefined,
      agent === undefined
        ? { authorizedParty: 'knowledge-fabric-web' }
        : { agentClientId: agent, authorizedParty: agent },
    ),
  );

async function act(
  p: Person,
  actionType: string,
  targetIds: readonly string[],
  payload: Record<string, JsonValue> = {},
  options: { reason?: string; agent?: string } = {},
): Promise<ActionResult> {
  const request: ActionRequest = {
    actionType,
    targetIds,
    payload,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    idempotencyKey: `qualification-${randomUUID()}`,
    ...principal(p),
    attestation: await attest(p, options.agent),
  };
  return execute(request);
}

/** The refusal an act met, as every surface receives it. */
async function refusal(promise: Promise<unknown>): Promise<ActionRejected> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ActionRejected) return error;
    throw error;
  }
  throw new Error('expected a refusal; the act was applied');
}

/** Read as a person, bound exactly as a read route binds them. */
async function asReader<T>(p: Person, read: (tx: Tx) => Promise<T>): Promise<T> {
  return withTransaction(h.pool, async (tx) => {
    await tx.query('select core.bind_principal($1, $2, $3, $4, $5)', [
      p.id,
      p.role,
      f.organizationId,
      'restricted',
      (await attestationFor(tx, principal(p))) ?? null,
    ]);
    return read(tx);
  });
}

const evaluate = (p: Person, recordId: string): Promise<RecordEvaluation | undefined> =>
  asReader(p, (tx) => loadRecordEvaluation(tx, recordId));

const statusOf = (evaluation: RecordEvaluation | undefined, key: string) =>
  evaluation?.requirements.find((r) => r.key === key)?.status;

async function warrant(p: Person, title: string): Promise<string> {
  const { id } = await withTransaction(h.adminPool, (tx) =>
    tx.one<{ id: string }>('select uuidv7()::text as id'),
  );
  const result = await act(p, 'create_warrant_draft', [], {
    warrant_uuid: id,
    repository: 'veracier',
    title,
    profile: 'delivery',
    assurance_level: 'controlled',
  });
  expect(result.objectIds).toEqual([id]);
  return id;
}

async function draftAndApprove(document: PackDocument): Promise<string> {
  const drafted = await act(P.reviewer, 'draft_qualification_pack', [], {
    document: document as unknown as JsonValue,
  });
  const packId = String(drafted.receipt?.['packId']);
  await act(P.reviewer, 'approve_qualification_pack', [packId]);
  packIds[document.key] = packId;
  return packId;
}

async function assign(
  person: Person,
  packKey: string,
  scope: string | null,
  contact: Person = P.reviewer,
): Promise<string> {
  const result = await act(P.reviewer, 'assign_qualification', [], {
    person_id: person.id,
    pack_id: packIds[packKey]!,
    contact_person_id: contact.id,
    ...(scope === null ? {} : { scope_object_id: scope }),
  });
  return String(result.receipt?.['recordId']);
}

const credit = (
  by: Person,
  recordId: string,
  credits: readonly Record<string, JsonValue>[],
  actionType:
    'credit_qualification_evidence' | 'accept_qualification' = 'credit_qualification_evidence',
  agent?: string,
) =>
  act(
    by,
    actionType,
    [recordId],
    { credits: credits as unknown as JsonValue },
    {
      ...(agent === undefined ? {} : { agent }),
    },
  );

const submit = async (
  person: Person,
  recordId: string,
  requirementKey: string,
  evidence: string,
  agent?: string,
): Promise<string> => {
  const result = await act(
    person,
    'submit_qualification_evidence',
    [recordId],
    { requirement_key: requirementKey, evidence_object_id: evidence },
    agent === undefined ? {} : { agent },
  );
  const row = await withTransaction(h.adminPool, (tx) =>
    tx.one<{ id: string }>(
      'select id from org.qualification_evidence_submission where submitted_by_action = $1',
      [result.actionId],
    ),
  );
  return row.id;
};

/** Wait out the individual-review pace (20260924000300) between two reviews by one verifier. */
const pastThePace = () => new Promise((resolve) => setTimeout(resolve, 1_100));

async function revision(objectId: string): Promise<string> {
  const row = await withTransaction(h.adminPool, (tx) =>
    tx.one<{ row_version: string }>('select row_version::text from core.object where id = $1', [
      objectId,
    ]),
  );
  return row.row_version;
}

function revise(document: PackDocument, key: string, behavioural: boolean): PackDocument {
  return {
    ...document,
    revision: document.revision + 1,
    requirements: document.requirements.map((r) =>
      r.key === key
        ? {
            ...r,
            revision: r.revision + 1,
            behavioural_impact: behavioural,
            outcome: `${r.outcome} (revision ${String(r.revision + 1)})`,
          }
        : r,
    ),
  };
}

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  execute = createFabricDispatcher(h.pool);
  await runDeclareAgent(h.adminPool, {
    clientId: AGENT,
    declaredBy: f.reviewerId,
    reason: 'the joining guide under test',
    withdraw: false,
  });

  const project = await fixtureProject(h.adminPool, f, 'A project the newcomer is scoped to');
  const enrol = async (name: string, role: string, scopeId?: string): Promise<Person> => {
    const enrolled = await enrolPerson(h.adminPool, f, {
      name,
      assignments: [{ role, ...(scopeId === undefined ? {} : { scopeId }) }],
    });
    return { id: enrolled.personId, role: enrolled.assignmentIds[0]! };
  };
  Object.assign(P, {
    reviewer: { id: f.reviewerId, role: f.reviewerRoleId },
    quality: await enrol('Karim Quality', 'quality_authority'),
    lucie: await enrol('Lucie Garnier', 'performer'),
    ben: await enrol('Ben Aero', 'performer'),
    cara: await enrol('Cara Executive', 'project_owner'),
    // Granted one project only: the organization's records are not hers to read.
    dana: await enrol('Dana Newcomer', 'performer', project),
    outsider: { id: f.performerId, role: f.performerRoleId },
  });

  const make = (type: string, domain: string, state: string, title: string) =>
    createObject(h.adminPool, f, { type, domain, state, title, createdBy: f.reviewerId });
  R = {
    overview: await make('initiative_project', 'project', 'captured', 'Véracier at a glance'),
    procedures: await make('controlled_document', 'qms', 'draft', 'Group procedures index'),
    ncrExample: await make('initiative_project', 'project', 'captured', 'A raised NCR, annotated'),
    authorityMatrix: await make('controlled_document', 'qms', 'draft', 'Authority matrix'),
    av3000: await fixtureProject(h.adminPool, f, 'AV-3000 servo-valve programme'),
    otherProgramme: await fixtureProject(h.adminPool, f, 'NuSafe VP-200 programme'),
  };
  const ref = async (id: string) => ({ id, revision: await revision(id) });
  packs = veracierPacks({
    resources: {
      overview: await ref(R.overview),
      procedures: await ref(R.procedures),
      ncrExample: await ref(R.ncrExample),
      authorityMatrix: await ref(R.authorityMatrix),
      programme: await ref(R.av3000),
    },
    scope: { av3000: R.av3000 },
    roles: {
      owner: 'technical_authority',
      quality: 'quality_authority',
      executive: 'project_owner',
    },
  });
  await draftAndApprove(packs.common);
  await draftAndApprove(packs.ceo);
  await draftAndApprove(packs.aero);
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

let lucieAero: string;
let lucieWork: string;

describe('a persona walks from assignment to qualified, through the five stages', () => {
  it('starts with every requirement open, on a generated Start Here', async () => {
    lucieAero = await assign(P.lucie, AERO, R.av3000);
    const evaluation = await evaluate(P.lucie, lucieAero);
    expect(evaluation?.record.state).toBe('assigned');
    const page = startHere(evaluation!);
    expect(page.stages.map((s) => s.title)).toEqual([
      'Read-In',
      'Role Read-In',
      'References',
      'Execution',
      'First Contribution',
    ]);
    // The common part and the aero pack's own, composed: the scope requirement applies because
    // her record is for AV-3000.
    expect(page.missing).toEqual(
      [
        KEYS.readIn,
        KEYS.references,
        KEYS.ncr,
        KEYS.firstContribution,
        KEYS.programme,
        KEYS.containment,
      ].sort(),
    );
    expect(page.stages.flatMap((s) => s.items).every((i) => i.status === 'open')).toBe(true);
    // Generated, never edited: regenerated from the record, it is the page she was shown.
    expect(startHereIsGenerated(page)).toBe(true);
    expect(startHere((await evaluate(P.lucie, lucieAero))!).digest).toBe(page.digest);
    // The guide is given the page and the closed list of what it may do; it starts at Read-In.
    const guide = agentGuideContext(page);
    expect(guide.next[0]?.key).toBe(KEYS.readIn);
    expect(guide.acts).toEqual(['submit_qualification_evidence']);
    expect(guide.mayNot).toContain('credit_evidence');
    expect(page.contact.personId).toBe(P.reviewer.id);
  });

  it('acknowledges the read-in herself; nobody else has to', async () => {
    await credit(P.lucie, lucieAero, [
      { requirement_key: KEYS.readIn, evidence_object_id: R.overview },
      { requirement_key: KEYS.programme, evidence_object_id: R.av3000 },
    ]);
    const evaluation = await evaluate(P.lucie, lucieAero);
    expect(statusOf(evaluation, KEYS.readIn)).toBe('satisfied');
    expect(statusOf(evaluation, KEYS.programme)).toBe('satisfied');
  });

  it('locates the references in real work; the contact credits both in one act', async () => {
    const located = await warrant(P.lucie, 'Cite VER procedures for bench 2 rework');
    const references = await submit(P.lucie, lucieAero, KEYS.references, located);
    // Her agent may assemble and submit for her: it credits nothing.
    const ncr = await submit(P.lucie, lucieAero, KEYS.ncr, located, AGENT);
    expect(statusOf(await evaluate(P.lucie, lucieAero), KEYS.ncr)).toBe('submitted');
    await credit(P.reviewer, lucieAero, [{ submission_id: references }, { submission_id: ncr }]);
    const evaluation = await evaluate(P.lucie, lucieAero);
    expect(statusOf(evaluation, KEYS.references)).toBe('satisfied');
    expect(statusOf(evaluation, KEYS.ncr)).toBe('satisfied');
    // The contact's act accepted the work it credited: one individual review, by them, in it.
    const verification = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ verified_by: string; basis: string }>(
        'select verified_by, basis from core.object_verification where object_id = $1',
        [located],
      ),
    );
    expect(verification).toEqual({ verified_by: P.reviewer.id, basis: 'reviewed_individually' });
  });

  it('a first Warrant evidences two requirements, each by its own authority, and closes the record in the act that credits the last', async () => {
    lucieWork = await warrant(P.lucie, 'Rework bench 2 fixture, AV-3000 lot 0312');
    const containment = await submit(P.lucie, lucieAero, KEYS.containment, lucieWork);
    const first = await submit(P.lucie, lucieAero, KEYS.firstContribution, lucieWork);
    await pastThePace();
    // Containment is the quality authority's to credit; accepting the Warrant is part of it.
    await credit(P.quality, lucieAero, [{ submission_id: containment }]);
    // The contact credits the last requirement and the record closes, in ONE act.
    const before = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ n: string }>(
        `select count(*)::text as n from core.action where $1 = any(target_ids)`,
        [lucieAero],
      ),
    );
    const accepted = await credit(
      P.reviewer,
      lucieAero,
      [{ submission_id: first }],
      'accept_qualification',
    );
    expect(accepted.receipt?.['credits']).toEqual([
      expect.objectContaining({ requirementKey: KEYS.firstContribution, mode: 'demonstrate' }),
    ]);
    const after = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ n: string }>(
        `select count(*)::text as n from core.action where $1 = any(target_ids)`,
        [lucieAero],
      ),
    );
    expect(Number(after.n) - Number(before.n)).toBe(1);
    const evaluation = await evaluate(P.lucie, lucieAero);
    expect(evaluation?.record.state).toBe('qualified');
    expect(evaluation?.complete).toBe(true);
    expect(evaluation?.currency).toBe('qualified');
  });
});

describe('ADR 0038\'s "How we will know", one planted case per row', () => {
  it('a new role: a pack is added and no code changes', async () => {
    // A third pack, written here as data: an inspector composes the common part and adds one
    // requirement of its own. Nothing outside this test names it.
    const inspector: PackDocument = {
      format: 'kf-qualification-pack-v1',
      key: 'veracier.goods-inward-inspector',
      revision: 1,
      title: 'Véracier — goods-inward inspector',
      owner: 'role:technical_authority',
      closing: 'on_evidence',
      parts: { common: [{ pack: COMMON, revision: 1 }] },
      requirements: [
        {
          key: 'veracier.inspector.receiving',
          revision: 1,
          part: 'role',
          stage: 'role_read_in',
          outcome: 'Knows the receiving procedure and where incoming certificates are filed.',
          evidence_mode: 'locate',
          accepted_by: 'contact',
          mandatory: true,
          consequence: {
            kind: 'unsafe',
            statement: 'A lot received without its certificate checked enters production.',
          },
          resources: [
            {
              id: R.procedures,
              revision: await revision(R.procedures),
              authority_class: 'normative',
            },
          ],
          equivalent_to: [KEYS.references],
        },
      ],
    };
    await draftAndApprove(inspector);
    const record = await assign(P.ben, inspector.key, null);
    const page = startHere((await evaluate(P.ben, record))!);
    expect(page.stages.find((s) => s.id === 'role_read_in')?.items.map((i) => i.key)).toEqual([
      'veracier.inspector.receiving',
    ]);
    const source = execFileSync(
      'bash',
      [
        '-c',
        "grep -rl 'goods-inward-inspector' packages apps --include='*.ts' --include='*.tsx' --exclude-dir=dist --exclude-dir=node_modules --exclude-dir=.next* || true",
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(source.trim()).toBe('');
  });

  it('two packs sharing a requirement: it is satisfied once', async () => {
    // Lucie, qualified as an aero engineer, takes the CEO pack (a promotion): the common part is
    // the same requirements, already credited, and only the CEO's own remain.
    const promotion = await assign(P.lucie, CEO, null);
    const evaluation = await evaluate(P.lucie, promotion);
    for (const key of [KEYS.readIn, KEYS.references, KEYS.ncr, KEYS.firstContribution]) {
      expect(statusOf(evaluation, key)).toBe('satisfied');
    }
    expect(evaluation?.missing).toEqual([KEYS.authorityMatrix]);
    // Composition holds each shared requirement once.
    const rows = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ requirement_key: string }>(
        `select requirement_key from org.qualification_pack_requirement where pack_id = $1`,
        [packIds[CEO]!],
      ),
    );
    expect(new Set(rows.map((r) => r.requirement_key)).size).toBe(rows.length);
  });

  it('existing accepted evidence meeting a requirement: credited without repeating the work', async () => {
    const promotion = (
      await withTransaction(h.adminPool, (tx) =>
        tx.one<{ id: string }>(
          `select id from org.qualification_record where person_id = $1 and pack_id = $2`,
          [P.lucie.id, packIds[CEO]!],
        ),
      )
    ).id;
    const counts = () =>
      withTransaction(h.adminPool, (tx) =>
        tx.one<{ objects: string; verifications: string }>(
          `select (select count(*) from core.object)::text as objects,
                  (select count(*) from core.object_verification)::text as verifications`,
        ),
      );
    const before = await counts();
    // Her accepted first Warrant also shows a CAPA plan approved properly: the quality authority
    // maps it, and nothing is made, uploaded or reviewed again.
    await credit(P.quality, promotion, [
      { requirement_key: KEYS.capaPlan, evidence_object_id: lucieWork },
    ]);
    expect(await counts()).toEqual(before);
    expect(statusOf(await evaluate(P.lucie, promotion), KEYS.capaPlan)).toBe('satisfied');

    // An equivalent requirement is credited from the existing credit, at the same mode only.
    const inspectorRecord = await assign(P.lucie, 'veracier.goods-inward-inspector', null);
    const references = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ id: string }>(
        `select id from org.qualification_credit where person_id = $1 and requirement_key = $2`,
        [P.lucie.id, KEYS.references],
      ),
    );
    await credit(P.reviewer, inspectorRecord, [
      { requirement_key: 'veracier.inspector.receiving', prior_credit_id: references.id },
    ]);
    expect(statusOf(await evaluate(P.lucie, inspectorRecord), 'veracier.inspector.receiving')).toBe(
      'satisfied',
    );
    // A credit of a requirement the pack does not declare equivalent is not evidence of it.
    const readIn = await withTransaction(h.adminPool, (tx) =>
      tx.one<{ id: string }>(
        `select id from org.qualification_credit where person_id = $1 and requirement_key = $2`,
        [P.lucie.id, KEYS.readIn],
      ),
    );
    const refused = await refusal(
      credit(P.reviewer, inspectorRecord, [
        { requirement_key: 'veracier.inspector.receiving', prior_credit_id: readIn.id },
      ]),
    );
    expect(refused.detail['rule']).toBe('KF-QUAL-016');
  });

  it('a person qualified for the baseline and not a specialized requirement: the baseline act succeeds and the specialized one is refused, naming it', async () => {
    const record = await assign(P.ben, AERO, R.otherProgramme);
    const located = await warrant(P.ben, 'Locate the NCR route for the NuSafe bench');
    await pastThePace();
    await credit(P.reviewer, record, [{ requirement_key: KEYS.ncr, evidence_object_id: located }]);
    const raised = await act(P.ben, 'raise_nonconformity', [], {
      title: 'Seal extrusion on NuSafe bench valve',
      severity: 'minor',
      description: 'Extruded O-ring found at teardown.',
    });
    const nc = raised.objectIds[0]!;
    const refused = await refusal(
      act(P.ben, 'contain_nonconformity', [nc], { containment: 'Lot segregated in cage 4' }),
    );
    expect(refused.failure).toBe('precondition_failed');
    expect(refused.detail).toMatchObject({ rule: 'KF-QUAL-001', requirement: KEYS.containment });
    expect(refused.message).toContain(KEYS.containment);
    // The same act by someone credited for it goes through: the check is the requirement.
    await act(P.lucie, 'contain_nonconformity', [nc], { containment: 'Lot segregated in cage 4' });
  });

  it('a mandatory resource that is inaccessible: the organization’s blocker and the contact, not a failure', async () => {
    const record = await assign(P.dana, AERO, R.av3000);
    const evaluation = await evaluate(P.dana, record);
    const readIn = evaluation?.requirements.find((r) => r.key === KEYS.readIn);
    expect(readIn?.status).toBe('blocked_on_organization');
    expect(readIn?.blockers).toEqual([{ kind: 'resource_not_granted', resourceId: R.overview }]);
    expect(evaluation?.blocked).toContain(KEYS.readIn);
    const page = startHere(evaluation!);
    expect(page.contact).toEqual({ personId: P.reviewer.id, name: expect.any(String) });
    // She cannot acknowledge what she was not given: that would record the gap as hers.
    const refused = await refusal(
      credit(P.dana, record, [{ requirement_key: KEYS.readIn, evidence_object_id: R.overview }]),
    );
    expect(refused.detail['rule']).toBe('KF-QUAL-017');
    // The organization fixes it; the blocker goes, and the requirement is simply open.
    await act(
      P.reviewer,
      'grant_access',
      [R.overview],
      { principal_kind: 'person', principal_id: P.dana.id, capability: 'read' },
      { reason: 'Every newcomer reads the overview' },
    );
    expect(statusOf(await evaluate(P.dana, record), KEYS.readIn)).toBe('open');
  });

  it('a reviewer nobody can be: blocked on the organization', async () => {
    const orphan: PackDocument = {
      format: 'kf-qualification-pack-v1',
      key: 'veracier.design-review',
      revision: 1,
      title: 'Véracier — design review',
      owner: 'role:technical_authority',
      closing: 'on_evidence',
      requirements: [
        {
          key: 'veracier.design.review',
          revision: 1,
          part: 'role',
          stage: 'execution',
          outcome: 'Has led one design review to its recorded decision.',
          evidence_mode: 'demonstrate',
          accepted_by: 'role:design_authority',
          mandatory: true,
          consequence: {
            kind: 'unreliable',
            statement: 'A design review nobody led decides nothing.',
          },
        },
      ],
    };
    await draftAndApprove(orphan);
    const record = await assign(P.cara, orphan.key, null);
    const evaluation = await evaluate(P.cara, record);
    expect(evaluation?.requirements[0]).toMatchObject({
      status: 'blocked_on_organization',
      blockers: [{ kind: 'reviewer_unavailable', authority: 'role:design_authority' }],
    });
  });

  it('every requirement evidenced through accepted work: the record closes with no second approval — and not before', async () => {
    const record = await assign(P.cara, AERO, R.av3000);
    const refused = await refusal(act(P.reviewer, 'accept_qualification', [record]));
    expect(refused.detail['rule']).toBe('KF-QUAL-020');
    expect(refused.message).toContain(KEYS.readIn);
    expect(
      (
        await withTransaction(h.adminPool, (tx) =>
          tx.one<{ lifecycle_state: string }>(
            'select lifecycle_state from core.object where id = $1',
            [record],
          ),
        )
      ).lifecycle_state,
    ).toBe('assigned');
  });

  it('an unrelated document revision changes no status', async () => {
    const qualifiedBefore = await evaluate(P.lucie, lucieAero);
    // A clarification of the containment requirement: revision 2, no behavioural impact.
    packs = { ...packs, aero: revise(packs.aero, KEYS.containment, false) };
    await act(
      P.reviewer,
      'supersede_qualification_pack',
      [packIds[AERO]!],
      { document: packs.aero as unknown as JsonValue },
      { reason: 'Containment wording clarified; no step added' },
    );
    const after = await evaluate(P.lucie, lucieAero);
    expect(after?.currency).toBe('qualified');
    expect(after?.gaps).toEqual([]);
    expect(after?.requirements.map((r) => r.status)).toEqual(
      qualifiedBefore?.requirements.map((r) => r.status),
    );
    // And the act it gates still goes through.
    const nc = (
      await act(P.lucie, 'raise_nonconformity', [], {
        title: 'Burr on port A',
        severity: 'minor',
        description: 'Burr at port A chamfer.',
      })
    ).objectIds[0]!;
    await act(P.lucie, 'contain_nonconformity', [nc], { containment: 'Parts quarantined' });
  });

  it('a behavioural revision of one requirement: exactly the affected people gain exactly that gap', async () => {
    // Ben qualifies on containment too, for a programme the scope requirement does not touch.
    const benRecord = (
      await withTransaction(h.adminPool, (tx) =>
        tx.one<{ id: string }>(
          `select id from org.qualification_record where person_id = $1 and pack_id = $2`,
          [P.ben.id, packIds[AERO]!],
        ),
      )
    ).id;
    const benWork = await warrant(P.ben, 'Contain NuSafe bench lot');
    await pastThePace();
    await credit(P.quality, benRecord, [
      { requirement_key: KEYS.containment, evidence_object_id: benWork },
    ]);
    const ceoRecord = (
      await withTransaction(h.adminPool, (tx) =>
        tx.one<{ id: string }>(
          `select id from org.qualification_record where person_id = $1 and pack_id = $2`,
          [P.lucie.id, packIds[CEO]!],
        ),
      )
    ).id;
    const before = {
      lucie: await evaluate(P.lucie, lucieAero),
      ben: await evaluate(P.ben, benRecord),
      ceo: await evaluate(P.lucie, ceoRecord),
    };
    expect(before.lucie?.gaps).toEqual([]);
    expect(before.ben?.gaps).toEqual([]);

    // The AV-3000 programme requirement changes required behaviour: a scope requirement.
    packs = { ...packs, aero: revise(packs.aero, KEYS.programme, true) };
    await act(
      P.reviewer,
      'supersede_qualification_pack',
      [packIds[AERO]!],
      { document: packs.aero as unknown as JsonValue },
      { reason: 'AV-3000 programme: new customer finding every engineer must know' },
    );
    const after = {
      lucie: await evaluate(P.lucie, lucieAero),
      ben: await evaluate(P.ben, benRecord),
      ceo: await evaluate(P.lucie, ceoRecord),
    };
    // Lucie is on AV-3000: exactly that gap. Ben is not: none. Her CEO record: none.
    expect(after.lucie?.gaps).toEqual([KEYS.programme]);
    expect(after.lucie?.currency).toBe('qualified_with_gap');
    expect(after.lucie?.record.state).toBe('qualified');
    expect(after.ben?.gaps).toEqual([]);
    expect(after.ceo?.gaps).toEqual([]);

    // Containment now changes behaviour: both aero people gain that gap, and only the act it
    // gates is restricted — the baseline act still goes through.
    packs = { ...packs, aero: revise(packs.aero, KEYS.containment, true) };
    await act(
      P.reviewer,
      'supersede_qualification_pack',
      [packIds[AERO]!],
      { document: packs.aero as unknown as JsonValue },
      { reason: 'Containment now tags each affected part' },
    );
    expect((await evaluate(P.lucie, lucieAero))?.gaps).toEqual(
      [KEYS.containment, KEYS.programme].sort(),
    );
    expect((await evaluate(P.ben, benRecord))?.gaps).toEqual([KEYS.containment]);
    expect((await evaluate(P.lucie, ceoRecord))?.gaps).toEqual([]);
    const nc = (
      await act(P.lucie, 'raise_nonconformity', [], {
        title: 'Port C thread damage',
        severity: 'minor',
        description: 'Thread damage at port C.',
      })
    ).objectIds[0]!;
    const refused = await refusal(
      act(P.lucie, 'contain_nonconformity', [nc], { containment: 'Quarantined' }),
    );
    expect(refused.detail).toMatchObject({ rule: 'KF-QUAL-001', requirement: KEYS.containment });
    expect(refused.message).toMatch(/predates a revision that changed required behaviour/);
  });

  it('an absent grant: qualification does not bypass it', async () => {
    // Dana holds a project-scoped assignment: no act authority over the organization. She is
    // credited for the CAPA requirement and still may not approve a plan.
    const record = await assign(P.dana, CEO, null);
    const work = await warrant(P.dana, 'CAPA plan review, bench 2');
    await pastThePace();
    await credit(P.quality, record, [{ requirement_key: KEYS.capaPlan, evidence_object_id: work }]);
    const capa = (
      await act(P.reviewer, 'open_capa', [], {
        title: 'Recurring burrs on port A',
        capa_kind: 'corrective',
        problem_statement: 'Burrs recur at port A.',
        effectiveness_criterion: 'No burr on three consecutive lots.',
      })
    ).objectIds[0]!;
    const noGrant = await refusal(act(P.dana, 'approve_capa_plan', [capa], {}));
    expect(noGrant.failure).toBe('act_not_granted');
    // The reviewer holds the grant and lacks the qualification: refused for that.
    const noCredit = await refusal(act(P.reviewer, 'approve_capa_plan', [capa], {}));
    expect(noCredit.detail).toMatchObject({ rule: 'KF-QUAL-001', requirement: KEYS.capaPlan });
  });
});

describe('the rules hold in the database', () => {
  it('a reviewer does not credit their own qualification, or work they made (KF-SAS-RQ-047)', async () => {
    const own = await assign(P.quality, AERO, null);
    const theirs = await warrant(P.quality, 'Containment of my own lot');
    await pastThePace();
    const refused = await refusal(
      credit(P.quality, own, [{ requirement_key: KEYS.containment, evidence_object_id: theirs }]),
    );
    expect(refused.detail['rule']).toBe('KF-QUAL-015');
    // Work the reviewer made is not credited to someone else by the same reviewer either.
    const benRecord = (
      await withTransaction(h.adminPool, (tx) =>
        tx.one<{ id: string }>(
          `select id from org.qualification_record where person_id = $1 and pack_id = $2`,
          [P.ben.id, packIds[AERO]!],
        ),
      )
    ).id;
    const byReviewer = await refusal(
      credit(P.quality, benRecord, [
        { requirement_key: KEYS.programme, evidence_object_id: theirs },
      ]),
    );
    expect(['KF-QUAL-015', 'KF-QUAL-014']).toContain(byReviewer.detail['rule']);
  });

  it('a credit needs the authority the requirement names (KF-QUAL-014)', async () => {
    const record = await assign(P.cara, CEO, null);
    const work = await warrant(P.lucie, 'Unrelated work by someone else');
    const refused = await refusal(
      credit(P.reviewer, record, [{ requirement_key: KEYS.capaPlan, evidence_object_id: work }]),
    );
    expect(refused.detail['rule']).toBe('KF-QUAL-014');
  });

  it('an assistant never credits or accepts; it may submit for its person (KF-QUAL-011)', async () => {
    const record = (
      await withTransaction(h.adminPool, (tx) =>
        tx.one<{ id: string }>(
          `select id from org.qualification_record where person_id = $1 and pack_id = $2`,
          [P.cara.id, packIds[AERO]!],
        ),
      )
    ).id;
    const refused = await refusal(
      credit(
        P.reviewer,
        record,
        [{ requirement_key: KEYS.readIn, evidence_object_id: R.overview }],
        'credit_qualification_evidence',
        AGENT,
      ),
    );
    expect(refused.detail['rule']).toBe('KF-QUAL-011');
  });

  it('an acknowledgement is never demonstrated: a credit carries its requirement’s mode (RQ-256)', async () => {
    const rows = await withTransaction(h.adminPool, (tx) =>
      tx.query<{ requirement_key: string; evidence_mode: string }>(
        `select c.requirement_key, c.evidence_mode from org.qualification_credit c
          where c.person_id = $1 order by 1`,
        [P.lucie.id],
      ),
    );
    expect(rows.find((r) => r.requirement_key === KEYS.readIn)?.evidence_mode).toBe('acknowledge');
    expect(rows.find((r) => r.requirement_key === KEYS.firstContribution)?.evidence_mode).toBe(
      'demonstrate',
    );
  });

  it('a record is confidential to its person, contact and reviewers (decision 12)', async () => {
    const outsider = await evaluate(P.outsider, lucieAero);
    expect(outsider).toBeUndefined();
    const seen = await asReader(P.outsider, (tx) =>
      tx.query<{ n: string }>(
        `select (select count(*) from org.qualification_credit where person_id = $1)::text as n`,
        [P.lucie.id],
      ),
    );
    expect(seen[0]?.n).toBe('0');
    // The envelope says the scope and the state: eligibility, through the ordinary path.
    const envelope = await asReader(P.outsider, (tx) =>
      tx.maybeOne<{ lifecycle_state: string }>(
        'select lifecycle_state from core.object where id = $1',
        [lucieAero],
      ),
    );
    expect(envelope?.lifecycle_state).toBe('qualified');
    // Her contact and the quality reviewer read it.
    expect(await evaluate(P.reviewer, lucieAero)).toBeDefined();
    expect(await evaluate(P.quality, lucieAero)).toBeDefined();
  });

  it('a pack document is refused for duplicates, missing owners, consequences and scripts', async () => {
    const bad = {
      ...packs.common,
      key: 'veracier.bad',
      owner: undefined,
      extends: 'veracier.common',
      requirements: [
        { ...packs.common.requirements[0]!, consequence: undefined },
        packs.common.requirements[0]!,
      ],
    };
    const refused = await refusal(
      act(P.reviewer, 'draft_qualification_pack', [], { document: bad as unknown as JsonValue }),
    );
    expect(refused.detail['rule']).toBe('KF-QUAL-050');
    const codes = (refused.detail['problems'] as { code: string }[]).map((p) => p.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'missing_owner',
        'unknown_key',
        'mandatory_without_consequence',
        'duplicate_requirement',
      ]),
    );
    // A requirement that gates an act which does not declare requires_qualification gates
    // nothing, and is refused as such.
    const ungated = {
      ...packs.common,
      key: 'veracier.ungated',
      requirements: [
        { ...packs.common.requirements[2]!, key: 'veracier.ungated.x', gates: ['verify_record'] },
      ],
    };
    const refusedGate = await refusal(
      act(P.reviewer, 'draft_qualification_pack', [], {
        document: ungated as unknown as JsonValue,
      }),
    );
    expect((refusedGate.detail['problems'] as { code: string }[]).map((p) => p.code)).toContain(
      'ungated_action',
    );
  });

  it('an invitation is the owner’s act, never the application’s (KF-QUAL-040)', async () => {
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query('select core.bind_principal($1, $2, $3, $4, $5)', [
          P.reviewer.id,
          P.reviewer.role,
          f.organizationId,
          'restricted',
          (await attestationFor(tx, principal(P.reviewer))) ?? null,
        ]);
        await tx.query(
          `insert into org.invitation (organization_id, person_id, token_digest, invited_by,
                                       invited_by_action, expires_at)
           values ($1, $2, $3, $4, $5, now() + interval '7 days')`,
          [f.organizationId, P.dana.id, 'a'.repeat(64), P.reviewer.id, randomUUID()],
        );
      }),
    ).rejects.toThrow(/permission denied|KF-QUAL-040/);
  });
});

/**
 * A direct write as a bound person, under an act recorded in the transaction: what a caller that
 * skipped the dispatcher could do. Always rolled back; resolves to `'written'` when every
 * statement went in.
 */
async function directly(
  p: Person,
  actionType: string,
  targetIds: readonly string[],
): Promise<'written'> {
  try {
    await withTransaction(h.pool, async (tx) => {
      await tx.query('select core.bind_principal($1, $2, $3, $4, $5)', [
        p.id,
        p.role,
        f.organizationId,
        'restricted',
        (await attestationFor(tx, principal(p))) ?? null,
      ]);
      const actionId = randomUUID();
      await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
        p.id,
        p.role,
        actionId,
        'qualification-direct-write',
      ]);
      await tx.query(
        `insert into core.action
           (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
            target_ids, idempotency_key, effective_at, reason, result_status)
         values ($1::uuid, $2::uuid, encode(sha256(convert_to($1::text, 'UTF8')), 'hex'), $3,
                 $4::uuid, $5::uuid, $6::uuid[], 'direct-' || $1::text,
                 date_trunc('milliseconds', now() + interval '999 microseconds'),
                 'a direct write under test', 'applied')`,
        [actionId, f.organizationId, actionType, p.id, p.role, targetIds],
      );
      throw new Error('ROLLBACK-OK');
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'ROLLBACK-OK') return 'written';
    throw error;
  }
  throw new Error('unreachable');
}

describe('every guard falsified: dropped, the forbidden thing happens', () => {
  /** Apply `ddl` for real, run `body`, and put the guard back from the migration's definition. */
  async function without(ddl: string, body: () => Promise<void>): Promise<void> {
    const [drop, restore] = ddl.split('||');
    await withTransaction(h.adminPool, (tx) => tx.query(drop!));
    try {
      await body();
    } finally {
      await withTransaction(h.adminPool, (tx) => tx.query(restore!));
    }
  }

  const caraAero = () =>
    withTransaction(h.adminPool, (tx) =>
      tx.one<{ id: string }>(
        `select id from org.qualification_record where person_id = $1 and pack_id = $2`,
        [P.cara.id, packIds[AERO]!],
      ),
    ).then((row) => row.id);

  it('without the act check, an act its requirement gates is recorded for someone lacking it', async () => {
    const nc = (
      await act(P.lucie, 'raise_nonconformity', [], {
        title: 'Port D scratch',
        severity: 'minor',
        description: 'Scratch at port D.',
      })
    ).objectIds[0]!;
    // Cara holds no containment credit: a caller that skipped the dispatcher is refused too.
    await expect(directly(P.cara, 'contain_nonconformity', [nc])).rejects.toThrow(/KF-QUAL-001/);
    await without(
      'drop trigger action_requires_qualification on core.action||' +
        'create trigger action_requires_qualification before insert on core.action ' +
        'for each row execute function core.action_requires_qualification()',
      async () => {
        expect(await directly(P.cara, 'contain_nonconformity', [nc])).toBe('written');
        // The dispatcher's own check still refuses: two controls, each falsified on its own.
        const refused = await refusal(
          act(P.cara, 'contain_nonconformity', [nc], { containment: 'Quarantined' }),
        );
        expect(refused.detail['rule']).toBe('KF-QUAL-001');
      },
    );
    await expect(directly(P.cara, 'contain_nonconformity', [nc])).rejects.toThrow(/KF-QUAL-001/);
  });

  it('without the credit rules, a reviewer with no authority credits a requirement', async () => {
    const record = await caraAero();
    const work = await warrant(P.lucie, 'Someone else’s contained lot');
    await pastThePace();
    const credits = [{ requirement_key: KEYS.containment, evidence_object_id: work }];
    expect((await refusal(credit(P.reviewer, record, credits))).detail['rule']).toBe('KF-QUAL-014');
    await without(
      'drop trigger qualification_credit_bounded on org.qualification_credit||' +
        'create trigger qualification_credit_bounded before insert or update or delete on ' +
        'org.qualification_credit for each row execute function org.qualification_credit_bounded()',
      async () => {
        const result = await credit(P.reviewer, record, credits);
        // Credited by the technical authority, for a requirement only the quality authority
        // credits, against work nobody accepted: what the trigger exists to refuse.
        expect(result.receipt?.['credits']).toEqual([
          expect.objectContaining({ requirementKey: KEYS.containment }),
        ]);
        await withTransaction(h.adminPool, (tx) =>
          tx.query('delete from org.qualification_credit where credited_by_action = $1', [
            result.actionId,
          ]),
        );
      },
    );
  });

  it('without the closing check, an incomplete record is accepted', async () => {
    const record = await caraAero();
    expect((await refusal(act(P.reviewer, 'accept_qualification', [record]))).detail['rule']).toBe(
      'KF-QUAL-020',
    );
    await without(
      'drop trigger qualification_record_closes on core.object||' +
        'create constraint trigger qualification_record_closes after update on core.object ' +
        'deferrable initially deferred for each row ' +
        "when (new.object_type = 'qualification_record' and new.lifecycle_state = 'qualified' " +
        'and old.lifecycle_state is distinct from new.lifecycle_state) ' +
        'execute function org.qualification_record_closes()',
      async () => {
        await act(P.reviewer, 'accept_qualification', [record]);
        const state = await withTransaction(h.adminPool, (tx) =>
          tx.one<{ lifecycle_state: string }>(
            'select lifecycle_state from core.object where id = $1',
            [record],
          ),
        );
        expect(state.lifecycle_state).toBe('qualified');
      },
    );
  });

  it('without the record policy, an outsider reads someone’s qualification', async () => {
    expect(await evaluate(P.outsider, lucieAero)).toBeUndefined();
    await without(
      'drop policy qualification_record_read on org.qualification_record; ' +
        'create policy qualification_record_read on org.qualification_record for select ' +
        'using (organization_id = (select core.current_organization()))||' +
        'drop policy qualification_record_read on org.qualification_record; ' +
        'create policy qualification_record_read on org.qualification_record for select using (' +
        'organization_id = (select core.current_organization()) ' +
        'and exists (select 1 from core.object envelope where envelope.id = qualification_record.id) ' +
        'and (person_id = (select core.current_principal_or_null()) ' +
        'or contact_person_id = (select core.current_principal_or_null()) ' +
        'or person_id = (select org.qualification_subject_or_null()) ' +
        'or org.qualification_reviews_pack(pack_id, pack_revision) ' +
        'or exists (select 1 from org.qualification_credit c where c.record_id = qualification_record.id ' +
        'and c.credited_by = (select core.current_principal_or_null()))))',
      async () => {
        expect(await evaluate(P.outsider, lucieAero)).toBeDefined();
      },
    );
    expect(await evaluate(P.outsider, lucieAero)).toBeUndefined();
  });

  it('without the assistant bar, an agent credits evidence', async () => {
    const record = await caraAero();
    const agentCredit = () =>
      credit(
        P.reviewer,
        record,
        [{ requirement_key: KEYS.readIn, evidence_object_id: R.overview }],
        'credit_qualification_evidence',
        AGENT,
      );
    expect((await refusal(agentCredit())).detail['rule']).toBe('KF-QUAL-011');
    await without(
      'drop trigger action_qualification_agent_bar on core.action; ' +
        'drop trigger qualification_credit_bounded on org.qualification_credit||' +
        'create trigger action_qualification_agent_bar before insert on core.action ' +
        'for each row execute function core.qualification_agent_bar(); ' +
        'create trigger qualification_credit_bounded before insert or update or delete on ' +
        'org.qualification_credit for each row execute function org.qualification_credit_bounded()',
      async () => {
        const result = await agentCredit();
        const participation = await withTransaction(h.adminPool, (tx) =>
          tx.one<{ agent_participation: string | null }>(
            'select agent_participation from core.action where id = $1',
            [result.actionId],
          ),
        );
        expect(participation.agent_participation).toBe(AGENT);
        await withTransaction(h.adminPool, (tx) =>
          tx.query('delete from org.qualification_credit where credited_by_action = $1', [
            result.actionId,
          ]),
        );
      },
    );
  });

  it('without the invitation bar, the application could invite', async () => {
    const invite = () =>
      withTransaction(h.pool, async (tx) => {
        await tx.query('select core.bind_principal($1, $2, $3, $4, $5)', [
          P.reviewer.id,
          P.reviewer.role,
          f.organizationId,
          'restricted',
          (await attestationFor(tx, principal(P.reviewer))) ?? null,
        ]);
        const actionId = randomUUID();
        await tx.query('select core.set_transaction_context($1, $2, $3, $4)', [
          P.reviewer.id,
          P.reviewer.role,
          actionId,
          'invitation-under-test',
        ]);
        await tx.query(
          `insert into core.action
             (id, organization_id, request_digest, action_type, actor_id, acting_role_id,
              target_ids, idempotency_key, effective_at, reason, result_status)
           values ($1::uuid, $2::uuid, encode(sha256(convert_to($1::text, 'UTF8')), 'hex'),
                   'correct_record', $3::uuid, $4::uuid, array[$2::uuid], 'invite-' || $1::text,
                   date_trunc('milliseconds', now() + interval '999 microseconds'),
                   'an invitation under test', 'applied')`,
          [actionId, f.organizationId, P.reviewer.id, P.reviewer.role],
        );
        await tx.query(
          `insert into org.invitation (organization_id, person_id, token_digest, invited_by,
                                       invited_by_action, expires_at)
           values ($1, $2, $3, $4, $5, now() + interval '7 days')`,
          [f.organizationId, P.dana.id, 'b'.repeat(64), P.reviewer.id, actionId],
        );
        throw new Error('ROLLBACK-OK');
      });
    // Granted the write the application never has, the trigger still refuses it.
    await without(
      'grant insert on org.invitation to kf_app; ' +
        'create policy invitation_insert_under_test on org.invitation for insert with check (true)||' +
        'drop policy invitation_insert_under_test on org.invitation; ' +
        'revoke insert on org.invitation from kf_app',
      async () => {
        await expect(invite()).rejects.toThrow(/KF-QUAL-040/);
        await without(
          'drop trigger invitation_bounded on org.invitation||' +
            'create trigger invitation_bounded before insert or update or delete on org.invitation ' +
            'for each row execute function org.invitation_bounded()',
          async () => {
            await expect(invite()).rejects.toThrow('ROLLBACK-OK');
          },
        );
      },
    );
  });
});
