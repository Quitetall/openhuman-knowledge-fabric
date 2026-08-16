import type { Pool } from '@kf/database';
import { scoped } from './scope.js';
import type {
  AgentScope,
  EvidenceItem,
  ExternalCitation,
  TracedEdge,
  VerificationSummary,
} from './types.js';

export async function traceRelations(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
  options: { readonly relationTypes?: readonly string[]; readonly maxDepth?: number } = {},
): Promise<readonly TracedEdge[]> {
  const depth = Math.min(Math.max(1, options.maxDepth ?? 3), 6);
  return scoped(pool, scope, async (tx) => {
    const rows = await tx.query<{
      relation_type: string;
      from_id: string;
      to_id: string;
      to_title: string;
      to_type: string;
      depth: number;
    }>(
      `with recursive walk(relation_type, from_id, to_id, depth, path) as (
         select r.relation_type, r.source_id, r.target_id, 1, array[r.source_id, r.target_id]
           from core.relation r
          where r.source_id = $1
            and ($2::text[] is null or r.relation_type = any($2))
         union all
         select r.relation_type, r.source_id, r.target_id, w.depth + 1, w.path || r.target_id
           from core.relation r
           join walk w on r.source_id = w.to_id
          where w.depth < $3
            and ($2::text[] is null or r.relation_type = any($2))
            and not r.target_id = any(w.path)
       )
       select w.relation_type, w.from_id, w.to_id, o.title as to_title, o.object_type as to_type,
              w.depth
         from walk w
         join core.object o on o.id = w.to_id
        order by w.depth, o.title`,
      [objectId, options.relationTypes === undefined ? null : [...options.relationTypes], depth],
    );
    return rows.map((r) => ({
      relationType: r.relation_type,
      fromId: r.from_id,
      toId: r.to_id,
      toTitle: r.to_title,
      toType: r.to_type,
      depth: Number(r.depth),
    }));
  });
}

export async function verificationOf(
  pool: Pool,
  scope: AgentScope,
  subjectId: string,
): Promise<VerificationSummary | undefined> {
  return scoped(pool, scope, async (tx) => {
    const visible = await tx.maybeOne<{ id: string }>('select id from core.object where id = $1', [
      subjectId,
    ]);
    if (visible === undefined) return undefined;
    const row = await tx.maybeOne<{
      verified: boolean;
      approved_definitions: string;
      definitions_passed: string;
      failed: string;
      invalidated: string;
      unexecuted: string;
    }>('select * from engineering.verification_status where subject_id = $1', [subjectId]);
    if (row === undefined) {
      return {
        subjectId,
        verified: false,
        approvedDefinitions: 0,
        definitionsPassed: 0,
        failed: 0,
        invalidated: 0,
        unexecuted: 0,
      };
    }
    return {
      subjectId,
      verified: row.verified,
      approvedDefinitions: Number(row.approved_definitions),
      definitionsPassed: Number(row.definitions_passed),
      failed: Number(row.failed),
      invalidated: Number(row.invalidated),
      unexecuted: Number(row.unexecuted),
    };
  });
}

export async function externalCitations(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<readonly ExternalCitation[]> {
  return scoped(pool, scope, async (tx) => {
    const rows = await tx.query<{
      source_id: string;
      repository: string;
      external_id: string;
      commit_sha: string;
      path: string;
      content_sha256: string;
      link_kind: string;
    }>(
      `select r.source_id, s.repository, r.external_id, r.commit_sha, r.path,
              r.content_sha256, l.link_kind
         from quality.federated_link l
         join quality.federated_reference r on r.id = l.reference_id
         join quality.federated_source s on s.id = r.source_id
         join core.object o on o.id = l.object_id
        where l.object_id = $1
        order by r.source_id, r.external_id`,
      [objectId],
    );
    return rows.map((r) => ({
      source: r.source_id,
      repository: r.repository,
      externalId: r.external_id,
      commitSha: r.commit_sha,
      path: r.path,
      contentSha256: r.content_sha256,
      linkKind: r.link_kind,
    }));
  });
}

export async function evidenceFor(
  pool: Pool,
  scope: AgentScope,
  objectId: string,
): Promise<readonly EvidenceItem[]> {
  return scoped(pool, scope, async (tx) => {
    const rows = await tx.query<{
      id: string;
      artifact_id: string;
      version_no: number;
      media_type: string;
      sha256: string;
      size_bytes: string;
    }>(
      `select v.id, v.artifact_id, v.version_no, v.media_type, v.sha256, v.size_bytes
         from content.artifact_version v
         join core.object o on o.id = v.artifact_id
        where v.artifact_id = $1
        order by v.version_no`,
      [objectId],
    );
    return rows.map((r) => ({
      versionId: r.id,
      artifactId: r.artifact_id,
      versionNo: Number(r.version_no),
      mediaType: r.media_type,
      sha256: r.sha256,
      sizeBytes: r.size_bytes,
    }));
  });
}
