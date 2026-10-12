import {
  AUTHORITY_CLASSES,
  CLOSING_RULES,
  CONSEQUENCE_KINDS,
  EVIDENCE_MODES,
  PARTS,
  STAGES,
  validatePackDocument,
  type ResolvedPart,
} from '@kf/qualification/pack';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_AUTHORITY_CLASSES,
  DRAFT_CLOSING,
  DRAFT_CONSEQUENCES,
  DRAFT_MODES,
  DRAFT_PARTS,
  DRAFT_STAGES,
  emptyPack,
  emptyRequirement,
  packDocument,
  type PackDraft,
} from './pack-model';

/**
 * The drafting form spells a `kf-qualification-pack-v1` document, and the pack validator — the
 * function `draft_qualification_pack` itself runs — judges it (§100.62). The form's choices are
 * the validator's vocabulary exactly, so it can neither offer a value the validator refuses nor
 * omit one it accepts; a complete form validates clean, and an incomplete one is refused by the
 * validator naming each missing thing, which this model never pre-empts.
 */

const RESOURCE = '01900000-0000-7000-8000-0000000000aa';

function filled(): PackDraft {
  return {
    ...emptyPack(),
    key: 'aero-engineer',
    title: 'Aero engineer',
    ownerRole: 'quality_lead',
    requirements: [
      {
        ...emptyRequirement(),
        key: 'read-procedures',
        part: 'common',
        outcome: 'Has read the group procedures index',
        acceptedByKind: 'self',
        consequenceKind: 'unreliable',
        consequenceStatement: 'Work would not follow the procedures',
        resources: `${RESOURCE} 3 normative Group procedures index`,
      },
      {
        ...emptyRequirement(),
        key: 'first-ncr',
        part: 'role',
        stage: 'first_contribution',
        outcome: 'Raised one nonconformance report that was accepted',
        evidenceMode: 'demonstrate',
        acceptedByKind: 'role',
        acceptedByRole: 'quality_lead',
        consequenceKind: 'unsafe',
        consequenceStatement: 'Defects would go unrecorded',
        prerequisites: 'read-procedures',
      },
    ],
  };
}

describe('the pack-drafting form model', () => {
  it('offers exactly the vocabulary the validator accepts', () => {
    expect(DRAFT_STAGES).toEqual(STAGES);
    expect(DRAFT_MODES).toEqual(EVIDENCE_MODES);
    expect(DRAFT_PARTS).toEqual(PARTS);
    expect(DRAFT_CONSEQUENCES).toEqual(CONSEQUENCE_KINDS);
    expect(DRAFT_CLOSING).toEqual(CLOSING_RULES);
    expect(DRAFT_AUTHORITY_CLASSES).toEqual(AUTHORITY_CLASSES);
  });

  it('spells a complete form as a document the validator accepts', () => {
    const document = packDocument(filled());
    const validation = validatePackDocument(document);
    expect(validation.problems).toEqual([]);
    expect(validation.composition.map((r) => r.key)).toEqual(['first-ncr', 'read-procedures']);
    expect(document).toMatchObject({
      format: 'kf-qualification-pack-v1',
      revision: 1,
      owner: 'role:quality_lead',
      closing: 'on_evidence',
    });
    expect(document).not.toHaveProperty('acceptor');
    expect(document).not.toHaveProperty('parts');
  });

  it('leaves judging to the validator, which names what an empty form lacks', () => {
    const codes = validatePackDocument(packDocument(emptyPack())).problems.map(
      (p) => `${p.code} ${p.path}`,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'missing_field $.key',
        'missing_field $.title',
        'missing_owner $.owner',
        'missing_field $.requirements[0].key',
        'missing_field $.requirements[0].outcome',
        'mandatory_without_consequence $.requirements[0].consequence',
        'missing_field $.requirements[0].resources',
      ]),
    );
  });

  it('passes a revision it cannot read as a number through, for the validator to name', () => {
    const draft = filled();
    const document = packDocument({
      ...draft,
      requirements: [{ ...draft.requirements[0]!, revision: 'two' }],
    });
    const problems = validatePackDocument(document).problems.map((p) => p.path);
    expect(problems).toContain('$.requirements[0].revision');
  });

  it('composes parts by key and revision, resolved as the API resolves them', () => {
    const base = validatePackDocument(packDocument(filled()));
    const part: ResolvedPart = {
      key: 'common',
      revision: 2,
      approved: true,
      composesParts: false,
      requirements: base.composition.filter((r) => r.key === 'read-procedures'),
    };
    const draft = filled();
    const document = packDocument({
      ...draft,
      key: 'aero-lead',
      parts: { ...draft.parts, common: 'common@2' },
      requirements: [draft.requirements[1]!],
    });
    expect(document['parts']).toEqual({ common: [{ pack: 'common', revision: 2 }] });
    const resolved = validatePackDocument(document, (ref) =>
      ref.pack === 'common' && ref.revision === 2 ? part : undefined,
    );
    expect(resolved.problems).toEqual([]);
    expect(validatePackDocument(document).problems.map((p) => p.code)).toContain('dead_reference');
  });

  it('names an acceptor only for a pack closed on acceptance', () => {
    const draft = { ...filled(), closing: 'on_acceptance', acceptorRole: 'quality_lead' };
    expect(packDocument(draft)['acceptor']).toBe('role:quality_lead');
    expect(validatePackDocument(packDocument(draft)).problems).toEqual([]);
  });
});
