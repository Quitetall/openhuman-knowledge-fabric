import { beforeEach, describe, expect, it, vi } from 'vitest';
import { digestBytes } from '@kf/canonicalization';
import { setResolvedAccessContext, type Tx } from '@kf/database';
import { enumeratePermittedSet } from './master-record-repository.js';
import type { PermissionMember } from './master-record.js';
import {
  contextSourceReferencesIn,
  readContextSourceIn,
  type ContextSourceReader,
} from './context-source.js';

vi.mock('@kf/database', () => ({ setResolvedAccessContext: vi.fn() }));
vi.mock('./master-record-repository.js', () => ({ enumeratePermittedSet: vi.fn() }));

const tx: Tx = {
  query: async () => [],
  queryWithTextParsers: async () => [],
  one: async () => {
    throw new Error('unexpected direct query');
  },
  maybeOne: async () => undefined,
};
const reader: ContextSourceReader = {
  actorId: 'person',
  actingRoleId: 'role',
  organizationId: 'org',
  maxClassification: 'internal',
};
const member = (id: string): PermissionMember => ({
  objectId: id,
  objectType: 'fact',
  organizationId: 'org',
  classification: 'internal',
  contentDigest: 'a'.repeat(64),
  title: id,
  content: { value: 42 },
});
const resolved = vi.mocked(setResolvedAccessContext);
const permitted = vi.mocked(enumeratePermittedSet);

beforeEach(() => {
  vi.resetAllMocks();
  resolved.mockResolvedValue('internal');
  permitted.mockResolvedValue([member('a'), member('b')]);
});

describe('KF context-source materialized reads', () => {
  it('uses current KF authority, preserves rank order and excludes hidden candidates', async () => {
    const refs = await contextSourceReferencesIn(tx, reader, ['b', 'hidden', 'a', 'b']);
    expect(refs.map((ref) => ref.record)).toEqual(['b', 'a']);
    expect(resolved).toHaveBeenCalledWith(tx, {
      subjectId: 'person',
      assignmentId: 'role',
      organizationId: 'org',
      requestedClassification: 'internal',
    });
    expect(permitted).toHaveBeenCalledWith(tx, 'person', 'org');
    expect(resolved.mock.invocationCallOrder[0]).toBeLessThan(
      permitted.mock.invocationCallOrder[0]!,
    );
  });

  it('binds canonical text to a revision and keeps material ephemeral and untrusted', async () => {
    const [ref] = await contextSourceReferencesIn(tx, reader, ['a']);
    if (ref === undefined) throw new Error('missing fixture reference');
    const result = await readContextSourceIn(tx, reader, ref);
    expect(result).toMatchObject({
      source: ref,
      localOnly: true,
      retention: 'ephemeral',
      trust: 'untrusted',
    });
    if (result === undefined) throw new Error('missing fixture record');
    expect(digestBytes(Buffer.from(result.text, 'utf8'))).toBe(ref.digest);
    expect(JSON.parse(result.text)).toMatchObject({ objectId: 'a', content: { value: 42 } });
    expect(resolved).toHaveBeenCalledTimes(2);
  });

  it('rechecks revocation and does not distinguish hidden from absent', async () => {
    const [ref] = await contextSourceReferencesIn(tx, reader, ['a']);
    if (ref === undefined) throw new Error('missing fixture reference');
    permitted.mockResolvedValue([]);
    expect(await readContextSourceIn(tx, reader, ref)).toBeUndefined();
    expect(await readContextSourceIn(tx, reader, { ...ref, record: 'absent' })).toBeUndefined();
    expect(resolved).toHaveBeenCalledTimes(3);
  });

  it('refuses changed revision or changed rendered bytes', async () => {
    const [ref] = await contextSourceReferencesIn(tx, reader, ['a']);
    if (ref === undefined) throw new Error('missing fixture reference');
    permitted.mockResolvedValue([{ ...member('a'), contentDigest: 'b'.repeat(64) }]);
    await expect(readContextSourceIn(tx, reader, ref)).rejects.toMatchObject({
      reason: 'revision_mismatch',
    });
    permitted.mockResolvedValue([{ ...member('a'), content: { value: 43 } }]);
    await expect(readContextSourceIn(tx, reader, ref)).rejects.toMatchObject({
      reason: 'revision_mismatch',
    });
  });

  it('fails closed on authority failure and unexpected foreign members', async () => {
    resolved.mockRejectedValueOnce(new Error('authority unavailable'));
    await expect(contextSourceReferencesIn(tx, reader, ['a'])).rejects.toThrow(
      'authority unavailable',
    );
    expect(permitted).not.toHaveBeenCalled();
    permitted.mockResolvedValue([{ ...member('a'), organizationId: 'other' }]);
    await expect(contextSourceReferencesIn(tx, reader, ['a'])).rejects.toMatchObject({
      reason: 'scope_mismatch',
    });
  });

  it('refuses oversized records and candidate lists without truncating', async () => {
    await expect(
      contextSourceReferencesIn(tx, reader, Array<string>(201).fill('a')),
    ).rejects.toMatchObject({ reason: 'insufficient_budget' });
    expect(resolved).not.toHaveBeenCalled();
    permitted.mockResolvedValue([{ ...member('a'), content: { text: 'x'.repeat(1024 * 1024) } }]);
    await expect(contextSourceReferencesIn(tx, reader, ['a'])).rejects.toMatchObject({
      reason: 'insufficient_budget',
    });
  });

  it('rejects malformed references before consulting authority', async () => {
    await expect(
      readContextSourceIn(tx, reader, {
        adapter: 'knowledge-fabric',
        record: 'a',
        revision: 'not-a-digest',
        digest: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ reason: 'invalid_reference' });
    expect(resolved).not.toHaveBeenCalled();
    expect(permitted).not.toHaveBeenCalled();
  });

  it('does not reuse a successful read after a source outage', async () => {
    const [ref] = await contextSourceReferencesIn(tx, reader, ['a']);
    if (ref === undefined) throw new Error('missing fixture reference');
    expect(await readContextSourceIn(tx, reader, ref)).toBeDefined();
    permitted.mockRejectedValueOnce(new Error('source unavailable'));
    await expect(readContextSourceIn(tx, reader, ref)).rejects.toThrow('source unavailable');
    expect(resolved).toHaveBeenCalledTimes(3);
  });
});
