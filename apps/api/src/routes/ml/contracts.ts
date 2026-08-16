export interface MlRunQuery {
  readonly afterSequence?: unknown;
  readonly limit?: unknown;
  readonly afterMember?: unknown;
  readonly memberLimit?: unknown;
  readonly afterOrdinal?: unknown;
  readonly segmentLimit?: unknown;
  readonly afterReceiptDigest?: unknown;
  readonly promotionLimit?: unknown;
}

export interface MemberCursor {
  readonly token: string | null;
  readonly roleOrder: number;
  readonly ordinal: number;
}

export interface ProjectionPages {
  readonly events: { readonly afterSequence: string; readonly limit: number };
  readonly members: { readonly after: MemberCursor; readonly limit: number };
  readonly segments: { readonly afterOrdinal: number; readonly limit: number };
  readonly promotions: { readonly afterReceiptDigest: string | null; readonly limit: number };
}

export interface MetricEventBody {
  readonly idempotencyKey?: unknown;
  readonly sequence?: unknown;
  readonly recordedAt?: unknown;
  readonly value?: unknown;
}
