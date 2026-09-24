import { ActionRejected, type ActionMaterializer } from '@kf/actions';
import {
  classificationFrom,
  createControlledObject,
  optionalString,
  PayloadInvalid,
  requireString,
} from '@kf/record-atoms';

/**
 * Create acts for the work-control records that had none (KF-SAS-RQ-142).
 *
 * engagement, milestone and deliverable had typed tables and no act, so the only way one came
 * to exist was an owner-credential insert — the reference scenario seeded its engagement that
 * way. Each materializer creates the envelope and its typed row in the act's transaction, and
 * nothing else. None of the three types has a state machine, so each is born in its FIRST
 * declared state (object-types.yaml order), as the R01 product and quality creates are: a
 * create act that let the caller choose `active` or `achieved` would be a judgement nobody made.
 */

const ENGAGEMENT_KINDS = [
  'contractor',
  'supplier',
  'employee',
  'research_collaboration',
  'laboratory_service',
] as const;

const MAX_ACCEPTANCE_CRITERIA = 64;
const MAX_CRITERION_LENGTH = 2000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function oneOf(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
  values: readonly string[],
): string {
  const value = requireString(payload, key);
  if (!values.includes(value)) {
    throw new PayloadInvalid(key, `${key} must be one of ${values.join(', ')}`);
  }
  return value;
}

function date(payload: Readonly<Record<string, unknown>> | undefined, key: string): string {
  const value = requireString(payload, key);
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new PayloadInvalid(key, `${key} must be a calendar date (YYYY-MM-DD)`);
  }
  return value;
}

function optionalDate(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  return optionalString(payload, key) === null ? null : date(payload, key);
}

/** A create act names no target; one that does is asking to change a record, which these cannot. */
function refuseTargets(actionType: string, targetIds: readonly string[]): void {
  if (targetIds.length > 0) {
    throw new ActionRejected(
      'precondition_failed',
      `${actionType} creates a record; it names none`,
      {
        actionType,
      },
    );
  }
}

/**
 * A typed-row constraint the payload broke — a counterparty that is not an organization, an
 * engagement with itself, a project or package that does not exist — is the caller's input, so
 * it is refused as a precondition rather than surfacing as a 500 somebody would retry.
 */
async function typedRow(actionType: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === '23503' || code === '23514' || code === '22007' || code === '22008') {
      throw new ActionRejected('precondition_failed', (error as Error).message, { actionType });
    }
    throw error;
  }
}

/**
 * `record_engagement` — a signed agreement between this organization and a counterparty. The
 * principal is the acting organization: an engagement recorded here on another organization's
 * behalf would be a claim about a contract this organization is not party to.
 */
export const recordEngagement: ActionMaterializer = async (tx, request) => {
  refuseTargets(request.actionType, request.targetIds);
  const principal = optionalString(request.payload, 'principal_organization');
  if (principal !== null && principal !== request.organizationId) {
    throw new ActionRejected(
      'precondition_failed',
      'record_engagement records an engagement of the acting organization; principal_organization ' +
        'must be it or absent',
      { principalOrganization: principal },
    );
  }
  const counterparty = requireString(request.payload, 'counterparty');
  const kind = oneOf(request.payload, 'engagement_kind', ENGAGEMENT_KINDS);
  const startsOn = date(request.payload, 'starts_on');
  const endsOn = optionalDate(request.payload, 'ends_on');
  const agreement = optionalString(request.payload, 'agreement_artifact');
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'engagement',
    authorityDomain: 'commercial',
    lifecycleState: 'draft',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await typedRow(request.actionType, () =>
    tx.query(
      `insert into org.engagement
         (id, principal_organization, counterparty, engagement_kind, starts_on, ends_on,
          agreement_artifact)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, request.organizationId, counterparty, kind, startsOn, endsOn, agreement],
    ),
  );
  return [id];
};

/** `plan_milestone` — a dated, checkable point in a project. Achieving it is not this act. */
export const planMilestone: ActionMaterializer = async (tx, request) => {
  refuseTargets(request.actionType, request.targetIds);
  const projectId = requireString(request.payload, 'project_id');
  const plannedOn = date(request.payload, 'planned_on');
  const criterion = requireString(request.payload, 'criterion');
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'milestone',
    authorityDomain: 'project',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await typedRow(request.actionType, () =>
    tx.query(
      `insert into work.milestone (id, project_id, planned_on, criterion)
       values ($1, $2, $3, $4)`,
      [id, projectId, plannedOn, criterion],
    ),
  );
  return [id];
};

/**
 * The ontology's `acceptance_criteria`: a list of non-blank strings, empty by default. A criterion
 * is what an acceptance record's `criteria_results` are later judged against, so each is one
 * checkable statement, not a paragraph.
 */
function acceptanceCriteria(payload: Readonly<Record<string, unknown>> | undefined): string[] {
  const value = payload?.['acceptance_criteria'];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ACCEPTANCE_CRITERIA) {
    throw new PayloadInvalid(
      'acceptance_criteria',
      `acceptance_criteria must be a list of at most ${MAX_ACCEPTANCE_CRITERIA} strings`,
    );
  }
  return value.map((criterion: unknown) => {
    if (
      typeof criterion !== 'string' ||
      criterion.trim() === '' ||
      criterion.trim().length > MAX_CRITERION_LENGTH
    ) {
      throw new PayloadInvalid(
        'acceptance_criteria',
        `each acceptance criterion must be a non-blank string of at most ${MAX_CRITERION_LENGTH} characters`,
      );
    }
    return criterion.trim();
  });
}

/**
 * `define_deliverable` — what a work package must hand over, and what "done" means for it. Writes
 * the ontology's `deliverable` fields: `work_package` (required), `work_order` (optional; it must
 * cover the package), `description`, `acceptance_criteria` and `due_date`. `artifact_refs` are the
 * deliverable's submissions, recorded when work is submitted, not here.
 */
export const defineDeliverable: ActionMaterializer = async (tx, request) => {
  refuseTargets(request.actionType, request.targetIds);
  const packageId = requireString(request.payload, 'work_package_id');
  const orderId = optionalString(request.payload, 'work_order_id');
  const description = requireString(request.payload, 'description');
  const criteria = acceptanceCriteria(request.payload);
  const dueDate = optionalDate(request.payload, 'due_date');
  const id = await createControlledObject(tx, {
    ...classificationFrom(request.payload),
    objectType: 'deliverable',
    authorityDomain: 'project',
    lifecycleState: 'planned',
    title: requireString(request.payload, 'title'),
    organizationId: request.organizationId,
    createdBy: request.actorId,
  });
  await typedRow(request.actionType, () =>
    tx.query(
      `insert into work.deliverable
         (id, work_package_id, work_order_id, description, acceptance_criteria, due_date)
       values ($1, $2, $3, $4, $5::text[], $6)`,
      [id, packageId, orderId, description, criteria, dueDate],
    ),
  );
  return [id];
};
