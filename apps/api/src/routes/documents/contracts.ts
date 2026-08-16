import type { ActionRequest, ActionResult, ObjectRow } from '@kf/actions';
import type { AiProvider, AiRoutingPolicy } from '@kf/agent-tools';
import type { ObjectStore } from '@kf/artifacts';
import type { Pool, Tx } from '@kf/database';
import type { IdentifyCaller } from '../actions.js';

export const DOCUMENT_IMPORT_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_DOCUMENT_SOURCE_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_DOCUMENT_PROJECTION_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const IMPORT_CLASSIFICATION = 'internal';

export interface DocumentImportBody {
  readonly title?: unknown;
  readonly documentNumber?: unknown;
  readonly revision?: unknown;
  readonly documentClass?: unknown;
  readonly owningRole?: unknown;
  readonly fileName?: unknown;
  readonly mediaType?: unknown;
  readonly contentBase64?: unknown;
  readonly idempotencyKey?: unknown;
}

export interface ParsedDocumentImport {
  readonly title: string;
  readonly documentNumber: string;
  readonly revision: string;
  readonly documentClass: string;
  readonly owningRole: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly idempotencyKey: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly storageKey: string;
  readonly stableKey: string;
}

export interface DocumentActionContext {
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly organizationId: string;
  readonly maxClassification: string;
  readonly targetIds: readonly string[];
  readonly requestId: string;
}

export interface DocumentImportResult {
  readonly statusCode: 200 | 201;
  readonly body: {
    readonly id: string;
    readonly artifactId: string;
    readonly fragmentId: string;
    readonly fragmentRevisionId: string;
    readonly sha256: string;
    readonly replayed: boolean;
  };
}

export class SourceHolderConflict extends Error {
  constructor() {
    super('Existing document source has another Holder; use explicit Holder migration.');
    this.name = 'SourceHolderConflict';
  }
}

export class ImportIdempotencyConflict extends Error {
  constructor() {
    super('Idempotency key already names a different document import.');
    this.name = 'ImportIdempotencyConflict';
  }
}

export interface DocumentRoutesOptions {
  readonly pool: Pool;
  readonly identify: IdentifyCaller;
  readonly store: ObjectStore | undefined;
  /** Independent read ceiling for legacy records, regardless of their recorded object size. */
  readonly maxSourceDownloadBytes?: number;
  /** Independent read ceiling for compiled projections, regardless of recorded object size. */
  readonly maxProjectionDownloadBytes?: number;
  /**
   * Public delivery adapter. Its implementation must establish public-only RLS context and call
   * the package verification boundary before returning. This route never approves or signs.
   */
  readonly loadApprovedPublicProjection?: (
    request: PublicProjectionRequest,
  ) => Promise<ApprovedPublicProjection | undefined>;
  /**
   * Optional AI proposal runtime. When either side is absent the planner route exists but
   * fails closed with 503, so deployments cannot silently fall back to unaudited model calls.
   */
  readonly aiProposalProvider?: AiProvider;
  readonly aiRoutingPolicy?: AiRoutingPolicy;
  /**
   * Read-only early refusal seam. Passing this check is never authority: every action below
   * must still pass `executeInTransaction` after object storage, under its final transaction.
   */
  readonly preflightInTransaction: (
    tx: Tx,
    request: ActionRequest,
    prospectiveObjects?: readonly ObjectRow[],
  ) => Promise<void>;
  readonly executeInTransaction: (tx: Tx, request: ActionRequest) => Promise<ActionResult>;
}

export interface PublicProjectionRequest {
  readonly publicationId: string;
  readonly controlledRevisionId: string;
  readonly compiledViewId: string;
}

export interface ApprovedPublicProjection {
  readonly manifest: {
    readonly format_version: 'kf-publication-v1';
    readonly publication_id: string;
    readonly publication_action_id: string;
    readonly acceptance_action_id: string;
    readonly controlled_revision_id: string;
    readonly controlled_content_version_id: string;
    readonly compiled_view_id: string;
    readonly compiled_view_digest: string;
    readonly compiled_view_media_type: string;
    readonly publication_target_id: string;
    readonly publication_target_policy_digest: string;
    readonly classification: 'public';
    readonly lifecycle_state: 'effective';
    readonly published_at: string;
    readonly files: readonly {
      readonly path: string;
      readonly media_type: string;
      readonly size_bytes: number;
      readonly sha256: string;
    }[];
  };
  readonly signature: {
    readonly algorithm: 'Ed25519';
    readonly key_id: string;
    readonly value_base64: string;
  };
  readonly files: readonly {
    readonly path: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }[];
}
