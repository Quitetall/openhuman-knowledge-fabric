import { hasStrings, nonNegativeInteger, nullableString, record } from './validation';

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

export interface DocumentsResponse {
  readonly documents: readonly DocumentSummary[];
}

export type DocumentSourceProvenance =
  | { readonly status: 'not_recorded' | 'ambiguous' }
  | {
      readonly status: 'recorded';
      readonly holderKind: 'fabric_native';
      readonly fragmentId: string;
      readonly fragmentRevisionId: string;
      readonly stableKey: string;
      readonly documentPolicy: 'ordinary' | 'controlled' | 'regulated';
      readonly holderId: string;
      readonly artifactVersionId: string;
      readonly contentDigest: string;
      readonly mediaType: string;
      readonly classification: string;
      readonly revisionState: string;
      readonly revisionDigest: string;
      readonly holderRecordedAt: string;
      readonly holderRecordedByAction: string;
      readonly revisionCreatedAt: string;
      readonly revisionCreatedByAction: string;
    };

export interface DocumentDetail extends DocumentSummary {
  readonly owningRole: string;
  readonly contentVersionId: string | null;
  readonly sizeBytes: number | null;
  readonly parser: string | null;
  readonly parserVersion: string | null;
  readonly projectionContract: string | null;
  readonly conversionLoss: readonly {
    readonly code: string;
    readonly path: string;
    readonly message: string;
    readonly sourceDigest: string;
  }[];
  readonly contentDigest: string | null;
  readonly sourceProvenance: DocumentSourceProvenance;
  readonly parsedBlocks: readonly ParsedBlock[];
}

export interface ParsedBlock {
  readonly ordinal: number;
  readonly kind:
    'heading' | 'paragraph' | 'list_item' | 'quote' | 'code' | 'table' | 'horizontal_rule';
  readonly level: number | null;
  readonly text: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly digest: string;
}

function documentSummary(value: unknown): value is DocumentSummary {
  const document = record(value);
  return (
    document !== undefined &&
    hasStrings(document, [
      'id',
      'title',
      'documentNumber',
      'revision',
      'documentClass',
      'lifecycleState',
      'rowVersion',
    ]) &&
    nullableString(document['mediaType']) &&
    nullableString(document['sha256']) &&
    nonNegativeInteger(document['parsedBlockCount'])
  );
}

export function parseDocumentsResponse(value: unknown): DocumentsResponse {
  const response = record(value);
  if (
    response === undefined ||
    !Array.isArray(response['documents']) ||
    !response['documents'].every(documentSummary)
  ) {
    throw new Error('documents response did not match contract');
  }
  return response as unknown as DocumentsResponse;
}

function documentSourceProvenance(value: unknown): value is DocumentSourceProvenance {
  const provenance = record(value);
  if (provenance === undefined) return false;
  if (provenance['status'] === 'not_recorded' || provenance['status'] === 'ambiguous') {
    return Object.keys(provenance).length === 1;
  }
  return (
    provenance['status'] === 'recorded' &&
    provenance['holderKind'] === 'fabric_native' &&
    ['ordinary', 'controlled', 'regulated'].includes(String(provenance['documentPolicy'])) &&
    hasStrings(provenance, [
      'fragmentId',
      'fragmentRevisionId',
      'stableKey',
      'holderId',
      'artifactVersionId',
      'contentDigest',
      'mediaType',
      'classification',
      'revisionState',
      'revisionDigest',
      'holderRecordedAt',
      'holderRecordedByAction',
      'revisionCreatedAt',
      'revisionCreatedByAction',
    ])
  );
}

const PARSED_BLOCK_KINDS = [
  'heading',
  'paragraph',
  'list_item',
  'quote',
  'code',
  'table',
  'horizontal_rule',
] as const;

export function parseDocumentDetail(value: unknown): DocumentDetail {
  const document = record(value);
  const parsedBlocks = document?.['parsedBlocks'];
  if (
    !documentSummary(value) ||
    document === undefined ||
    typeof document['owningRole'] !== 'string' ||
    !nullableString(document['contentVersionId']) ||
    !(document['sizeBytes'] === null || nonNegativeInteger(document['sizeBytes'])) ||
    !nullableString(document['parser']) ||
    !nullableString(document['parserVersion']) ||
    !nullableString(document['projectionContract']) ||
    !nullableString(document['contentDigest']) ||
    !Array.isArray(document['conversionLoss']) ||
    !document['conversionLoss'].every((candidate) => {
      const loss = record(candidate);
      return loss !== undefined && hasStrings(loss, ['code', 'path', 'message', 'sourceDigest']);
    }) ||
    !documentSourceProvenance(document['sourceProvenance']) ||
    !Array.isArray(parsedBlocks) ||
    parsedBlocks.length !== document['parsedBlockCount'] ||
    !parsedBlocks.every((candidate) => {
      const block = record(candidate);
      return (
        block !== undefined &&
        nonNegativeInteger(block['ordinal']) &&
        PARSED_BLOCK_KINDS.includes(block['kind'] as (typeof PARSED_BLOCK_KINDS)[number]) &&
        (block['level'] === null || nonNegativeInteger(block['level'])) &&
        hasStrings(block, ['text', 'digest']) &&
        record(block['attributes']) !== undefined
      );
    })
  ) {
    throw new Error('document detail did not match contract');
  }
  return document as unknown as DocumentDetail;
}
