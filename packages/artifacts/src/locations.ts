/**
 * Storage locations — where a version's bytes are, in how many places, and whether each
 * place still holds them (ADR 0017).
 *
 * A registry names the stores the instance can talk to. Replication reads the working copy,
 * writes it into a second store with create-only semantics, and records the location with
 * the digest it verified on the way. Verification re-hashes the bytes at one location against
 * the version's sha256 and records the outcome either way. Reading tries the working copy and
 * then every verified durable copy, so a lost working object is a degraded read and not a
 * missing artifact.
 *
 * `public_copy` is a role the schema allows and NOTHING here writes: the publication act
 * that would make one is deferred with the publication boundary.
 */

import { ActionRejected, type ActionEffect } from '@kf/actions';
import type { Tx } from '@kf/database';
import { digestOf, ObjectReadLimitExceeded, type ObjectStore } from './store.js';

export type ArtifactLocationRole =
  'working' | 'hot_cache' | 'durable_copy' | 'evidence_copy' | 'public_copy';

/** Roles a replication may produce. `public_copy` is deliberately absent. */
export const REPLICABLE_ROLES = ['hot_cache', 'durable_copy', 'evidence_copy'] as const;
export type ReplicableRole = (typeof REPLICABLE_ROLES)[number];

/** Store id → the client that reaches it. Ids are `content.artifact_store.id`. */
export class StoreRegistry {
  readonly #stores: ReadonlyMap<string, ObjectStore>;

  constructor(stores: Readonly<Record<string, ObjectStore>>) {
    this.#stores = new Map(Object.entries(stores));
  }

  get(storeId: string): ObjectStore | undefined {
    return this.#stores.get(storeId);
  }

  ids(): readonly string[] {
    return [...this.#stores.keys()];
  }
}

export interface ArtifactLocationRow extends Record<string, unknown> {
  readonly id: string;
  readonly version_id: string;
  readonly store_id: string;
  readonly role: ArtifactLocationRole;
  readonly uri: string;
  readonly store_version: string | null;
  readonly verified_at: Date | null;
  readonly verified_sha256: string | null;
  readonly verification_failure: string | null;
  readonly verified_by_action: string | null;
}

interface VersionRow extends Record<string, unknown> {
  readonly id: string;
  readonly artifact_id: string;
  readonly sha256: string;
  readonly size_bytes: string | number;
  readonly media_type: string;
  readonly storage_uri: string | null;
  readonly storage_version: string | null;
}

async function loadVersion(tx: Tx, versionId: string): Promise<VersionRow | undefined> {
  return tx.maybeOne<VersionRow>(
    `select id, artifact_id, sha256, size_bytes, media_type, storage_uri, storage_version
       from content.artifact_version where id = $1`,
    [versionId],
  );
}

export async function locationsOf(
  tx: Tx,
  versionId: string,
): Promise<readonly ArtifactLocationRow[]> {
  return tx.query<ArtifactLocationRow>(
    `select id, version_id, store_id, role, uri, store_version, verified_at, verified_sha256,
            verification_failure, verified_by_action
       from content.artifact_location where version_id = $1 order by role, store_id, id`,
    [versionId],
  );
}

/** Ensure a store the registry knows is declared in the ledger under the same id. */
export async function declareStore(
  tx: Tx,
  store: { readonly id: string; readonly kind: 'object_store' | 'memory'; readonly label: string },
): Promise<void> {
  await tx.query(
    `insert into content.artifact_store (id, kind, label) values ($1, $2, $3)
     on conflict (id) do nothing`,
    [store.id, store.kind, store.label],
  );
}

export type LocationVerification =
  { readonly ok: true; readonly sha256: string } | { readonly ok: false; readonly failure: string };

/** Re-hash the bytes at one location against the version's recorded identity. */
export async function hashLocation(
  store: ObjectStore,
  location: { readonly uri: string; readonly store_version: string | null },
  expected: { readonly sha256: string; readonly sizeBytes: number },
): Promise<LocationVerification> {
  const head = await store.head(location.uri, location.store_version ?? undefined);
  if (head === undefined) return { ok: false, failure: `object missing: ${location.uri}` };
  let bytes: Buffer;
  try {
    bytes = await store.read(location.uri, location.store_version ?? undefined, expected.sizeBytes);
  } catch (error: unknown) {
    if (error instanceof ObjectReadLimitExceeded) {
      return { ok: false, failure: `stored object exceeds ${String(expected.sizeBytes)} bytes` };
    }
    throw error;
  }
  if (bytes.length !== expected.sizeBytes) {
    return {
      ok: false,
      failure: `expected ${String(expected.sizeBytes)} bytes, found ${String(bytes.length)}`,
    };
  }
  const actual = digestOf(bytes);
  if (actual !== expected.sha256) {
    return { ok: false, failure: `expected ${expected.sha256}, found ${actual}` };
  }
  return { ok: true, sha256: actual };
}

async function recordVerification(
  tx: Tx,
  locationId: string,
  outcome: LocationVerification,
  actionId: string | undefined,
): Promise<void> {
  await tx.query(
    `update content.artifact_location
        set verified_at = now(),
            verified_sha256 = $2,
            verification_failure = $3,
            verified_by_action = $4
      where id = $1`,
    [
      locationId,
      outcome.ok ? outcome.sha256 : null,
      outcome.ok ? null : outcome.failure,
      actionId ?? null,
    ],
  );
}

/**
 * Verify one location and record the outcome. Returns the outcome; a failed verification
 * is recorded, not thrown — it is the finding the ledger exists to hold.
 */
export async function verifyLocation(
  tx: Tx,
  registry: StoreRegistry,
  locationId: string,
  actionId?: string,
): Promise<LocationVerification> {
  const location = await tx.maybeOne<ArtifactLocationRow>(
    `select id, version_id, store_id, role, uri, store_version, verified_at, verified_sha256,
            verification_failure, verified_by_action
       from content.artifact_location where id = $1`,
    [locationId],
  );
  if (location === undefined) throw new Error(`artifact location ${locationId} does not exist`);
  const version = await loadVersion(tx, location.version_id);
  if (version === undefined)
    throw new Error(`artifact version ${location.version_id} is not visible`);
  const store = registry.get(location.store_id);
  if (store === undefined) {
    const outcome: LocationVerification = {
      ok: false,
      failure: `store '${location.store_id}' is not configured on this instance`,
    };
    await recordVerification(tx, locationId, outcome, actionId);
    return outcome;
  }
  const outcome = await hashLocation(store, location, {
    sha256: version.sha256,
    sizeBytes: Number(version.size_bytes),
  });
  await recordVerification(tx, locationId, outcome, actionId);
  return outcome;
}

/**
 * Copy the working bytes of a version into another store under `role`, verifying the
 * digest on the way, and record the location. Create-only in the target: an existing object
 * at the key is kept and re-hashed rather than overwritten.
 */
export async function replicateVersion(
  tx: Tx,
  registry: StoreRegistry,
  input: {
    readonly versionId: string;
    readonly toStoreId: string;
    readonly role: ReplicableRole;
    readonly recordedBy?: string;
    readonly actionId?: string;
  },
): Promise<{ readonly locationId: string; readonly verification: LocationVerification }> {
  if (!REPLICABLE_ROLES.includes(input.role)) {
    throw new Error(`role '${String(input.role)}' cannot be produced by replication`);
  }
  const version = await loadVersion(tx, input.versionId);
  if (version === undefined) throw new Error(`artifact version ${input.versionId} is not visible`);
  const working = await tx.maybeOne<ArtifactLocationRow>(
    `select id, version_id, store_id, role, uri, store_version, verified_at, verified_sha256,
            verification_failure, verified_by_action
       from content.artifact_location where version_id = $1 and role = 'working'`,
    [input.versionId],
  );
  if (working === undefined) {
    throw new Error(`artifact version ${input.versionId} has no working location to copy from`);
  }
  const source = registry.get(working.store_id);
  const target = registry.get(input.toStoreId);
  if (source === undefined) throw new Error(`store '${working.store_id}' is not configured`);
  if (target === undefined) throw new Error(`store '${input.toStoreId}' is not configured`);
  const declared = await tx.maybeOne<{ writable: boolean } & Record<string, unknown>>(
    'select writable from content.artifact_store where id = $1',
    [input.toStoreId],
  );
  if (declared === undefined) throw new Error(`store '${input.toStoreId}' is not declared`);
  if (!declared.writable) throw new Error(`store '${input.toStoreId}' is declared read-only`);

  const sizeBytes = Number(version.size_bytes);
  const bytes = await source.read(working.uri, working.store_version ?? undefined, sizeBytes);
  const sourceDigest = digestOf(bytes);
  if (sourceDigest !== version.sha256) {
    throw new Error(
      `working copy of ${input.versionId} does not match its recorded sha256; refusing to replicate a corrupt object`,
    );
  }
  // The store cannot join the database transaction. If the row below fails after the put,
  // the object is in the target store with no location — create-only means the next
  // replication of the same version finds it, re-hashes it, and records it; nothing is
  // overwritten and nothing is served without a row.
  const stored = await target.putIfAbsent(working.uri, bytes, version.media_type);
  const row = await tx.one<{ id: string }>(
    `insert into content.artifact_location
       (version_id, store_id, role, uri, store_version, recorded_by, recorded_by_action)
     values ($1, $2, $3, $4, $5, $6, $7)
     -- no-op update so RETURNING id yields the existing row on conflict
     on conflict (version_id, store_id, role) do update set recorded_at = artifact_location.recorded_at
     returning id`,
    [
      input.versionId,
      input.toStoreId,
      input.role,
      stored.key,
      stored.versionId ?? null,
      input.recordedBy ?? null,
      input.actionId ?? null,
    ],
  );
  // What landed is verified independently of what was sent: create-only means an object
  // that was already there is the one that stays, and it has to be THE bytes.
  const verification = await verifyLocation(tx, registry, row.id, input.actionId);
  return { locationId: row.id, verification };
}

/**
 * Write the ONE public copy of a version into a store declared public (ADR 0021). Only the
 * publication act calls this — the database refuses a `public_copy` row recorded by any other
 * act or into any other store — so this function neither checks the act nor could it: it
 * copies verified bytes and records the location under the act it was given.
 */
export async function publishVersionCopy(
  tx: Tx,
  registry: StoreRegistry,
  input: {
    readonly versionId: string;
    readonly toStoreId: string;
    readonly recordedBy: string;
    readonly actionId: string;
  },
): Promise<{ readonly locationId: string; readonly verification: LocationVerification }> {
  const version = await loadVersion(tx, input.versionId);
  if (version === undefined) throw new Error(`artifact version ${input.versionId} is not visible`);
  const working = await tx.maybeOne<ArtifactLocationRow>(
    `select id, version_id, store_id, role, uri, store_version, verified_at, verified_sha256,
            verification_failure, verified_by_action
       from content.artifact_location where version_id = $1 and role = 'working'`,
    [input.versionId],
  );
  if (working === undefined)
    throw new Error(`artifact version ${input.versionId} has no working location`);
  const source = registry.get(working.store_id);
  const target = registry.get(input.toStoreId);
  if (source === undefined) throw new Error(`store '${working.store_id}' is not configured`);
  if (target === undefined)
    throw new Error(`public store '${input.toStoreId}' is not configured on this instance`);
  const sizeBytes = Number(version.size_bytes);
  const bytes = await source.read(working.uri, working.store_version ?? undefined, sizeBytes);
  if (digestOf(bytes) !== version.sha256) {
    throw new Error(
      `working copy of ${input.versionId} does not match its recorded sha256; refusing to publish it`,
    );
  }
  const stored = await target.putIfAbsent(working.uri, bytes, version.media_type);
  const row = await tx.one<{ id: string }>(
    `insert into content.artifact_location
       (version_id, store_id, role, uri, store_version, recorded_by, recorded_by_action)
     values ($1, $2, 'public_copy', $3, $4, $5, $6)
     returning id`,
    [
      input.versionId,
      input.toStoreId,
      stored.key,
      stored.versionId ?? null,
      input.recordedBy,
      input.actionId,
    ],
  );
  const verification = await verifyLocation(tx, registry, row.id, input.actionId);
  return { locationId: row.id, verification };
}

/**
 * The bytes of a version from wherever they still are: the working copy first, then every
 * location whose last verification passed, in role order. Undefined when no location can
 * serve them — which is a finding, not an exception.
 */
export async function readVersionBytes(
  tx: Tx,
  registry: StoreRegistry,
  versionId: string,
): Promise<{ readonly bytes: Buffer; readonly servedFrom: ArtifactLocationRow } | undefined> {
  const version = await loadVersion(tx, versionId);
  if (version === undefined) return undefined;
  const locations = await locationsOf(tx, versionId);
  const ordered = [
    ...locations.filter((l) => l.role === 'working'),
    ...locations.filter(
      (l) =>
        l.role !== 'working' && l.verified_sha256 === version.sha256 && l.role !== 'public_copy',
    ),
  ];
  const sizeBytes = Number(version.size_bytes);
  for (const location of ordered) {
    const store = registry.get(location.store_id);
    if (store === undefined) continue;
    const head = await store.head(location.uri, location.store_version ?? undefined);
    if (head === undefined) continue;
    let bytes: Buffer;
    try {
      bytes = await store.read(location.uri, location.store_version ?? undefined, sizeBytes);
    } catch (error: unknown) {
      if (error instanceof ObjectReadLimitExceeded) continue;
      throw error;
    }
    if (digestOf(bytes) !== version.sha256) continue;
    return { bytes, servedFrom: location };
  }
  return undefined;
}

// ── Typed actions ─────────────────────────────────────────────────────────────────────────

function payloadString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StorageActionAtoms {
  readonly name: string;
  readonly ownedActions: readonly string[];
  readonly effects: Readonly<Record<string, ActionEffect>>;
}

export const STORAGE_ACTION_IDS = [
  'replicate_artifact_version',
  'verify_artifact_location',
] as const;

/**
 * `replicate_artifact_version` targets the artifact and names the version, target store and
 * role in its payload. `verify_artifact_location` targets the artifact and names the
 * location. Both record their outcome on the location row against this action.
 */
export function createStorageActionAtoms(registry: StoreRegistry): StorageActionAtoms {
  const artifactOf = async (
    tx: Tx,
    request: { readonly targetIds: readonly string[] },
    versionId: string,
  ): Promise<void> => {
    const version = await loadVersion(tx, versionId);
    if (version === undefined || !request.targetIds.includes(version.artifact_id)) {
      throw new ActionRejected(
        'precondition_failed',
        'the action must target the artifact that owns the named version',
        { versionId },
      );
    }
  };

  const replicate: ActionEffect = async (tx, request, _objects, ctx) => {
    const versionId = payloadString(request.payload, 'version_id');
    const toStoreId = payloadString(request.payload, 'store_id');
    const role = payloadString(request.payload, 'role');
    if (versionId === undefined || !UUID.test(versionId)) {
      throw new ActionRejected(
        'precondition_failed',
        'replicate_artifact_version needs version_id',
      );
    }
    if (toStoreId === undefined) {
      throw new ActionRejected('precondition_failed', 'replicate_artifact_version needs store_id');
    }
    if (role === undefined || !(REPLICABLE_ROLES as readonly string[]).includes(role)) {
      throw new ActionRejected(
        'precondition_failed',
        `replicate_artifact_version needs role of ${REPLICABLE_ROLES.join(' | ')}; public_copy is a publication act, not a replication`,
      );
    }
    await artifactOf(tx, request, versionId);
    if (registry.get(toStoreId) === undefined) {
      throw new ActionRejected('precondition_failed', `store '${toStoreId}' is not configured`, {
        configured: registry.ids(),
      });
    }
    await replicateVersion(tx, registry, {
      versionId,
      toStoreId,
      role: role as ReplicableRole,
      recordedBy: request.actorId,
      actionId: ctx.actionId,
    });
  };

  const verify: ActionEffect = async (tx, request, _objects, ctx) => {
    const locationId = payloadString(request.payload, 'location_id');
    if (locationId === undefined || !UUID.test(locationId)) {
      throw new ActionRejected('precondition_failed', 'verify_artifact_location needs location_id');
    }
    const location = await tx.maybeOne<{ version_id: string } & Record<string, unknown>>(
      'select version_id from content.artifact_location where id = $1',
      [locationId],
    );
    if (location === undefined) {
      throw new ActionRejected('precondition_failed', 'no such artifact location', { locationId });
    }
    await artifactOf(tx, request, location.version_id);
    await verifyLocation(tx, registry, locationId, ctx.actionId);
  };

  return {
    name: 'storage',
    ownedActions: STORAGE_ACTION_IDS,
    effects: { replicate_artifact_version: replicate, verify_artifact_location: verify },
  };
}
