/**
 * The evaluator: what a person still needs for a record, and why (ADR 0038 decisions 5, 7, 9, 10;
 * KF-SAS-RQ-256, RQ-259, RQ-260, RQ-261).
 *
 * Pure. It is given the record, its pinned composition with each requirement's definition IN
 * FORCE today, every credit of the person, what they submitted, and two facts only the
 * organization knows — whether the person can read each resource, and whether a reviewer exists
 * for each authority — and it answers per requirement. The rules:
 *
 *   - A requirement applies to the record when it is organization-wide or scoped to the record's
 *     scope; the others are not the record's to evidence.
 *   - It is SATISFIED by a credit of the same key, at the requirement's own mode (a mode is never
 *     upgraded: an acknowledgement never satisfies demonstrate, RQ-256), at or above the latest
 *     revision that changed required behaviour, in any of the person's records that is not
 *     withdrawn. One credit satisfies it in every pack that carries it (decision 3).
 *   - A credit below that floor is a GAP: a behavioural revision touched this person, for this
 *     requirement, and nothing else (RQ-259). A revision that declared no behavioural impact moves
 *     no floor, so it creates no gap.
 *   - An inaccessible or missing resource, or nobody to accept the evidence, is BLOCKED ON THE
 *     ORGANIZATION, with the contact named: never the person's failure (RQ-261). Blocked wins
 *     over open, so the page cannot show a person failing at what nobody let them do.
 *   - A mandatory requirement carries what fails without it (RQ-260); the evaluator repeats it.
 *
 * Nothing here names a role or a title; requirements, authorities and stages are data.
 */

import type {
  AuthorityClass,
  ComposedRequirement,
  Consequence,
  EvidenceMode,
  Part,
  RequirementDefinition,
  Stage,
} from './pack.js';

export type RecordState = 'assigned' | 'qualified' | 'withdrawn' | 'superseded';

export interface RecordFacts {
  readonly id: string;
  readonly personId: string;
  readonly contactPersonId: string;
  readonly contactName?: string;
  readonly scopeObjectId: string | null;
  readonly scopeTitle?: string;
  readonly state: RecordState;
  readonly packId: string;
  readonly packKey: string;
  readonly packTitle: string;
  readonly packRevision: number;
  readonly closing: 'on_evidence' | 'on_acceptance';
}

/** A requirement of the record's pinned composition, with its definition in force today. */
export interface RequirementInForce {
  readonly key: string;
  readonly part: Part;
  /** The revision the record's pack revision pinned. */
  readonly pinnedRevision: number;
  /** The latest approved revision. */
  readonly revision: number;
  /** The latest approved revision that changed required behaviour: a credit's floor. */
  readonly floor: number;
  readonly definition: RequirementDefinition;
}

export interface CreditFacts {
  readonly id: string;
  readonly recordId: string;
  readonly recordState: RecordState;
  readonly key: string;
  readonly revision: number;
  readonly mode: EvidenceMode;
  readonly evidenceObjectId: string | null;
  readonly priorCreditId: string | null;
  readonly creditedBy: string;
  readonly creditedAt: string;
}

export interface SubmissionFacts {
  readonly id: string;
  readonly key: string;
  readonly evidenceObjectId: string;
  readonly submittedAt: string;
  readonly agentClientId: string | null;
}

export type ResourceReach = 'readable' | 'not_granted' | 'missing';

export interface OrganizationFacts {
  /** The PERSON's reach of each resource (not the reader's). Absent means unknown. */
  readonly resourceReach: ReadonlyMap<string, ResourceReach>;
  /** Whether someone other than the person can accept evidence under each authority. */
  readonly reviewerAvailable: (acceptedBy: string) => boolean;
}

export type RequirementStatus =
  'satisfied' | 'gap_revised' | 'submitted' | 'open' | 'blocked_on_organization';

export type Blocker =
  | { readonly kind: 'resource_not_granted'; readonly resourceId: string }
  | { readonly kind: 'resource_missing'; readonly resourceId: string }
  | { readonly kind: 'reviewer_unavailable'; readonly authority: string };

export interface RequirementEvaluation {
  readonly key: string;
  readonly part: Part;
  readonly stage: Stage;
  readonly outcome: string;
  readonly mode: EvidenceMode;
  readonly acceptedBy: string;
  readonly mandatory: boolean;
  readonly consequence: Consequence | null;
  readonly revision: number;
  readonly floor: number;
  readonly status: RequirementStatus;
  /** The credit that satisfies it, or the one below the floor for a gap. */
  readonly credit: CreditFacts | null;
  readonly submissions: readonly SubmissionFacts[];
  readonly blockers: readonly Blocker[];
  readonly resources: readonly {
    readonly id: string;
    readonly revision: string;
    readonly authorityClass: AuthorityClass;
    readonly label: string | null;
    readonly reach: ResourceReach | 'unknown';
  }[];
  /** Prerequisites not yet satisfied: they order the work, they do not lock it. */
  readonly awaiting: readonly string[];
  readonly gates: readonly string[];
}

export interface RecordEvaluation {
  readonly record: RecordFacts;
  readonly requirements: readonly RequirementEvaluation[];
  /** Every mandatory, applicable requirement satisfied. */
  readonly complete: boolean;
  /** Mandatory requirements without a current credit, in key order. */
  readonly missing: readonly string[];
  /** Requirements whose credit a behavioural revision left behind. */
  readonly gaps: readonly string[];
  /** Requirements blocked on the organization. */
  readonly blocked: readonly string[];
  /**
   * `qualified` — closed and still complete; `qualified_with_gap` — closed, and a later
   * behavioural revision left a requirement uncredited (only the acts it gates are restricted);
   * `open` — assigned; or the record's terminal state.
   */
  readonly currency: 'qualified' | 'qualified_with_gap' | 'open' | 'withdrawn' | 'superseded';
}

/** Whether a requirement applies to a record of this scope. */
export function applies(definition: RequirementDefinition, scopeObjectId: string | null): boolean {
  const scope = definition.scope;
  if (scope === undefined || scope === 'organization') return true;
  return scope.object === scopeObjectId;
}

/** The credit that satisfies a requirement for this person now, if any (RQ-256, RQ-259). */
export function currentCredit(
  requirement: Pick<RequirementInForce, 'key' | 'floor' | 'definition'>,
  credits: readonly CreditFacts[],
): CreditFacts | undefined {
  return credits
    .filter(
      (c) =>
        c.key === requirement.key &&
        c.mode === requirement.definition.evidence_mode &&
        c.revision >= requirement.floor &&
        c.recordState !== 'withdrawn',
    )
    .sort((a, b) => b.revision - a.revision || a.creditedAt.localeCompare(b.creditedAt))[0];
}

export function evaluateRecord(input: {
  readonly record: RecordFacts;
  readonly requirements: readonly RequirementInForce[];
  readonly credits: readonly CreditFacts[];
  readonly submissions: readonly SubmissionFacts[];
  readonly organization: OrganizationFacts;
}): RecordEvaluation {
  const { record, credits, submissions, organization } = input;
  const applicable = input.requirements
    .filter((r) => applies(r.definition, record.scopeObjectId))
    .sort((a, b) => a.key.localeCompare(b.key));
  const satisfiedKeys = new Set(
    applicable.filter((r) => currentCredit(r, credits) !== undefined).map((r) => r.key),
  );

  const requirements = applicable.map((r): RequirementEvaluation => {
    const d = r.definition;
    const credit = currentCredit(r, credits);
    const stale = credits
      .filter(
        (c) =>
          c.key === r.key &&
          c.mode === d.evidence_mode &&
          c.revision < r.floor &&
          c.recordState !== 'withdrawn',
      )
      .sort((a, b) => b.revision - a.revision)[0];
    const waiting = submissions.filter(
      (s) => s.key === r.key && !credits.some((c) => c.key === r.key && c.revision >= r.floor),
    );
    const resources = (d.resources ?? []).map((resource) => ({
      id: resource.id,
      revision: resource.revision,
      authorityClass: resource.authority_class,
      label: resource.label ?? null,
      reach: organization.resourceReach.get(resource.id) ?? ('unknown' as const),
    }));
    const blockers: Blocker[] = [];
    if (credit === undefined) {
      for (const resource of resources) {
        if (resource.reach === 'not_granted') {
          blockers.push({ kind: 'resource_not_granted', resourceId: resource.id });
        } else if (resource.reach === 'missing') {
          blockers.push({ kind: 'resource_missing', resourceId: resource.id });
        }
      }
      if (!organization.reviewerAvailable(d.accepted_by)) {
        blockers.push({ kind: 'reviewer_unavailable', authority: d.accepted_by });
      }
    }
    const status: RequirementStatus =
      credit !== undefined
        ? 'satisfied'
        : blockers.length > 0
          ? 'blocked_on_organization'
          : stale !== undefined
            ? 'gap_revised'
            : waiting.length > 0
              ? 'submitted'
              : 'open';
    return {
      key: r.key,
      part: r.part,
      stage: d.stage,
      outcome: d.outcome,
      mode: d.evidence_mode,
      acceptedBy: d.accepted_by,
      mandatory: d.mandatory,
      consequence: d.consequence ?? null,
      revision: r.revision,
      floor: r.floor,
      status,
      credit: credit ?? stale ?? null,
      submissions: waiting,
      blockers,
      resources,
      awaiting: (d.prerequisites ?? []).filter((p) => !satisfiedKeys.has(p)).sort(),
      gates: [...(d.gates ?? [])].sort(),
    };
  });

  const mandatory = requirements.filter((r) => r.mandatory);
  const missing = mandatory.filter((r) => r.status !== 'satisfied').map((r) => r.key);
  const gaps = requirements.filter((r) => r.status === 'gap_revised').map((r) => r.key);
  const blocked = requirements
    .filter((r) => r.status === 'blocked_on_organization')
    .map((r) => r.key);
  const complete = missing.length === 0;
  const currency =
    record.state === 'withdrawn' || record.state === 'superseded'
      ? record.state
      : record.state === 'qualified'
        ? complete
          ? 'qualified'
          : 'qualified_with_gap'
        : 'open';
  return { record, requirements, complete, missing, gaps, blocked, currency };
}

/**
 * The requirements a person lacks for an act, as the database decides it at the moment of the
 * act (core.action_requires_qualification). The same rule in one function, for a page that
 * wants to say in advance what an act will need.
 */
export function gapsForAct(
  actionType: string,
  targets: readonly string[],
  inForce: readonly RequirementInForce[],
  credits: readonly CreditFacts[],
): readonly RequirementInForce[] {
  return inForce
    .filter((r) => (r.definition.gates ?? []).includes(actionType))
    .filter((r) => {
      const scope = r.definition.scope;
      return scope === undefined || scope === 'organization' || targets.includes(scope.object);
    })
    .filter((r) => currentCredit(r, credits) === undefined)
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The composition entries of a validated pack, as the evaluator's in-force input at approval. */
export function asInForce(composition: readonly ComposedRequirement[]): RequirementInForce[] {
  return composition.map((r) => ({
    key: r.key,
    part: r.part,
    pinnedRevision: r.revision,
    revision: r.revision,
    floor: r.revision,
    definition: r.definition,
  }));
}
