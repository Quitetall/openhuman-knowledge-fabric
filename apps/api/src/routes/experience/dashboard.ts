/**
 * The dashboard: one layout for everyone, every panel scoped by grants (ADR 0040 decision 2;
 * KF-SAS-RQ-262).
 *
 * `DASHBOARD_LAYOUT` is the layout. It is a constant, and nothing in this module reads a role, a
 * title or a person's name to decide which panels exist or in what order: the owner, an engineer
 * and a person with one grant get the same six panels in the same order, and only what is inside
 * them differs, because each is evaluated under the reader's own grants. A panel with nothing in
 * scope says so (`empty`), and the application collapses it. `tests/conformance/no-role-branch.test.ts`
 * refuses a role or title literal anywhere in this module and in the web dashboard.
 *
 * Needs you is a slot: its contents are KF-WAR-0004's (milestone M2) and are read by its own
 * route. The dashboard names the slot in its place in the layout and supplies nothing for it, so
 * the two milestones cannot disagree about what the panel shows.
 */

import { enumerateAccessCoverage, type AccessCoverage } from '@kf/authorization';
import type { Tx } from '@kf/database';
import {
  latestMasterRecordClaim,
  readOrganizationOverview,
  type OverviewAnswer,
} from '@kf/documents';
import type { ProjectionDefinitionSet } from '@kf/projections';
import { grantedRecords, type GrantedRecord } from './granted-records.js';

export const DASHBOARD_FORMAT = 'kf-dashboard-v1' as const;

/** The one layout (RQ-262). Order is presentation order. */
export const DASHBOARD_LAYOUT = [
  'overview',
  'master_document',
  'needs_you',
  'work_in_flight',
  'recent_record',
  'people',
] as const;

export type DashboardPanelId = (typeof DASHBOARD_LAYOUT)[number];

/** Records the overview and People panels speak about; Recent record lists the rest. */
const PEOPLE_AND_ROLES = ['person', 'role_assignment', 'organization', 'organization_overview'];

/** Record types whose lifecycle is work: what Work in flight lists while it is still moving. */
export const WORK_TYPES = [
  'initiative_project',
  'engagement',
  'work_package',
  'work_order',
  'work_execution',
  'work_order_amendment',
  'milestone',
  'deliverable',
  'decision_record',
  'change_record',
  'risk',
  'nonconformity',
  'capa',
  'complaint',
  'controlled_document',
  'test_execution',
  'acceptance_record',
  'invoice',
  'warrant',
] as const;

const OVERVIEW_STATEMENTS_PER_SECTION = 5;
const LIST_LIMIT = 12;

export interface Reader {
  readonly actorId: string;
  readonly organizationId: string;
}

export interface OverviewPanel {
  readonly id: 'overview';
  readonly empty: boolean;
  readonly overview?: Extract<OverviewAnswer, { status: 'ready' }>;
}

export interface MasterDocumentPanel {
  readonly id: 'master_document';
  readonly empty: false;
  readonly claim:
    | { readonly status: 'missing' }
    | {
        readonly status: 'compiled';
        readonly id: string;
        readonly compiledAt: string;
        readonly corpusDigest: string;
        readonly memberCount: number;
        /**
         * `current` when the database's record of writes shows nothing the claim depends on has
         * changed (§58); `unknown` otherwise. Deciding "stale" would mean recounting the whole
         * corpus, which the dashboard never does: the master-document page offers to recompile.
         */
        readonly currency: 'current' | 'unknown';
      };
}

export interface NeedsYouPanel {
  readonly id: 'needs_you';
  /** Supplied by KF-WAR-0004's route and component; the dashboard reserves its place only. */
  readonly slot: 'needs-you';
}

export interface ListPanel<Id extends 'work_in_flight' | 'recent_record'> {
  readonly id: Id;
  readonly empty: boolean;
  readonly total: number;
  readonly records: readonly GrantedRecord[];
}

export interface PeoplePanel {
  readonly id: 'people';
  readonly empty: boolean;
  /** The reader's own live role assignments and the roles their presets reach. */
  readonly assignments: readonly {
    readonly assignmentId: string;
    readonly roleId: string;
    readonly organizationWide: boolean;
    readonly validTo: string | null;
    readonly reaches: readonly (readonly string[])[];
  }[];
  /** Live read templates reaching the reader through roles, by the role path they came by. */
  readonly presetGrants: number;
  /** Qualification is KF-WAR-0007's (milestone M5); until then this panel names none. */
  readonly qualification: null;
}

export type DashboardPanel =
  | OverviewPanel
  | MasterDocumentPanel
  | NeedsYouPanel
  | ListPanel<'work_in_flight'>
  | ListPanel<'recent_record'>
  | PeoplePanel;

export interface Dashboard {
  readonly format: typeof DASHBOARD_FORMAT;
  readonly layout: typeof DASHBOARD_LAYOUT;
  readonly panels: readonly DashboardPanel[];
}

/** The overview as the dashboard shows it: every section, its first statements, and counts. */
export function overviewSummary(
  overview: Extract<OverviewAnswer, { status: 'ready' }>,
): Extract<OverviewAnswer, { status: 'ready' }> {
  return {
    ...overview,
    sections: overview.sections.map((section) => ({
      ...section,
      total: section.statements.length,
      statements: section.statements.slice(0, OVERVIEW_STATEMENTS_PER_SECTION),
    })),
  };
}

async function masterDocumentPanel(tx: Tx, reader: Reader): Promise<MasterDocumentPanel> {
  const claim = await latestMasterRecordClaim(tx, reader.actorId, reader.organizationId);
  if (claim === undefined)
    return { id: 'master_document', empty: false, claim: { status: 'missing' } };
  const facts = await tx.one<{ compiled_at: Date; members: string; current: string | null }>(
    `select /* experience.claim-header */ m.compiled_at,
            (select count(*) from content.master_record_item i
              where i.master_record_id = m.id and i.item_state = 'included')::text as members,
            content.master_record_current_format(m.id) as current
       from content.master_record m where m.id = $1`,
    [claim.id],
  );
  return {
    id: 'master_document',
    empty: false,
    claim: {
      status: 'compiled',
      id: claim.id,
      compiledAt: new Date(facts.compiled_at).toISOString(),
      corpusDigest: claim.corpusDigest,
      memberCount: Number(facts.members),
      currency: facts.current === null ? 'unknown' : 'current',
    },
  };
}

async function peoplePanel(tx: Tx, reader: Reader, coverage: AccessCoverage): Promise<PeoplePanel> {
  const held = await tx.query<{
    id: string;
    role_id: string;
    scope_id: string;
    valid_to: Date | null;
  }>(
    `select /* experience.held-assignments */ ra.id, ra.role_id, ra.scope_id, ra.valid_to
       from org.role_assignment ra
       join core.object o on o.id = ra.id
      where ra.subject_id = $1 and o.organization_id = $2 and o.lifecycle_state = 'active'
        and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now())
      order by ra.role_id, ra.id`,
    [reader.actorId, reader.organizationId],
  );
  const grants = [...coverage.organizationWide, ...[...coverage.byObject.values()].flat()];
  const preset = grants.filter((grant) => grant.source === 'role_preset');
  // The distinct role paths the reader's presets arrived by, grouped under the role each starts
  // from — the role of the assignment that carries them. Data grouped by its own key; nothing here
  // decides what to show from which role it is.
  const pathsByHeldRole = new Map<string, Map<string, readonly string[]>>();
  for (const grant of preset) {
    const [first] = grant.rolePath ?? [];
    if (first === undefined || grant.rolePath === undefined) continue;
    const paths = pathsByHeldRole.get(first) ?? new Map<string, readonly string[]>();
    paths.set(grant.rolePath.join('\u0000'), grant.rolePath);
    pathsByHeldRole.set(first, paths);
  }
  return {
    id: 'people',
    empty: held.length === 0,
    assignments: held.map((row) => ({
      assignmentId: row.id,
      roleId: row.role_id,
      organizationWide: row.scope_id === reader.organizationId,
      validTo: row.valid_to === null ? null : new Date(row.valid_to).toISOString(),
      reaches: [...(pathsByHeldRole.get(row.role_id)?.values() ?? [])].sort((a, b) =>
        a.join(' ').localeCompare(b.join(' ')),
      ),
    })),
    presetGrants: preset.length,
    qualification: null,
  };
}

/**
 * The dashboard for the bound reader. Every panel reads under the caller's row security and
 * through the one coverage, computed once.
 */
export async function readDashboard(
  tx: Tx,
  reader: Reader,
  projections: ProjectionDefinitionSet | undefined,
): Promise<Dashboard> {
  const coverage = await enumerateAccessCoverage(tx, reader.actorId, reader.organizationId);
  const definition = projections?.byId('organization_overview');
  const overview =
    definition === undefined
      ? ({ status: 'not_in_scope' } as const)
      : await readOrganizationOverview(
          tx,
          { personId: reader.actorId, organizationId: reader.organizationId },
          definition,
          coverage,
        );
  const work = await grantedRecords(tx, coverage, {
    organizationId: reader.organizationId,
    limit: LIST_LIMIT,
    types: WORK_TYPES,
    inFlight: true,
  });
  const recent = await grantedRecords(tx, coverage, {
    organizationId: reader.organizationId,
    limit: LIST_LIMIT,
    exclude: PEOPLE_AND_ROLES,
  });
  const panels: DashboardPanel[] = [
    overview.status === 'ready'
      ? { id: 'overview', empty: false, overview: overviewSummary(overview) }
      : { id: 'overview', empty: true },
    await masterDocumentPanel(tx, reader),
    { id: 'needs_you', slot: 'needs-you' },
    { id: 'work_in_flight', empty: work.total === 0, total: work.total, records: work.records },
    {
      id: 'recent_record',
      empty: recent.total === 0,
      total: recent.total,
      records: recent.records,
    },
    await peoplePanel(tx, reader, coverage),
  ];
  // The layout is the constant, and the panels are in its order; asserted, not assumed.
  if (panels.map((panel) => panel.id).join() !== DASHBOARD_LAYOUT.join()) {
    throw new Error('dashboard panels are out of the declared layout');
  }
  return { format: DASHBOARD_FORMAT, layout: DASHBOARD_LAYOUT, panels };
}
