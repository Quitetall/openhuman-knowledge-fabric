import {
  ObjectReadLimitExceeded,
  requireReadLimit,
  type ObjectStore,
  type StoredObject,
} from './store-contracts.js';

/** In-memory versioned store for deterministic flow tests. */
export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<
    string,
    {
      headVersionId: string;
      versions: Map<string, { body: Buffer; mediaType: string }>;
    }
  >();
  #counter = 0;

  async presignPut(key: string, _mediaType: string, _expiresInSeconds: number): Promise<string> {
    return `memory://${key}`;
  }

  async head(key: string, versionId?: string): Promise<StoredObject | undefined> {
    const object = this.#objects.get(key);
    if (object === undefined) return undefined;
    const selectedVersionId = versionId ?? object.headVersionId;
    const head = object.versions.get(selectedVersionId);
    if (head === undefined) return undefined;
    return { key, sizeBytes: head.body.length, versionId: selectedVersionId };
  }

  async read(key: string, versionId?: string, maxBytes?: number): Promise<Buffer> {
    requireReadLimit(maxBytes);
    const object = this.#objects.get(key);
    if (object === undefined) throw new Error(`object ${key} not found`);
    const selectedVersionId = versionId ?? object.headVersionId;
    const selected = object.versions.get(selectedVersionId);
    if (selected === undefined) {
      throw new Error(`object ${key} version ${selectedVersionId} not found`);
    }
    if (maxBytes !== undefined && selected.body.byteLength > maxBytes) {
      throw new ObjectReadLimitExceeded(key, maxBytes);
    }
    return Buffer.from(selected.body);
  }

  async put(key: string, body: Buffer, mediaType: string): Promise<StoredObject> {
    this.#counter += 1;
    const versionId = `v${this.#counter}`;
    const object = this.#objects.get(key) ?? { headVersionId: versionId, versions: new Map() };
    object.versions.set(versionId, { body: Buffer.from(body), mediaType });
    object.headVersionId = versionId;
    this.#objects.set(key, object);
    return { key, sizeBytes: body.length, versionId };
  }

  async putIfAbsent(key: string, body: Buffer, mediaType: string): Promise<StoredObject> {
    const object = this.#objects.get(key);
    if (object !== undefined) {
      const head = object.versions.get(object.headVersionId);
      if (head === undefined) throw new Error(`object ${key} has no head version`);
      return { key, sizeBytes: head.body.length, versionId: object.headVersionId };
    }
    return this.put(key, body, mediaType);
  }

  /** Test-only: replace bytes at a key, simulating tampering in store. */
  tamper(key: string, body: Buffer): void {
    const object = this.#objects.get(key);
    if (object === undefined) throw new Error(`object ${key} not found`);
    const head = object.versions.get(object.headVersionId);
    if (head === undefined) throw new Error(`object ${key} has no head version`);
    object.versions.set(object.headVersionId, { ...head, body: Buffer.from(body) });
  }
}
