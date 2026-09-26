import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@kf/database';
import {
  createControlledObject,
  OBJECT_TITLE_MAX_CHARACTERS,
  objectTitleProblem,
  PayloadInvalid,
} from './index.js';

/**
 * A title the database would refuse is refused as the caller's input, naming the field, before the
 * insert: `core.object` allows 1 to 240 characters after trimming spaces and PostgreSQL text holds
 * no NUL, and either violation used to reach an HTTP caller as a 500.
 */
describe('a record title', () => {
  it('is counted in characters, as core.object counts it', () => {
    expect(OBJECT_TITLE_MAX_CHARACTERS).toBe(240);
    expect(objectTitleProblem('t'.repeat(240))).toBeUndefined();
    expect(objectTitleProblem('\u{1F600}'.repeat(240))).toBeUndefined();
    expect(objectTitleProblem(` ${'t'.repeat(240)} `)).toBeUndefined();
    expect(objectTitleProblem('t'.repeat(241))).toMatch(/1 to 240 characters; it is 241/u);
    expect(objectTitleProblem('\u{1F600}'.repeat(241))).toMatch(/it is 241/u);
    expect(objectTitleProblem('   ')).toMatch(/it is 0/u);
    expect(objectTitleProblem('a\u0000b')).toMatch(/NUL/u);
  });

  it('that does not fit is refused before any query runs', async () => {
    const query = vi.fn();
    const tx = { one: query, query, maybeOne: query } as unknown as Tx;
    const spec = {
      objectType: 'artifact',
      authorityDomain: 'artifact',
      lifecycleState: 'draft',
      organizationId: 'org',
      createdBy: 'person',
    };
    for (const title of ['t'.repeat(241), 'a\u0000b']) {
      const refused = await createControlledObject(tx, { ...spec, title }).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(PayloadInvalid);
      expect((refused as PayloadInvalid).field).toBe('title');
    }
    expect(query).not.toHaveBeenCalled();
  });
});
