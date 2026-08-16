import type { KeyObject } from 'node:crypto';
import { setAccessContext, withTransaction, type Pool } from '@kf/database';
import { loadApprovedPublicProjection } from './projection.js';
import type { PublicationProjectionRequest, SignedPublicationBundle } from './types.js';

export const DEFAULT_STORED_PUBLICATION_BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

export interface StoredPublicationBundle {
  /** RLS routing hint only; database publication authority must independently match. */
  readonly organizationId: string;
  /** Exact encoded object size rechecked against the configured ceiling. */
  readonly encodedSizeBytes: number;
  /** Decoded untrusted candidate; signature and all receipt/byte claims are reverified. */
  readonly candidate: unknown;
}

export interface PublicationBundleStore {
  /**
   * Load the exact immutable object for this receipt. The store must enforce `maxBytes` before
   * allocating or decoding the object and return `undefined` when no exact identity exists.
   */
  load(
    request: PublicationProjectionRequest,
    maxBytes: number,
  ): Promise<StoredPublicationBundle | undefined>;
}

export interface ApprovedPublicProjectionLoaderOptions {
  readonly pool: Pool;
  readonly bundleStore: PublicationBundleStore;
  readonly trustedSigningKeys: ReadonlyMap<string, KeyObject>;
  readonly maxStoredBundleBytes?: number;
}

function trustedKeys(input: ReadonlyMap<string, KeyObject>): ReadonlyMap<string, KeyObject> {
  if (input.size === 0) throw new Error('at least one trusted publication signing key is required');
  const snapshot = new Map<string, KeyObject>();
  for (const [keyId, key] of input) {
    if (keyId.trim() === '') throw new Error('publication signing key id must not be empty');
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw new Error(`publication signing key ${keyId} must be public Ed25519`);
    }
    snapshot.set(keyId, key);
  }
  return snapshot;
}

/** Compose immutable bundle storage, public-only RLS, and the read-only publication verifier. */
export function createApprovedPublicProjectionLoader(
  options: ApprovedPublicProjectionLoaderOptions,
): (request: PublicationProjectionRequest) => Promise<SignedPublicationBundle | undefined> {
  const maximum = options.maxStoredBundleBytes ?? DEFAULT_STORED_PUBLICATION_BUNDLE_MAX_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error('maxStoredBundleBytes must be a positive safe integer');
  }
  const keys = trustedKeys(options.trustedSigningKeys);

  return async (request) => {
    const stored = await options.bundleStore.load(request, maximum);
    if (stored === undefined) return undefined;
    if (stored.organizationId.trim() === '') {
      throw new Error('stored publication bundle organization must not be empty');
    }
    if (
      !Number.isSafeInteger(stored.encodedSizeBytes) ||
      stored.encodedSizeBytes < 0 ||
      stored.encodedSizeBytes > maximum
    ) {
      throw new Error('stored publication bundle exceeds its configured byte ceiling');
    }
    return withTransaction(options.pool, async (tx) => {
      await setAccessContext(tx, {
        organizationId: stored.organizationId,
        maxClassification: 'public',
      });
      return loadApprovedPublicProjection(tx, request, stored.candidate, keys);
    });
  };
}
