import { describe, expect, it } from 'vitest';
import { allocateNewFragmentIds } from './identifiers.js';

describe('dogfood identifier allocation order', () => {
  it('preserves Holder-before-revision assignment from original loader', () => {
    const generated = ['holder-id', 'revision-id'];
    const ids = allocateNewFragmentIds(() => generated.shift()!);

    expect(ids).toEqual({ holderId: 'holder-id', revisionId: 'revision-id' });
    expect(generated).toEqual([]);
  });
});
