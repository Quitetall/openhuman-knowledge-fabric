import type {
  AiContextCandidate,
  AiContextPlannerRepository,
  AiContextPlannerScope,
} from '@kf/agent-tools';
import type { Tx } from '@kf/database';

interface PlannerContextRow extends Record<string, unknown> {
  readonly subject_id: string;
  readonly revision_id: string;
  readonly classification: 'public' | 'internal' | 'confidential' | 'restricted';
  readonly content_digest: string;
  readonly revision_digest: string;
  readonly media_type: string;
  readonly stable_key: string;
  readonly title: string;
  readonly updated_at: Date;
  readonly lexical_score?: string | number | null;
  readonly relation_depth?: string | number | null;
}

export class DocumentPlannerRepository implements AiContextPlannerRepository {
  constructor(
    private readonly tx: Tx,
    private readonly basisId: string,
  ) {}

  async authorizedLexicalCandidates(
    _scope: AiContextPlannerScope,
    query: string,
  ): Promise<readonly AiContextCandidate[]> {
    const rows = await this.tx.query<PlannerContextRow>(
      `select /* document.ai-lexical-context */
              subject.id as subject_id, revision.id as revision_id, revision.classification,
              revision.content_digest, revision.revision_digest, revision.media_type,
              subject.stable_key, object.title, revision.created_at as updated_at,
              case
                when object.title ilike '%' || $2 || '%' then 1.0
                when subject.stable_key ilike '%' || $2 || '%' then 0.7
                else 0.2
              end as lexical_score
         from content.compilation_basis_fragment member
         join content.authored_fragment_revision revision
           on revision.id = member.fragment_revision_id
         join content.document_subject subject
           on subject.id = revision.fragment_id and subject.subject_kind = 'fragment'
         join core.object object on object.id = subject.object_id
        where member.basis_id = $1
          and (
            object.title ilike '%' || $2 || '%'
            or subject.stable_key ilike '%' || $2 || '%'
            or revision.content_digest = $2
            or revision.revision_digest = $2
          )
        order by lexical_score desc, revision.created_at desc, subject.id, revision.id
        limit 64`,
      [this.basisId, query],
    );
    return rows.map((row) => toCandidate(row));
  }

  async authorizedTypedRelationCandidates(
    _scope: AiContextPlannerScope,
    seeds: readonly string[],
  ): Promise<readonly AiContextCandidate[]> {
    if (seeds.length === 0) return [];
    const rows = await this.tx.query<PlannerContextRow>(
      `select /* document.ai-seed-context */
              subject.id as subject_id, revision.id as revision_id, revision.classification,
              revision.content_digest, revision.revision_digest, revision.media_type,
              subject.stable_key, object.title, revision.created_at as updated_at,
              0 as relation_depth
         from content.compilation_basis_fragment member
         join content.authored_fragment_revision revision
           on revision.id = member.fragment_revision_id
         join content.document_subject subject
           on subject.id = revision.fragment_id and subject.subject_kind = 'fragment'
         join core.object object on object.id = subject.object_id
        where member.basis_id = $1
          and subject.id = any($2::uuid[])
        order by subject.id, revision.id
        limit 64`,
      [this.basisId, seeds],
    );
    return rows.map((row) => toCandidate(row));
  }

  async authorizeSelectedCandidates(
    _scope: AiContextPlannerScope,
    candidates: readonly AiContextCandidate[],
  ): Promise<readonly AiContextCandidate[]> {
    if (candidates.length === 0) return [];
    const rows = await this.tx.query<PlannerContextRow>(
      `select /* document.ai-authorize-context */
              subject.id as subject_id, revision.id as revision_id, revision.classification,
              revision.content_digest, revision.revision_digest, revision.media_type,
              subject.stable_key, object.title, revision.created_at as updated_at
         from content.compilation_basis_fragment member
         join content.authored_fragment_revision revision
           on revision.id = member.fragment_revision_id
         join content.document_subject subject
           on subject.id = revision.fragment_id and subject.subject_kind = 'fragment'
         join core.object object on object.id = subject.object_id
        where member.basis_id = $1
          and (subject.id::text, revision.id::text) in (
            select pair.subject_id, pair.revision_id
              from jsonb_to_recordset($2::jsonb) as pair(subject_id text, revision_id text)
          )
        order by subject.id, revision.id`,
      [
        this.basisId,
        JSON.stringify(
          candidates.map((candidate) => ({
            subject_id: candidate.subjectId,
            revision_id: candidate.revisionId,
          })),
        ),
      ],
    );
    return rows.map((row) => toCandidate(row));
  }
}

function toCandidate(row: PlannerContextRow): AiContextCandidate {
  const content = [
    `title: ${row.title}`,
    `stable_key: ${row.stable_key}`,
    `media_type: ${row.media_type}`,
    `content_digest: ${row.content_digest}`,
    `revision_digest: ${row.revision_digest}`,
  ].join('\n');
  const candidate: AiContextCandidate = {
    subjectId: row.subject_id,
    revisionId: row.revision_id,
    classification: row.classification,
    kind: 'document',
    content,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    provenanceDigest: row.revision_digest,
    sourceDigest: row.content_digest,
    updatedAt: row.updated_at.toISOString(),
    verified: row.revision_digest === row.content_digest,
    ...(row.lexical_score === null || row.lexical_score === undefined
      ? {}
      : { lexicalScore: Number(row.lexical_score) }),
    ...(row.relation_depth === null || row.relation_depth === undefined
      ? {}
      : { relationDepth: Number(row.relation_depth) }),
  };
  return Object.freeze(candidate);
}
