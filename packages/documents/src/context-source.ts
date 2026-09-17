import { canonicalize, digestBytes } from '@kf/canonicalization';
import { setResolvedAccessContext, type Tx } from '@kf/database';
import type { PermissionMember } from './master-record.js';
import { enumeratePermittedSet } from './master-record-repository.js';

export const CONTEXT_SOURCE_ADAPTER = 'knowledge-fabric';
export const MAX_CONTEXT_SOURCE_BYTES = 1024 * 1024;

/** Must come from KF authentication, never from an untrusted request body. */
export interface ContextSourceReader {
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly organizationId: string;
  readonly maxClassification: string;
}

export interface ContextSourceReference {
  readonly adapter: typeof CONTEXT_SOURCE_ADAPTER;
  readonly record: string;
  readonly revision: string;
  readonly digest: string;
}

/** Ephemeral materialized facts, not an authorization grant or an external byte locator. */
export interface ContextSourceRecord {
  readonly schema: 'kf.context-source-record/v1';
  readonly source: ContextSourceReference;
  readonly text: string;
  readonly classification: PermissionMember['classification'];
  readonly trust: 'untrusted';
  readonly localOnly: true;
  readonly retention: 'ephemeral';
}

export class ContextSourceRefused extends Error {
  constructor(
    readonly reason:
      'invalid_reference' | 'revision_mismatch' | 'insufficient_budget' | 'scope_mismatch',
  ) {
    super(reason);
    this.name = 'ContextSourceRefused';
  }
}

async function permitted(
  tx: Tx,
  reader: ContextSourceReader,
): Promise<readonly PermissionMember[]> {
  await setResolvedAccessContext(tx, {
    subjectId: reader.actorId,
    assignmentId: reader.actingRoleId,
    organizationId: reader.organizationId,
    requestedClassification: reader.maxClassification,
  });
  const members = await enumeratePermittedSet(tx, reader.actorId, reader.organizationId);
  if (members.some((member) => member.organizationId !== reader.organizationId)) {
    throw new ContextSourceRefused('scope_mismatch');
  }
  return members;
}

function record(member: PermissionMember): ContextSourceRecord {
  if (!/^[0-9a-f]{64}$/.test(member.contentDigest)) {
    throw new ContextSourceRefused('invalid_reference');
  }
  const text = canonicalize({
    schema: 'kf.context-facts/v1',
    objectId: member.objectId,
    objectType: member.objectType,
    organizationId: member.organizationId,
    classification: member.classification,
    title: member.title ?? '',
    content: member.content ?? {},
  });
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_CONTEXT_SOURCE_BYTES) {
    throw new ContextSourceRefused('insufficient_budget');
  }
  return {
    schema: 'kf.context-source-record/v1',
    source: {
      adapter: CONTEXT_SOURCE_ADAPTER,
      record: member.objectId,
      revision: member.contentDigest,
      digest: digestBytes(bytes),
    },
    text,
    classification: member.classification,
    trust: 'untrusted',
    localOnly: true,
    retention: 'ephemeral',
  };
}

/** Rank candidates in KF first. This filters current eligibility without re-ranking or caching. */
export async function contextSourceReferencesIn(
  tx: Tx,
  reader: ContextSourceReader,
  rankedObjectIds: readonly string[],
): Promise<readonly ContextSourceReference[]> {
  if (rankedObjectIds.length > 200) throw new ContextSourceRefused('insufficient_budget');
  const members = new Map((await permitted(tx, reader)).map((member) => [member.objectId, member]));
  const references: ContextSourceReference[] = [];
  for (const id of new Set(rankedObjectIds)) {
    const member = members.get(id);
    if (member !== undefined) references.push(record(member).source);
  }
  return references;
}

/** Re-read current authority on every call. Hidden and absent objects are indistinguishable. */
export async function readContextSourceIn(
  tx: Tx,
  reader: ContextSourceReader,
  reference: ContextSourceReference,
): Promise<ContextSourceRecord | undefined> {
  if (
    reference.adapter !== CONTEXT_SOURCE_ADAPTER ||
    !/^[0-9a-f]{64}$/.test(reference.revision) ||
    !/^[0-9a-f]{64}$/.test(reference.digest)
  ) {
    throw new ContextSourceRefused('invalid_reference');
  }
  const member = (await permitted(tx, reader)).find((item) => item.objectId === reference.record);
  if (member === undefined) return undefined;
  const current = record(member);
  if (
    current.source.revision !== reference.revision ||
    current.source.digest !== reference.digest
  ) {
    throw new ContextSourceRefused('revision_mismatch');
  }
  return current;
}
