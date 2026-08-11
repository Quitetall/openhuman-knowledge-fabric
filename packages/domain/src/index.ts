/**
 * Typed domain model.
 *
 * Gate 2 replaces the hand-written parts of this package with types generated from
 * `ontology/*.yaml`. What lives here permanently is the vocabulary the ontology is
 * expressed in — the authority domains, and the shape of a package's claim about which
 * facts it may own.
 */

/**
 * The canonical owner of a class of facts (directive §2.1, spec §4.1).
 *
 * A fact is written in exactly one authority domain. Every other surface displays a
 * projection or a resolvable reference to it.
 */
// These are the ontology's domains verbatim (ontology/meta.yaml). They are restated here
// rather than imported so this package stays dependency-free, and a test asserts the two
// lists are identical — a silent divergence would let a package claim authority over a
// domain that does not exist.
export const AUTHORITY_DOMAINS = [
  'artifact',
  'commercial',
  'configuration',
  'engineering',
  'finance',
  'organization',
  'project',
  'qms',
] as const;

export type AuthorityDomain = (typeof AUTHORITY_DOMAINS)[number];

export function isAuthorityDomain(value: string): value is AuthorityDomain {
  return (AUTHORITY_DOMAINS as readonly string[]).includes(value);
}

/**
 * A package's declaration of what it is allowed to own.
 *
 * `owns: []` is the common and correct case: most packages transform, validate or project
 * facts without owning any. A package that claims an authority domain is claiming to be the
 * single writer of those facts.
 */
export interface PackageManifest {
  readonly name: string;
  readonly role: string;
  readonly owns: readonly AuthorityDomain[];
}

export const PACKAGE: PackageManifest = {
  name: '@kf/domain',
  role: 'Typed domain entities and the rules that govern them',
  owns: [],
};
