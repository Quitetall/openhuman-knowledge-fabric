/**
 * Start Here: the person's qualification as five stages (ADR 0038 decisions 1 and 11; ADR 0040
 * decision 12; KF-SAS-RQ-275).
 *
 * A PROJECTION, never edited: it is a pure function of the record, the pack and the evidence
 * (`RecordEvaluation`), and it carries a digest over exactly what it shows, so the page a person
 * saw can be regenerated from the record and compared. There is no table of Start Here pages and
 * no write path to one. Every status on it resolves to a requirement and its evidence.
 *
 * It is not a projection of the closed grammar (KF-SAS-RQ-116, `ontology/projections.yaml`): that
 * grammar places members of a master-record corpus in sections, and Start Here's rows are
 * requirements and credits, which are not corpus members. It is generated under the same rules —
 * determinism, a tagged digest, nothing the reader cannot read — as a projection of its own kind,
 * and KF-WAR-0007's basis records that a grammar extension would be a separate, reviewed change.
 *
 * The five stages are the same for every person in every role (RQ-254); a role differs only in
 * which requirements its pack places in each. A stage is a section, not a waiting room: nothing
 * here locks a stage behind another, and a prerequisite only orders the work it names.
 */

import { taggedDigest } from '@kf/canonicalization';
import type { Blocker, RecordEvaluation, RequirementEvaluation } from './evaluate.js';
import { STAGES, type Stage } from './pack.js';

export const START_HERE_FORMAT = 'kf-start-here-v1' as const;

/** The protocol's five questions (decision 1). Fixed text, identical for everyone. */
export const STAGE_TEXT: Readonly<Record<Stage, { title: string; question: string }>> = {
  read_in: { title: 'Read-In', question: 'What have I joined?' },
  role_read_in: { title: 'Role Read-In', question: 'What is my place in it?' },
  references: { title: 'References', question: 'Where does authoritative truth live?' },
  execution: { title: 'Execution', question: 'How does work move here?' },
  first_contribution: {
    title: 'First Contribution',
    question: 'What bounded, useful work do I do through the normal system?',
  },
};

export interface StartHereItem {
  readonly key: string;
  readonly outcome: string;
  readonly mode: RequirementEvaluation['mode'];
  readonly mandatory: boolean;
  /** RQ-260: what fails without it, for a mandatory requirement. */
  readonly consequence: RequirementEvaluation['consequence'];
  readonly acceptedBy: string;
  readonly status: RequirementEvaluation['status'];
  readonly revision: number;
  readonly evidence: {
    readonly creditId: string;
    readonly revision: number;
    readonly evidenceObjectId: string | null;
    readonly priorCreditId: string | null;
    readonly creditedBy: string;
    readonly creditedAt: string;
  } | null;
  readonly submitted: readonly { readonly id: string; readonly evidenceObjectId: string }[];
  readonly blockers: readonly Blocker[];
  readonly resources: RequirementEvaluation['resources'];
  readonly awaiting: readonly string[];
  readonly gates: readonly string[];
}

export interface StartHereStage {
  readonly id: Stage;
  readonly title: string;
  readonly question: string;
  readonly items: readonly StartHereItem[];
  readonly done: number;
  readonly total: number;
}

export interface StartHere {
  readonly format: typeof START_HERE_FORMAT;
  readonly recordId: string;
  readonly personId: string;
  readonly contact: { readonly personId: string; readonly name: string | null };
  readonly scope: { readonly objectId: string | null; readonly title: string | null };
  readonly pack: {
    readonly id: string;
    readonly key: string;
    readonly title: string;
    readonly revision: number;
  };
  readonly state: RecordEvaluation['record']['state'];
  readonly currency: RecordEvaluation['currency'];
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly gaps: readonly string[];
  readonly blocked: readonly string[];
  readonly stages: readonly StartHereStage[];
  /** `taggedDigest('kf-start-here-v1', everything above)`. */
  readonly digest: string;
}

function item(r: RequirementEvaluation): StartHereItem {
  return {
    key: r.key,
    outcome: r.outcome,
    mode: r.mode,
    mandatory: r.mandatory,
    consequence: r.consequence,
    acceptedBy: r.acceptedBy,
    status: r.status,
    revision: r.revision,
    evidence:
      r.credit === null
        ? null
        : {
            creditId: r.credit.id,
            revision: r.credit.revision,
            evidenceObjectId: r.credit.evidenceObjectId,
            priorCreditId: r.credit.priorCreditId,
            creditedBy: r.credit.creditedBy,
            creditedAt: r.credit.creditedAt,
          },
    submitted: r.submissions.map((s) => ({ id: s.id, evidenceObjectId: s.evidenceObjectId })),
    blockers: r.blockers,
    resources: r.resources,
    awaiting: r.awaiting,
    gates: r.gates,
  };
}

/** Generate Start Here from an evaluation. Deterministic: same record, same page, same digest. */
export function startHere(evaluation: RecordEvaluation): StartHere {
  const { record } = evaluation;
  const stages = STAGES.map((stage): StartHereStage => {
    const items = evaluation.requirements
      .filter((r) => r.stage === stage)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(item);
    return {
      id: stage,
      ...STAGE_TEXT[stage],
      items,
      done: items.filter((i) => i.status === 'satisfied').length,
      total: items.length,
    };
  });
  const body = {
    recordId: record.id,
    personId: record.personId,
    contact: { personId: record.contactPersonId, name: record.contactName ?? null },
    scope: { objectId: record.scopeObjectId, title: record.scopeTitle ?? null },
    pack: {
      id: record.packId,
      key: record.packKey,
      title: record.packTitle,
      revision: record.packRevision,
    },
    state: record.state,
    currency: evaluation.currency,
    complete: evaluation.complete,
    missing: evaluation.missing,
    gaps: evaluation.gaps,
    blocked: evaluation.blocked,
    stages,
  };
  return {
    format: START_HERE_FORMAT,
    ...body,
    digest: taggedDigest(
      START_HERE_FORMAT,
      JSON.parse(JSON.stringify(body)) as Record<string, unknown>,
    ),
  };
}

/** Whether a Start Here document is the one its own content generates. */
export function startHereIsGenerated(page: StartHere): boolean {
  const { format: _format, digest, ...body } = page;
  void _format;
  return (
    taggedDigest(START_HERE_FORMAT, JSON.parse(JSON.stringify(body)) as Record<string, unknown>) ===
    digest
  );
}
