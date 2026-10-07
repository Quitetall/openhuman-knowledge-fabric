/**
 * The master-document page: a person's scope, compiled, read as one document (ADR 0040
 * decision 3; KF-SAS-RQ-267).
 *
 * The document is the reader's latest master record (§57) and has no other input. The living
 * organization overview stands at its head when — and only when — the reader's grants reach the
 * overview record; it is generated over the reader's own corpus (`readOrganizationOverview`).
 *
 * IT MUST READ AT THE SIZE OF AN ORGANIZATION. A reader of fifty thousand records cannot be sent
 * fifty thousand items, and the page cannot recount the corpus to decide whether the claim is
 * current (§100.42, §100.43). So it reads the claim the way its stored items allow: one count per
 * record type, and pages of one type at a time by the items' own index. Currency is asked of the
 * database's record of writes only; when that cannot show the claim current the page says
 * "unknown" and offers to compile, rather than recounting.
 *
 * A CLAIM IS NOT A LICENCE. A compilation can be older than a revocation, so every item a page
 * shows is read again, live, under the reader's row security and through the one grant coverage,
 * exactly as every other read surface reads: an item no longer readable is not shown — not its
 * title, not its id — and is counted as no longer in scope.
 */

import { coveringGrants, enumerateAccessCoverage, type AccessCoverage } from '@kf/authorization';
import type { Tx } from '@kf/database';
import {
  latestMasterRecordClaim,
  readOrganizationOverview,
  type OverviewAnswer,
} from '@kf/documents';
import { recordVerification, type RecordVerification } from '@kf/domain';
import type { ProjectionDefinitionSet } from '@kf/projections';

export const MASTER_DOCUMENT_FORMAT = 'kf-master-document-v1' as const;
export const MASTER_DOCUMENT_PAGE_LIMIT = 50;
const FIRST_PAGE = 8;

export interface MasterDocumentItem {
  readonly objectId: string;
  readonly objectType: string;
  readonly title: string;
  readonly lifecycleState: string;
  readonly classification: string;
  readonly verification: RecordVerification;
}

export interface MasterDocumentSection {
  readonly objectType: string;
  readonly title: string;
  /** Members of this type in the compiled claim. */
  readonly count: number;
  readonly items: readonly MasterDocumentItem[];
  /** Items of this page the compilation held that the reader can no longer read: a count only. */
  readonly noLongerInScope: number;
  /** Cursor for the next page of this section, or null at its end. */
  readonly next: string | null;
}

export interface MasterDocument {
  readonly format: typeof MASTER_DOCUMENT_FORMAT;
  readonly claim:
    | { readonly status: 'missing' }
    | {
        readonly status: 'compiled';
        readonly id: string;
        readonly compiledAt: string;
        readonly corpusDigest: string;
        readonly memberCount: number;
        readonly currency: 'current' | 'unknown';
      };
  readonly overview: Extract<OverviewAnswer, { status: 'ready' }> | null;
  readonly sections: readonly MasterDocumentSection[];
}

export interface MasterDocumentQuery {
  /** One section, paged; absent, every section's first page. */
  readonly objectType?: string;
  readonly after?: string;
  readonly limit?: number;
}

interface Reader {
  readonly actorId: string;
  readonly organizationId: string;
}

async function sectionPage(
  tx: Tx,
  coverage: AccessCoverage,
  claimId: string,
  objectType: string,
  after: string | undefined,
  limit: number,
): Promise<Omit<MasterDocumentSection, 'title' | 'count'>> {
  const ids = await tx.query<{ object_id: string }>(
    `select /* master-document.page */ object_id from content.master_record_item
      where master_record_id = $1 and item_state = 'included' and object_type = $2
        and ($3::uuid is null or object_id > $3::uuid)
      order by object_id
      limit $4`,
    [claimId, objectType, after ?? null, limit + 1],
  );
  const page = ids.slice(0, limit).map((row) => row.object_id);
  const next = ids.length > limit ? page[page.length - 1]! : null;
  if (page.length === 0) return { objectType, items: [], noLongerInScope: 0, next };
  // Read live: what the record says now, under the reader's row security and grants.
  const live = await tx.query<{
    id: string;
    object_type: string;
    title: string;
    lifecycle_state: string;
    classification: string;
    basis: 'reviewed_individually' | 'promoted_in_bulk' | null;
    verified_at: Date | null;
    verified_by: string | null;
  }>(
    `select /* master-document.live */ o.id, o.object_type, o.title, o.lifecycle_state,
            o.classification, v.basis, v.verified_at, v.verified_by
       from core.object o
       left join core.object_verification v on v.object_id = o.id
      where o.id = any($1::uuid[])`,
    [page],
  );
  const readable = live.filter(
    (row) => coveringGrants(coverage, row.id, row.classification).length > 0,
  );
  const byId = new Map(readable.map((row) => [row.id, row]));
  const items: MasterDocumentItem[] = [];
  for (const id of page) {
    const row = byId.get(id);
    if (row === undefined) continue;
    items.push({
      objectId: row.id,
      objectType: row.object_type,
      title: row.title,
      lifecycleState: row.lifecycle_state,
      classification: row.classification,
      verification: recordVerification(
        row.basis === null || row.verified_at === null || row.verified_by === null
          ? undefined
          : {
              basis: row.basis,
              verifiedAt: new Date(row.verified_at).toISOString(),
              verifiedBy: row.verified_by,
            },
      ),
    });
  }
  return { objectType, items, noLongerInScope: page.length - items.length, next };
}

export async function readMasterDocument(
  tx: Tx,
  reader: Reader,
  projections: ProjectionDefinitionSet | undefined,
  query: MasterDocumentQuery = {},
): Promise<MasterDocument> {
  // One coverage for the whole page: the overview and every section are read through it.
  const coverage = await enumerateAccessCoverage(tx, reader.actorId, reader.organizationId);
  const definition = projections?.byId('organization_overview');
  const overviewAnswer =
    definition === undefined
      ? undefined
      : await readOrganizationOverview(
          tx,
          { personId: reader.actorId, organizationId: reader.organizationId },
          definition,
          coverage,
        );
  const overview = overviewAnswer?.status === 'ready' ? overviewAnswer : null;
  const claim = await latestMasterRecordClaim(tx, reader.actorId, reader.organizationId);
  if (claim === undefined) {
    return { format: MASTER_DOCUMENT_FORMAT, claim: { status: 'missing' }, overview, sections: [] };
  }
  const header = await tx.one<{ compiled_at: Date; current: string | null }>(
    `select /* master-document.header */ compiled_at,
            content.master_record_current_format(id) as current
       from content.master_record where id = $1`,
    [claim.id],
  );
  const counts = await tx.query<{ object_type: string; title: string; n: string }>(
    `select /* master-document.counts */ i.object_type, t.title, count(*)::text as n
       from content.master_record_item i
       join registry.object_type t on t.id = i.object_type
      where i.master_record_id = $1 and i.item_state = 'included'
      group by i.object_type, t.title
      order by t.title, i.object_type`,
    [claim.id],
  );
  const limit = Math.min(Math.max(query.limit ?? FIRST_PAGE, 1), MASTER_DOCUMENT_PAGE_LIMIT);
  const wanted =
    query.objectType === undefined
      ? counts
      : counts.filter((row) => row.object_type === query.objectType);
  const sections: MasterDocumentSection[] = [];
  for (const row of wanted) {
    const page = await sectionPage(
      tx,
      coverage,
      claim.id,
      row.object_type,
      query.objectType === undefined ? undefined : query.after,
      limit,
    );
    sections.push({ ...page, title: row.title, count: Number(row.n) });
  }
  return {
    format: MASTER_DOCUMENT_FORMAT,
    claim: {
      status: 'compiled',
      id: claim.id,
      compiledAt: new Date(header.compiled_at).toISOString(),
      corpusDigest: claim.corpusDigest,
      memberCount: counts.reduce((n, row) => n + Number(row.n), 0),
      currency: header.current === null ? 'unknown' : 'current',
    },
    overview,
    sections,
  };
}
