/**
 * The living organization overview (ADR 0040 decision 3; KF-SAS-RQ-267, RQ-268).
 *
 * WHAT IT IS. An ordinary record, `organization_overview`, declared by an institutional act and
 * granted like any other. It reaches a reader only through that reader's grants: a person granted
 * nothing receives a master record and no overview; a person granted the overview finds it in
 * their master record. It holds no text of its own.
 *
 * WHAT IT SAYS is generated, per reader, at the moment it is read: the `organization_overview`
 * projection (ontology/projections.yaml) evaluated by the one projection engine over the reader's
 * own corpus — the permitted set the master record compiles, live, restricted to the record types
 * the definition declares. Each statement IS a member of that corpus, so it links to its source
 * record by construction and cannot be about anything the reader could not open. A source the
 * reader can see under row security but no grant reaches is withheld and counted, as one number
 * (ADR 0037): never its title, type or id, and never anything above the reader's ceiling, which
 * row security does not show at all.
 *
 * WHY GENERATED AND NOT STORED. Regenerating it as an act would write text evaluated under
 * somebody's corpus into a record everyone granted it would then read: a statement drawn from a
 * restricted record would reach an engineer, or the overview would have to be written at the
 * lowest reader's level and say nothing to anyone else. It would also be stale from the next
 * write on. A derived projection is evaluated over each reader's corpus, is never stale, and its
 * digest says exactly what that reader was shown.
 */

import { ActionRejected, type ActionEffect, type ActionMaterializer } from '@kf/actions';
import { coveringGrants, enumerateAccessCoverage, type AccessCoverage } from '@kf/authorization';
import { taggedDigest } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import { recordVerification, type RecordVerification } from '@kf/domain';
import {
  projectTypeScoped,
  typeScope,
  type ProjectionMember,
  type ProjectionResult,
} from '@kf/projections';
import { classificationFrom, createControlledObject, PayloadInvalid } from '@kf/record-atoms';
import type { PermissionMember } from './master-record.js';
import { enumeratePermittedSet } from './master-record-repository.js';

type ProjectionDefinition = Parameters<typeof projectTypeScoped>[0]['definition'];

export const ORGANIZATION_OVERVIEW_ACTION_IDS = [
  'declare_organization_overview',
  'retire_organization_overview',
] as const;

export const ORGANIZATION_OVERVIEW_FORMAT = 'kf-organization-overview-v1' as const;

// ── Acts ─────────────────────────────────────────────────────────────────────────────────────

/**
 * `declare_organization_overview` creates the record. It must target the organization: the
 * overview is what the organization says about itself, so declaring one needs act authority over
 * the whole organization (`requires: act`). At most one is active per organization
 * (20261007200100); a second is refused, not merged.
 */
const declareOrganizationOverview: ActionMaterializer = async (tx, request) => {
  if (!request.targetIds.includes(request.organizationId)) {
    throw new ActionRejected(
      'precondition_failed',
      'declare_organization_overview must target the organization it describes',
    );
  }
  const title =
    typeof request.payload?.['title'] === 'string' && request.payload['title'].trim() !== ''
      ? request.payload['title'].trim()
      : 'Organization overview';
  try {
    const id = await createControlledObject(tx, {
      ...classificationFrom(request.payload),
      objectType: 'organization_overview',
      authorityDomain: 'organization',
      lifecycleState: 'active',
      title,
      organizationId: request.organizationId,
      createdBy: request.actorId,
    });
    return [id];
  } catch (error: unknown) {
    if ((error as { code?: string }).code === '23505') {
      throw new ActionRejected(
        'precondition_failed',
        'this organization already has an active overview; retire it before declaring another',
      );
    }
    if (error instanceof PayloadInvalid) throw error;
    throw error;
  }
};

/** The declared overview is checked again once the targets are locked: the organization is one. */
const confirmOrganizationTarget: ActionEffect = async (_tx, request, objects) => {
  const organization = objects.find(
    (object) =>
      request.targetIds.includes(object.id) &&
      object.object_type === 'organization' &&
      object.id === object.organization_id,
  );
  if (organization === undefined) {
    throw new ActionRejected(
      'precondition_failed',
      `${request.actionType} must target the organization it describes`,
    );
  }
};

export const ORGANIZATION_OVERVIEW_MATERIALIZERS: Readonly<Record<string, ActionMaterializer>> = {
  declare_organization_overview: declareOrganizationOverview,
};

export const ORGANIZATION_OVERVIEW_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  declare_organization_overview: confirmOrganizationTarget,
};

// ── Reading ──────────────────────────────────────────────────────────────────────────────────

export interface OverviewReader {
  readonly personId: string;
  readonly organizationId: string;
}

/** One sentence of the overview, and the record it is drawn from. */
export interface OverviewStatement {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string | null;
  readonly classification: string;
  readonly verification: RecordVerification;
  readonly text: string;
}

export interface OverviewSection {
  readonly id: string;
  readonly title: string;
  readonly statements: readonly OverviewStatement[];
  /** Set when `statements` is a leading part of the section: how many it has in all. */
  readonly total?: number;
}

export interface OrganizationOverviewReading {
  readonly format: typeof ORGANIZATION_OVERVIEW_FORMAT;
  readonly overview: {
    readonly id: string;
    readonly title: string;
    readonly classification: string;
    readonly verification: RecordVerification;
  };
  readonly sections: readonly OverviewSection[];
  /**
   * Sources of the declared types the reader can see under row security that no grant reaches,
   * or that an exclusion or a hold withholds from them: one count, within the reader's ceiling
   * (ADR 0037). Nothing above the ceiling is visible to count.
   */
  readonly withheld: number;
  /** Members of the reader's whole corpus, and how many of them are statements. */
  readonly corpusMemberCount: number;
  readonly statementCount: number;
  readonly projection: {
    readonly definition: ProjectionResult['definition'];
    readonly projectionDigest: string;
    readonly scopeDigest: string;
  };
}

export type OverviewAnswer =
  | { readonly status: 'not_in_scope' }
  | ({ readonly status: 'ready' } & OrganizationOverviewReading);

const CLASSIFICATION_RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

const TYPE_LABEL: Readonly<Record<string, string>> = {
  organization: 'The organization',
  organization_overview: 'This overview',
  initiative_project: 'Project',
  engagement: 'Engagement',
  work_package: 'Work package',
  work_order: 'Work order',
  milestone: 'Milestone',
  deliverable: 'Deliverable',
  decision_record: 'Decision',
  change_record: 'Change',
  risk: 'Risk',
  nonconformity: 'Nonconformity',
  capa: 'Corrective action',
  complaint: 'Complaint',
  product_system: 'Product',
  requirement: 'Requirement',
  release: 'Release',
  baseline: 'Baseline',
  supplier: 'Supplier',
  configuration_item: 'Configuration item',
  controlled_document: 'Controlled document',
  person: 'Person',
  role_assignment: 'Role assignment',
};

/** One deterministic sentence per member: what it is, what it is called, and where it stands. */
export function overviewStatementText(member: {
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string | null;
}): string {
  const label = TYPE_LABEL[member.objectType] ?? member.objectType.replace(/_/g, ' ');
  const state =
    member.lifecycleState === null ? '' : ` is ${member.lifecycleState.replace(/_/g, ' ')}`;
  return `${label} “${member.title}”${state}.`;
}

function lifecycleOf(member: PermissionMember): string | null {
  const envelope = member.content?.['core.object'];
  const state =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as { lifecycle_state?: unknown }).lifecycle_state
      : undefined;
  return typeof state === 'string' ? state : null;
}

function verificationOf(member: PermissionMember): RecordVerification {
  return recordVerification(
    member.verified === undefined
      ? undefined
      : {
          basis: member.verified.basis,
          verifiedAt: member.verified.at,
          verifiedBy: member.verified.by,
        },
  );
}

/**
 * How many members the reader's whole corpus has, counted where it lives rather than enumerated:
 * every object row security shows the reader that a live read grant covers at its
 * classification, less exclusions and holds — `enumeratePermittedSet`'s rule, as a count.
 */
export async function countPermitted(
  tx: Tx,
  reader: OverviewReader,
  coverage: AccessCoverage,
): Promise<number> {
  const rankOf = (ceiling: string | null): number =>
    ceiling === null ? 99 : (CLASSIFICATION_RANK[ceiling] ?? -1);
  const organizationRank = Math.max(
    -1,
    ...coverage.organizationWide.map((g) => rankOf(g.classificationCeiling)),
  );
  const objectIds: string[] = [];
  const objectRanks: number[] = [];
  for (const [id, grants] of coverage.byObject) {
    objectIds.push(id);
    objectRanks.push(Math.max(-1, ...grants.map((g) => rankOf(g.classificationCeiling))));
  }
  const row = await tx.one<{ n: string }>(
    `with object_grant(id, ceiling_rank) as (
       select * from unnest($3::uuid[], $4::int[])
     )
     select /* overview.permitted-count */ count(*)::text as n
       from core.object o
       join registry.classification c on c.id = o.classification
      where o.organization_id = $1
        and (c.rank <= $2
             or exists (select 1 from object_grant g where g.id = o.id and c.rank <= g.ceiling_rank))
        and not exists (
              select 1 from content.person_entitlement_exclusion x
               where x.subject_id = $5 and x.organization_id = $1 and x.object_id = o.id
                 and x.released_at is null)
        and not exists (
              select 1 from core.retention_hold h
               where h.object_id = o.id and h.released_at is null)`,
    [reader.organizationId, organizationRank, objectIds, objectRanks, reader.personId],
  );
  return Number(row.n);
}

/**
 * The overview as this reader may read it, or `not_in_scope` when no grant reaches the overview
 * record — in which case nothing about it is said, not even that one exists. Evaluated under the
 * caller's bound context; widens nothing.
 */
export async function readOrganizationOverview(
  tx: Tx,
  reader: OverviewReader,
  definition: ProjectionDefinition,
  /** The reader's coverage, when the caller has already read it for this request. */
  known?: AccessCoverage,
): Promise<OverviewAnswer> {
  const types = typeScope(definition);
  const coverage =
    known ?? (await enumerateAccessCoverage(tx, reader.personId, reader.organizationId));
  const overview = await tx.maybeOne<{ id: string; title: string; classification: string }>(
    `select /* overview.record */ id, title, classification from core.object
      where organization_id = $1 and object_type = 'organization_overview'
        and lifecycle_state = 'active'`,
    [reader.organizationId],
  );
  if (
    overview === undefined ||
    coveringGrants(coverage, overview.id, overview.classification).length === 0
  ) {
    return { status: 'not_in_scope' };
  }
  // Every source of the declared types the reader can see, then the permitted ones among them by
  // the master record's own rule. What is visible and not permitted is withheld.
  const visible = await tx.query<{ id: string }>(
    `select /* overview.visible-sources */ id from core.object
      where organization_id = $1 and object_type = any($2::text[])`,
    [reader.organizationId, [...types]],
  );
  const permitted =
    visible.length === 0
      ? []
      : await enumeratePermittedSet(
          tx,
          reader.personId,
          reader.organizationId,
          undefined,
          visible.map((row) => row.id),
        );
  const overviewMember = permitted.find((member) => member.objectId === overview.id);
  if (overviewMember === undefined) return { status: 'not_in_scope' };
  const corpusMemberCount = Math.max(permitted.length, await countPermitted(tx, reader, coverage));
  const members: ProjectionMember[] = permitted.map((member) => {
    const lifecycleState = lifecycleOf(member);
    return {
      objectId: member.objectId,
      objectType: member.objectType,
      organizationId: member.organizationId,
      classification: member.classification,
      contentDigest: member.contentDigest,
      itemState: 'included',
      verification: verificationOf(member),
      ...(lifecycleState === null ? {} : { lifecycleState }),
      ...(member.title === undefined ? {} : { title: member.title }),
    };
  });
  // The identity of what this reading read: the reader's live corpus restricted to the declared
  // types. It is not a master record's corpus digest, and is not named as one.
  const scopeDigest = taggedDigest('kf-organization-overview-scope-v1', {
    personId: reader.personId,
    organizationId: reader.organizationId,
    members: [...members]
      .sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0))
      .map((m) => [m.objectId, m.contentDigest]),
  });
  const result = projectTypeScoped({
    definition,
    parameters: {},
    corpus: {
      personId: reader.personId,
      organizationId: reader.organizationId,
      corpusDigest: scopeDigest,
      members,
      corpusMemberCount,
    },
    graph: { edges: [], policies: [] },
  });
  const sections: OverviewSection[] = result.sections
    .filter((section) => section.members.length > 0)
    .map((section) => ({
      id: section.id,
      title: section.title,
      statements: section.members.map((member) => {
        const lifecycleState = member.lifecycleState ?? null;
        const title = member.title ?? member.objectId;
        return {
          objectId: member.objectId,
          objectType: member.objectType,
          title,
          lifecycleState,
          classification: member.classification,
          verification: member.verification,
          text: overviewStatementText({ objectType: member.objectType, title, lifecycleState }),
        };
      }),
    }));
  return {
    status: 'ready',
    format: ORGANIZATION_OVERVIEW_FORMAT,
    overview: {
      id: overview.id,
      title: overview.title,
      classification: overview.classification,
      verification: verificationOf(overviewMember),
    },
    sections,
    withheld: visible.length - permitted.length,
    corpusMemberCount,
    statementCount: result.measurements.memberCount,
    projection: {
      definition: result.definition,
      projectionDigest: result.projectionDigest,
      scopeDigest,
    },
  };
}
