import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOntology } from '@kf/ontology-compiler';
import { AUTHORITY_DOMAINS, isAuthorityDomain, PACKAGE } from './index.js';

const ontology = loadOntology(join(import.meta.dirname, '..', '..', '..', 'ontology'));

describe('authority domains', () => {
  it('match the ontology exactly', () => {
    // This list is restated here so @kf/domain stays dependency-free. Restating means it can
    // drift, and a package claiming authority over a domain that does not exist would be
    // invisible — so the two are asserted equal rather than assumed.
    expect([...AUTHORITY_DOMAINS]).toEqual([...ontology.authorityDomains]);
  });

  it('recognises a real domain and rejects an invented one', () => {
    expect(isAuthorityDomain('commercial')).toBe(true);
    expect(isAuthorityDomain('marketing')).toBe(false);
  });

  it('covers every domain the object types actually use', () => {
    for (const t of ontology.objectTypes) {
      expect(isAuthorityDomain(t.authority_domain), `${t.id}`).toBe(true);
    }
  });
});

describe('package manifest', () => {
  it('claims no authority', () => {
    // @kf/domain describes facts; it does not own any.
    expect(PACKAGE.owns).toEqual([]);
  });
});
