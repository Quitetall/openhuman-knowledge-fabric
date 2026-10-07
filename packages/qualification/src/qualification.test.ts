/**
 * The pure halves of qualification (ADR 0038): the pack validator and composition, the
 * evaluator's rules, Start Here's determinism, and the guide's context. The database halves —
 * authority, modes, closing, requires_qualification, confidentiality — are
 * tests/database/qualification.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { agentGuideContext, GUIDE_ACTS } from './agent-guide.js';
import {
  evaluateRecord,
  gapsForAct,
  type CreditFacts,
  type RecordFacts,
  type RequirementInForce,
} from './evaluate.js';
import {
  requirementDefinition,
  validatePackDocument,
  type PackDocument,
  type RequirementDocument,
  type ResolvedPart,
} from './pack.js';
import { startHere, startHereIsGenerated } from './start-here.js';

const R1 = '01900000-0000-7000-8000-000000000001';
const R2 = '01900000-0000-7000-8000-000000000002';
const SCOPE_A = '01900000-0000-7000-8000-00000000000a';
const SCOPE_B = '01900000-0000-7000-8000-00000000000b';

const requirement = (over: Partial<RequirementDocument> = {}): RequirementDocument => ({
  key: 'org.read-in',
  revision: 1,
  part: 'common',
  stage: 'read_in',
  outcome: 'Knows what the organization is and how it is run.',
  evidence_mode: 'acknowledge',
  accepted_by: 'self',
  mandatory: true,
  consequence: { kind: 'unreliable', statement: 'Work lands in the wrong place without it.' },
  resources: [{ id: R1, revision: '1', authority_class: 'reference' }],
  ...over,
});

const pack = (over: Partial<PackDocument> = {}): PackDocument => ({
  format: 'kf-qualification-pack-v1',
  key: 'org.common',
  revision: 1,
  title: 'Common part',
  owner: 'role:technical_authority',
  closing: 'on_evidence',
  requirements: [requirement()],
  ...over,
});

const codes = (
  raw: unknown,
  parts?: (ref: { pack: string; revision: number }) => ResolvedPart | undefined,
) => validatePackDocument(raw, parts).problems.map((p) => p.code);

describe('the pack validator', () => {
  it('accepts a well-formed pack and composes it', () => {
    const result = validatePackDocument(pack());
    expect(result.problems).toEqual([]);
    expect(result.composition.map((r) => r.key)).toEqual(['org.read-in']);
  });

  it('refuses duplicate requirements, even when one of the pair is otherwise invalid', () => {
    expect(codes(pack({ requirements: [requirement(), requirement({ outcome: 'x' })] }))).toContain(
      'duplicate_requirement',
    );
  });

  it('refuses missing owners: the pack’s and a requirement’s accepting authority', () => {
    const { owner: _o, ...noOwner } = pack();
    void _o;
    expect(codes(noOwner)).toContain('missing_owner');
    expect(codes(pack({ requirements: [requirement({ accepted_by: '' })] }))).toContain(
      'missing_owner',
    );
  });

  it('refuses a mandatory requirement that names no consequence (KF-SAS-RQ-260)', () => {
    const { consequence: _c, ...bare } = requirement();
    void _c;
    expect(codes(pack({ requirements: [bare as RequirementDocument] }))).toContain(
      'mandatory_without_consequence',
    );
    // Optional reading needs none.
    expect(
      codes(pack({ requirements: [{ ...bare, mandatory: false } as RequirementDocument] })),
    ).toEqual([]);
  });

  it('refuses inheritance language and scripts by name, and any undeclared key', () => {
    const found = validatePackDocument({ ...pack(), extends: 'org.base', script: 'x()' }).problems;
    expect(found.map((p) => p.code)).toEqual(['unknown_key', 'unknown_key']);
    expect(found[0]?.message).toMatch(/no inheritance language and no scripts/);
    expect(
      codes(pack({ requirements: [{ ...requirement(), when: 'role == ceo' } as never] })),
    ).toContain('unknown_key');
  });

  it('refuses a dead reference: a part that does not exist, or is not approved', () => {
    expect(
      codes(pack({ key: 'org.ceo', parts: { common: [{ pack: 'org.missing', revision: 1 }] } })),
    ).toContain('dead_reference');
    const draft: ResolvedPart = {
      key: 'org.common',
      revision: 1,
      approved: false,
      composesParts: false,
      requirements: [],
    };
    expect(
      codes(
        pack({ key: 'org.ceo', parts: { common: [{ pack: 'org.common', revision: 1 }] } }),
        () => draft,
      ),
    ).toContain('dead_reference');
  });

  it('refuses a composition cycle and a chain of parts', () => {
    expect(codes(pack({ parts: { common: [{ pack: 'org.common', revision: 1 }] } }))).toContain(
      'composition_cycle',
    );
    const chained: ResolvedPart = {
      key: 'org.role',
      revision: 1,
      approved: true,
      composesParts: true,
      requirements: [],
    };
    expect(
      codes(
        pack({ key: 'org.x', parts: { role: [{ pack: 'org.role', revision: 1 }] } }),
        () => chained,
      ),
    ).toContain('nested_composition');
  });

  it('refuses a prerequisite cycle', () => {
    const a = requirement({ key: 'org.a', prerequisites: ['org.b'] });
    const b = requirement({ key: 'org.b', prerequisites: ['org.a'] });
    expect(codes(pack({ requirements: [a, b] }))).toContain('prerequisite_cycle');
  });

  it('refuses self-acceptance of anything but an acknowledgement (KF-SAS-RQ-047)', () => {
    expect(
      codes(
        pack({
          requirements: [
            requirement({ evidence_mode: 'demonstrate', accepted_by: 'self', resources: [] }),
          ],
        }),
      ),
    ).toContain('self_acceptance');
  });

  it('refuses a later revision that does not say whether behaviour changed (RQ-259)', () => {
    expect(codes(pack({ requirements: [requirement({ revision: 2 })] }))).toContain(
      'undeclared_behavioural_impact',
    );
  });

  it('composes common, role and scope parts by explicit list, a shared requirement once', () => {
    const common = validatePackDocument(pack());
    const part: ResolvedPart = {
      key: 'org.common',
      revision: 1,
      approved: true,
      composesParts: false,
      requirements: common.composition,
    };
    const role = pack({
      key: 'org.engineer',
      parts: {
        common: [{ pack: 'org.common', revision: 1 }],
        scope: [{ pack: 'org.common', revision: 1 }],
      },
      requirements: [
        requirement({
          key: 'org.engineer.design',
          part: 'role',
          stage: 'execution',
          evidence_mode: 'demonstrate',
          accepted_by: 'role:technical_authority',
          resources: [],
        }),
      ],
    });
    const result = validatePackDocument(role, () => part);
    expect(result.problems).toEqual([]);
    expect(result.composition.map((r) => [r.key, r.part])).toEqual([
      ['org.engineer.design', 'role'],
      ['org.read-in', 'common'],
    ]);
  });

  it('refuses two parts that disagree about one requirement', () => {
    const one: ResolvedPart = {
      key: 'org.a',
      revision: 1,
      approved: true,
      composesParts: false,
      requirements: validatePackDocument(pack({ key: 'org.a' })).composition,
    };
    const other: ResolvedPart = {
      key: 'org.b',
      revision: 1,
      approved: true,
      composesParts: false,
      requirements: validatePackDocument(
        pack({
          key: 'org.b',
          requirements: [requirement({ outcome: 'Something else entirely, said differently.' })],
        }),
      ).composition,
    };
    expect(
      codes(
        pack({
          key: 'org.c',
          parts: {
            common: [{ pack: 'org.a', revision: 1 }],
            role: [{ pack: 'org.b', revision: 1 }],
          },
          requirements: [],
        }),
        (ref) => (ref.pack === 'org.a' ? one : other),
      ),
    ).toContain('conflicting_requirement');
  });
});

const RECORD: RecordFacts = {
  id: '01900000-0000-7000-8000-0000000000aa',
  personId: '01900000-0000-7000-8000-0000000000bb',
  contactPersonId: '01900000-0000-7000-8000-0000000000cc',
  contactName: 'Audrey',
  scopeObjectId: SCOPE_A,
  state: 'assigned',
  packId: '01900000-0000-7000-8000-0000000000dd',
  packKey: 'org.engineer',
  packTitle: 'Engineer',
  packRevision: 1,
  closing: 'on_evidence',
};

const inForce = (doc: RequirementDocument, floor = doc.revision): RequirementInForce => ({
  key: doc.key,
  part: doc.part,
  pinnedRevision: doc.revision,
  revision: doc.revision,
  floor,
  definition: requirementDefinition(doc),
});

const credit = (key: string, mode: CreditFacts['mode'], revision = 1): CreditFacts => ({
  id: `credit-${key}-${String(revision)}-${mode}`,
  recordId: RECORD.id,
  recordState: 'assigned',
  key,
  revision,
  mode,
  evidenceObjectId: R2,
  priorCreditId: null,
  creditedBy: RECORD.contactPersonId,
  creditedAt: '2026-10-07T00:00:00.000Z',
});

const organization = {
  resourceReach: new Map([[R1, 'readable' as const]]),
  reviewerAvailable: () => true,
};

describe('the evaluator', () => {
  const readIn = requirement();
  const design = requirement({
    key: 'org.design',
    part: 'role',
    stage: 'execution',
    evidence_mode: 'demonstrate',
    accepted_by: 'role:technical_authority',
    resources: [],
    gates: ['contain_nonconformity'],
  });

  it('never upgrades a mode: an acknowledgement is not a demonstration (RQ-256)', () => {
    const evaluation = evaluateRecord({
      record: RECORD,
      requirements: [inForce(readIn), inForce(design)],
      credits: [credit('org.design', 'acknowledge')],
      submissions: [],
      organization,
    });
    expect(evaluation.requirements.find((r) => r.key === 'org.design')?.status).toBe('open');
  });

  it('credits a shared requirement once, from any of the person’s records', () => {
    const elsewhere = { ...credit('org.read-in', 'acknowledge'), recordId: 'another-record' };
    const evaluation = evaluateRecord({
      record: RECORD,
      requirements: [inForce(readIn)],
      credits: [elsewhere],
      submissions: [],
      organization,
    });
    expect(evaluation.complete).toBe(true);
  });

  it('does not count a withdrawn record’s credit', () => {
    const withdrawn = {
      ...credit('org.read-in', 'acknowledge'),
      recordState: 'withdrawn' as const,
    };
    const evaluation = evaluateRecord({
      record: RECORD,
      requirements: [inForce(readIn)],
      credits: [withdrawn],
      submissions: [],
      organization,
    });
    expect(evaluation.missing).toEqual(['org.read-in']);
  });

  it('a behavioural revision gaps the credit; a non-behavioural one does not (RQ-259)', () => {
    const revised = { ...requirement({ revision: 2, behavioural_impact: true }) };
    const behavioural = evaluateRecord({
      record: { ...RECORD, state: 'qualified' },
      requirements: [inForce(revised, 2)],
      credits: [credit('org.read-in', 'acknowledge', 1)],
      submissions: [],
      organization,
    });
    expect(behavioural.gaps).toEqual(['org.read-in']);
    expect(behavioural.currency).toBe('qualified_with_gap');
    const clarification = evaluateRecord({
      record: { ...RECORD, state: 'qualified' },
      requirements: [inForce(requirement({ revision: 2, behavioural_impact: false }), 1)],
      credits: [credit('org.read-in', 'acknowledge', 1)],
      submissions: [],
      organization,
    });
    expect(clarification.gaps).toEqual([]);
    expect(clarification.currency).toBe('qualified');
  });

  it('applies a scope requirement only to a record of that scope', () => {
    const scoped = requirement({ key: 'org.scoped', scope: { object: SCOPE_B } });
    const evaluation = evaluateRecord({
      record: RECORD,
      requirements: [inForce(readIn), inForce(scoped)],
      credits: [],
      submissions: [],
      organization,
    });
    expect(evaluation.requirements.map((r) => r.key)).toEqual(['org.read-in']);
  });

  it('shows an inaccessible resource and an unavailable reviewer as the organization’s (RQ-261)', () => {
    const evaluation = evaluateRecord({
      record: RECORD,
      requirements: [inForce(readIn), inForce(design)],
      credits: [],
      submissions: [],
      organization: {
        resourceReach: new Map([[R1, 'not_granted' as const]]),
        reviewerAvailable: (authority) => authority !== 'role:technical_authority',
      },
    });
    const byKey = new Map(evaluation.requirements.map((r) => [r.key, r]));
    expect(byKey.get('org.read-in')).toMatchObject({
      status: 'blocked_on_organization',
      blockers: [{ kind: 'resource_not_granted', resourceId: R1 }],
    });
    expect(byKey.get('org.design')).toMatchObject({
      status: 'blocked_on_organization',
      blockers: [{ kind: 'reviewer_unavailable', authority: 'role:technical_authority' }],
    });
    expect(evaluation.blocked).toEqual(['org.design', 'org.read-in']);
  });

  it('carries a mandatory requirement’s consequence (RQ-260)', () => {
    const evaluation = evaluateRecord({
      record: RECORD,
      requirements: [inForce(readIn)],
      credits: [],
      submissions: [],
      organization,
    });
    expect(evaluation.requirements[0]?.consequence?.kind).toBe('unreliable');
  });

  it('names the requirement an act lacks, and only the one that gates it', () => {
    const gaps = gapsForAct('contain_nonconformity', [], [inForce(readIn), inForce(design)], []);
    expect(gaps.map((g) => g.key)).toEqual(['org.design']);
    expect(gapsForAct('raise_nonconformity', [], [inForce(design)], [])).toEqual([]);
  });
});

describe('Start Here and the guide', () => {
  const evaluation = evaluateRecord({
    record: RECORD,
    requirements: [
      inForce(requirement()),
      inForce(
        requirement({
          key: 'org.first',
          stage: 'first_contribution',
          evidence_mode: 'demonstrate',
          accepted_by: 'contact',
          resources: [],
          prerequisites: ['org.read-in'],
        }),
      ),
    ],
    credits: [],
    submissions: [],
    organization,
  });

  it('is the five stages, generated deterministically with its own digest', () => {
    const page = startHere(evaluation);
    expect(page.stages.map((s) => s.id)).toEqual([
      'read_in',
      'role_read_in',
      'references',
      'execution',
      'first_contribution',
    ]);
    expect(startHere(evaluation).digest).toBe(page.digest);
    expect(startHereIsGenerated(page)).toBe(true);
    // An edited page is not the generated one.
    expect(startHereIsGenerated({ ...page, missing: [] })).toBe(false);
  });

  it('gives the guide the page, the next requirement first and a closed list of acts', () => {
    const guide = agentGuideContext(startHere(evaluation));
    expect(guide.next.map((n) => n.key)).toEqual(['org.read-in', 'org.first']);
    expect(guide.acts).toEqual(GUIDE_ACTS);
    expect(guide.instructions).toMatch(/never credit evidence/);
    expect(guide.instructions).toMatch(/Audrey/);
  });
});
