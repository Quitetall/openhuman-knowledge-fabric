import { describe, expect, it } from 'vitest';
import type { AccessCoverage, AccessGrantRef } from '@kf/authorization';
import type { Tx } from '@kf/database';
import { engineScope } from './engine.js';

/**
 * What the engine is told to score is the caller's GRANTS, not their clearance (ADR 0016,
 * ADR 0027, KF-SAS-RQ-213). A clearance alone reads nothing, so a ceiling taken from it would let
 * the engine score records nobody granted.
 */

function grant(scope: string, ceiling: string | null): AccessGrantRef {
  return {
    source: 'test',
    sourceId: scope,
    scopeObjectId: scope,
    classificationCeiling: ceiling,
    reason: 'test',
  };
}

/** Row security as the fake applies it: objects above the session clearance are not returned. */
function visibleAt(clearance: string, objects: Record<string, string>): Tx {
  const rank = ['public', 'internal', 'confidential', 'restricted'];
  return {
    query: async (_sql: string, params: readonly unknown[]) =>
      ((params[0] as string[]) ?? [])
        .filter((id) => objects[id] !== undefined)
        .filter((id) => rank.indexOf(objects[id]!) <= rank.indexOf(clearance))
        .map((id) => ({ id, classification: objects[id]! })),
  } as unknown as Tx;
}

const coverage = (
  organizationWide: AccessGrantRef[],
  byObject: [string, AccessGrantRef[]][] = [],
): AccessCoverage => ({ organizationWide, byObject: new Map(byObject) });

describe('the engine scope is the grant-capped ceiling plus the object grants', () => {
  it('caps the ceiling at the organization-wide grant, below the clearance', async () => {
    const scope = await engineScope(
      visibleAt('restricted', {}),
      'restricted',
      coverage([grant('org', 'internal')]),
    );
    expect(scope).toEqual({ ceiling: 'internal', allow: [] });
  });

  it('caps the ceiling at the clearance, below an unbounded grant', async () => {
    const scope = await engineScope(
      visibleAt('confidential', {}),
      'confidential',
      coverage([grant('org', null)]),
    );
    expect(scope.ceiling).toBe('confidential');
  });

  it('scores no band at all when no organization-wide grant reaches one', async () => {
    const scope = await engineScope(visibleAt('restricted', {}), 'restricted', coverage([]));
    expect(scope.ceiling, 'a clearance alone must not open a band').toBe('none');
  });

  it('allows an object-granted record at or below the clearance, and none above it', async () => {
    const tx = visibleAt('internal', { a: 'internal', b: 'restricted', c: 'public' });
    const scope = await engineScope(
      tx,
      'internal',
      coverage(
        [],
        [
          ['a', [grant('a', null)]],
          ['b', [grant('b', null)]],
          ['c', [grant('c', 'public')]],
        ],
      ),
    );
    expect(scope).toEqual({ ceiling: 'none', allow: ['a', 'c'] });
  });

  it('does not allow an object whose grant ceiling is below its classification', async () => {
    const tx = visibleAt('restricted', { a: 'confidential' });
    const scope = await engineScope(
      tx,
      'restricted',
      coverage([], [['a', [grant('a', 'internal')]]]),
    );
    expect(scope.allow).toEqual([]);
  });
});
