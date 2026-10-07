// Véracier's first qualification packs (ADR 0038; KF-WAR-0007 deliverable 9).
//
// DATA, nothing else. One common part every Véracier person composes, a pack for the chief
// executive and a pack for an aero engineer on the AV-3000 programme. A new role is a new pack in
// this file (or any other) and no code: `tests/database/qualification.test.ts` adds a third pack
// in the test itself and walks it through the same acts, and
// `tests/conformance/no-role-branch.test.ts` refuses a role named in any evaluator, route or view.
//
// The packs reference the organization's own records by identifier and revision and copy none of
// them: a builder is given the ids the organization holds (the loader's, or a test's) and the
// roles it names authority by. Every mandatory requirement says what becomes unsafe, unauthorized
// or unreliable without it (KF-SAS-RQ-260). The approval is the technical authority's
// institutional act (decision 13: founding authority is one person, recorded as such).
//
// The five stages are the protocol's, identical for both packs; what differs is which
// requirements each pack places in them:
//
//   Read-In            the living overview, acknowledged                       (common)
//   Role Read-In       the authority matrix (CEO) · the AV-3000 programme (aero)
//   References         where the normative procedures live, located in real work  (common)
//   Execution          raising a nonconformity the Véracier way (common, gates raise_nonconformity)
//                      approving a CAPA plan (CEO, gates approve_capa_plan)
//                      containing a nonconformity (aero, gates contain_nonconformity)
//   First Contribution one bounded Warrant, accepted by the contact              (common)

export const COMMON = 'veracier.common';
export const CEO = 'veracier.chief-executive';
export const AERO = 'veracier.aero-engineer';

/** Requirement keys, stable across revisions. */
export const KEYS = {
  readIn: 'veracier.common.read-in',
  references: 'veracier.common.references',
  ncr: 'veracier.common.ncr-locate',
  firstContribution: 'veracier.common.first-contribution',
  authorityMatrix: 'veracier.ceo.authority-matrix',
  capaPlan: 'veracier.ceo.capa-plan',
  programme: 'veracier.aero.av3000-programme',
  containment: 'veracier.aero.containment',
};

/**
 * @param {{
 *   resources: {
 *     overview: { id: string, revision: string },
 *     procedures: { id: string, revision: string },
 *     ncrExample: { id: string, revision: string },
 *     authorityMatrix: { id: string, revision: string },
 *     programme: { id: string, revision: string },
 *   },
 *   scope: { av3000: string },
 *   roles: { owner: string, quality: string, executive: string },
 * }} options
 */
export function veracierPacks({ resources, scope, roles }) {
  const common = {
    format: 'kf-qualification-pack-v1',
    key: COMMON,
    revision: 1,
    title: 'Véracier — common part',
    owner: `role:${roles.owner}`,
    closing: 'on_evidence',
    requirements: [
      {
        key: KEYS.readIn,
        revision: 1,
        part: 'common',
        stage: 'read_in',
        outcome: 'Knows what Véracier is: its entities, its programmes and how the group is run.',
        evidence_mode: 'acknowledge',
        accepted_by: 'self',
        mandatory: true,
        consequence: {
          kind: 'unreliable',
          statement:
            'Without the map of the group a newcomer files work under the wrong entity, where the ' +
            'people who must act on it never see it.',
        },
        resources: [
          { ...resources.overview, authority_class: 'reference', label: 'Living overview' },
        ],
        formats: ['reading'],
      },
      {
        key: KEYS.references,
        revision: 1,
        part: 'common',
        stage: 'references',
        outcome:
          'Finds the normative procedure for the task at hand and cites its current revision.',
        evidence_mode: 'locate',
        accepted_by: 'contact',
        mandatory: true,
        consequence: {
          kind: 'unreliable',
          statement: 'Work that cites a superseded procedure is redone when the audit finds it.',
        },
        resources: [
          { ...resources.procedures, authority_class: 'normative', label: 'Group procedures' },
        ],
        prerequisites: [KEYS.readIn],
      },
      {
        key: KEYS.ncr,
        revision: 1,
        part: 'common',
        stage: 'execution',
        outcome:
          'Raises a nonconformity through the record, with its subject, severity and evidence.',
        evidence_mode: 'locate',
        accepted_by: 'contact',
        mandatory: true,
        consequence: {
          kind: 'unsafe',
          statement:
            'A nonconformity that is not raised in the record is not contained, and the part ships.',
        },
        resources: [
          { ...resources.ncrExample, authority_class: 'learning', label: 'A raised nonconformity' },
        ],
        gates: ['raise_nonconformity'],
      },
      {
        key: KEYS.firstContribution,
        revision: 1,
        part: 'common',
        stage: 'first_contribution',
        outcome: 'Has finished one bounded Warrant through the normal system, accepted as is.',
        evidence_mode: 'demonstrate',
        accepted_by: 'contact',
        mandatory: true,
        consequence: {
          kind: 'unreliable',
          statement:
            'Until one piece of work has gone through the record end to end, nobody knows the ' +
            'person’s work will arrive where it is relied on.',
        },
        prerequisites: [KEYS.references],
      },
    ],
  };
  const commonPart = { pack: COMMON, revision: 1 };
  const ceo = {
    format: 'kf-qualification-pack-v1',
    key: CEO,
    revision: 1,
    title: 'Véracier — chief executive',
    owner: `role:${roles.owner}`,
    closing: 'on_evidence',
    parts: { common: [commonPart] },
    requirements: [
      {
        key: KEYS.authorityMatrix,
        revision: 1,
        part: 'role',
        stage: 'role_read_in',
        outcome: 'Has received and reviewed the authority matrix the board delegated.',
        evidence_mode: 'acknowledge',
        accepted_by: 'self',
        mandatory: true,
        consequence: {
          kind: 'unauthorized',
          statement:
            'A decision taken outside the delegation the board granted is not the group’s ' +
            'decision, whoever signs it.',
        },
        resources: [
          { ...resources.authorityMatrix, authority_class: 'normative', label: 'Authority matrix' },
        ],
      },
      {
        key: KEYS.capaPlan,
        revision: 1,
        part: 'role',
        stage: 'execution',
        outcome:
          'Approves a CAPA plan only with its root cause and effectiveness criterion stated.',
        evidence_mode: 'demonstrate',
        accepted_by: `role:${roles.quality}`,
        mandatory: false,
        gates: ['approve_capa_plan'],
      },
    ],
  };
  const aero = {
    format: 'kf-qualification-pack-v1',
    key: AERO,
    revision: 1,
    title: 'Véracier — aero engineer, AV-3000',
    owner: `role:${roles.owner}`,
    closing: 'on_evidence',
    parts: { common: [commonPart] },
    requirements: [
      {
        key: KEYS.programme,
        revision: 1,
        part: 'scope',
        stage: 'role_read_in',
        outcome: 'Knows the AV-3000 programme: its product, its customer and its open findings.',
        evidence_mode: 'acknowledge',
        accepted_by: 'self',
        mandatory: true,
        consequence: {
          kind: 'unreliable',
          statement:
            'An engineer who has not read the programme’s open findings repeats the failures ' +
            'they record.',
        },
        resources: [
          { ...resources.programme, authority_class: 'reference', label: 'AV-3000 programme' },
        ],
        // A scope requirement: it applies to a record whose scope is the AV-3000 programme, and
        // to nobody else's, so its revision touches only the people qualifying for that scope.
        scope: { object: scope.av3000 },
      },
      {
        key: KEYS.containment,
        revision: 1,
        part: 'role',
        stage: 'execution',
        outcome: 'Contains an AV-3000 nonconformity: segregates the lot and records the action.',
        evidence_mode: 'demonstrate',
        accepted_by: `role:${roles.quality}`,
        mandatory: true,
        consequence: {
          kind: 'unsafe',
          statement: 'An uncontained nonconforming lot reaches the customer’s flight hardware.',
        },
        gates: ['contain_nonconformity'],
      },
    ],
  };
  return { common, ceo, aero };
}

/**
 * The aero pack's second revision, with one requirement (`key`) revised. `behavioural` says
 * whether the revision changes required behaviour (a new step) or only its wording; only the
 * first creates a gap, and only for the people the requirement applies to (KF-SAS-RQ-259).
 */
export function aeroRevision2(packs, { key = KEYS.containment, behavioural }) {
  return {
    ...packs.aero,
    revision: 2,
    requirements: packs.aero.requirements.map((r) =>
      r.key === key
        ? {
            ...r,
            revision: 2,
            behavioural_impact: behavioural,
            outcome: behavioural
              ? `${r.outcome.replace(/\.$/, '')}, and tags each affected part.`
              : `${r.outcome.replace(/\.$/, '')} (wording clarified).`,
          }
        : r,
    ),
  };
}

/** The people the fixture walks from invitation to qualified, one per pack. */
export const JOINERS = [
  {
    key: 'lucie.garnier',
    name: 'Lucie Garnier',
    title: 'Ingénieure méthodes AV-3000, Véracier Aero (arrivée 2026-10)',
    pack: AERO,
    contact: 'audrey.lescure',
    role: 'performer',
  },
  {
    key: 'helene.daubrac',
    name: 'Hélène Daubrac',
    title: 'Présidente-directrice générale',
    pack: CEO,
    contact: 'antoine.morel',
    role: null,
  },
];
