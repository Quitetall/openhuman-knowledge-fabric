// Shared shapes of the fixture corpora, for the TypeScript that imports them (tests/deployment).
export type Classification = 'public' | 'internal' | 'confidential' | 'restricted';
export interface Person {
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly department?: string;
  readonly role: string;
  readonly clearance: Classification;
  readonly ceiling: Classification;
  readonly persona?: string;
  readonly username: string;
  readonly email: string;
}
export interface Loadable {
  readonly key: string;
  readonly title: string;
  readonly classification: Classification;
  readonly artifactKind: string;
  readonly mediaType: string;
  readonly file: string;
  readonly sha256: string;
  readonly readers: readonly string[];
  readonly reason: string;
  readonly derived?: { title: string; mediaType: string; file: string; sha256: string };
}
export interface Fixture {
  readonly corpus: string;
  readonly personasCorpus?: string;
  readonly keyPrefix: string;
  readonly company: { legal_name: string; kind: string };
  readonly people: readonly Person[];
  readonly founder: string;
  readonly office: string;
  readonly documents: readonly Loadable[];
}
