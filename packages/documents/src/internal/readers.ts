import { type JsonValue } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import {
  type DocumentAtom,
  type DocumentAtomKind,
  type DocumentParseLoss,
} from './parse-contract.js';

/** Reader-facing name; `DocumentAtom` remains only as the legacy persisted parse contract. */
export type ParsedBlock = DocumentAtom;

export interface DocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly documentNumber: string;
  readonly revision: string;
  readonly documentClass: string;
  readonly lifecycleState: string;
  readonly rowVersion: string;
  readonly mediaType: string | null;
  readonly sha256: string | null;
  readonly parsedBlockCount: number;
}

export interface DocumentDetail extends DocumentSummary {
  readonly owningRole: string;
  readonly contentVersionId: string | null;
  readonly sizeBytes: number | null;
  readonly parser: string | null;
  readonly parserVersion: string | null;
  readonly projectionContract: string | null;
  readonly conversionLoss: readonly DocumentParseLoss[];
  readonly contentDigest: string | null;
  readonly parsedBlocks: readonly ParsedBlock[];
}

export async function listDocuments(tx: Tx): Promise<DocumentSummary[]> {
  const rows = await tx.query<{
    id: string;
    title: string;
    document_number: string;
    revision: string;
    document_class: string;
    lifecycle_state: string;
    row_version: string;
    media_type: string | null;
    sha256: string | null;
    parsed_block_count: string;
  }>(
    `select o.id, o.title, d.document_number, d.revision, d.document_class,
            o.lifecycle_state, o.row_version, v.media_type, v.sha256,
            (select count(*)::text from content.document_atom a where a.parse_id = p.id)
              as parsed_block_count
       from core.object o
       join quality.controlled_document d on d.id = o.id
       left join content.artifact_version v on v.id = d.content_version
       left join content.document_parse p on p.artifact_version_id = v.id
      order by d.document_number, d.revision desc`,
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    documentNumber: row.document_number,
    revision: row.revision,
    documentClass: row.document_class,
    lifecycleState: row.lifecycle_state,
    rowVersion: row.row_version,
    mediaType: row.media_type,
    sha256: row.sha256,
    parsedBlockCount: Number(row.parsed_block_count),
  }));
}

export async function getDocument(tx: Tx, id: string): Promise<DocumentDetail | undefined> {
  const row = await tx.maybeOne<{
    id: string;
    title: string;
    document_number: string;
    revision: string;
    document_class: string;
    lifecycle_state: string;
    row_version: string;
    owning_role: string;
    content_version_id: string | null;
    media_type: string | null;
    sha256: string | null;
    size_bytes: string | null;
    parser: string | null;
    parser_version: string | null;
    projection_contract: string | null;
    conversion_loss: DocumentParseLoss[] | null;
    content_digest: string | null;
    parsed_block_count: string;
    parse_id: string | null;
  }>(
    `select o.id, o.title, d.document_number, d.revision, d.document_class,
            o.lifecycle_state, o.row_version, d.owning_role, d.content_version as content_version_id,
            v.media_type, v.sha256,
            v.size_bytes, p.parser, p.parser_version, p.projection_contract,
            p.conversion_loss, p.content_digest,
            (select count(*)::text from content.document_atom a where a.parse_id = p.id)
              as parsed_block_count,
            p.id as parse_id
       from core.object o
       join quality.controlled_document d on d.id = o.id
       left join content.artifact_version v on v.id = d.content_version
       left join content.document_parse p on p.artifact_version_id = v.id
      where o.id = $1`,
    [id],
  );
  if (row === undefined) return undefined;
  const parsedBlocks =
    row.parse_id === null
      ? []
      : await tx.query<{
          ordinal: number;
          atom_kind: DocumentAtomKind;
          heading_level: number | null;
          text_content: string;
          attributes: Record<string, JsonValue>;
          atom_digest: string;
        }>(
          `select ordinal, atom_kind, heading_level, text_content, attributes, atom_digest
             from content.document_atom where parse_id = $1 order by ordinal`,
          [row.parse_id],
        );
  return {
    id: row.id,
    title: row.title,
    documentNumber: row.document_number,
    revision: row.revision,
    documentClass: row.document_class,
    lifecycleState: row.lifecycle_state,
    rowVersion: row.row_version,
    owningRole: row.owning_role,
    contentVersionId: row.content_version_id,
    mediaType: row.media_type,
    sha256: row.sha256,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    parser: row.parser,
    parserVersion: row.parser_version,
    projectionContract: row.projection_contract,
    conversionLoss: row.conversion_loss ?? [],
    contentDigest: row.content_digest,
    parsedBlockCount: Number(row.parsed_block_count),
    parsedBlocks: parsedBlocks.map((block) => ({
      ordinal: block.ordinal,
      kind: block.atom_kind,
      level: block.heading_level,
      text: block.text_content,
      attributes: block.attributes,
      digest: block.atom_digest,
    })),
  };
}
