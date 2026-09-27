import { describe, expect, it } from 'vitest';
import { parseAttestorRequest } from './attestor.js';

/** What kf-attestor accepts from the API: the surface is optional and from a closed vocabulary. */
describe('an attestor request', () => {
  const base = {
    token: 't',
    actingRoleId: 'r',
    organizationId: 'o',
    maxClassification: 'internal',
  };

  it('carries a named surface, and none when the API names none', () => {
    expect(parseAttestorRequest({ ...base, surface: 'context-source/read' })).toEqual({
      ...base,
      surface: 'context-source/read',
    });
    expect(parseAttestorRequest(base)).toEqual(base);
  });

  it('is refused when the surface is outside the vocabulary', () => {
    for (const surface of ['documents', '', 7, null]) {
      expect(parseAttestorRequest({ ...base, surface })).toBeUndefined();
    }
  });
});
