// Types for sessions.mjs, for the TypeScript that imports it (tests/deployment).
import type { PersonaSession } from './kf.mjs';
import type { StackSettings } from './stack.mjs';

export interface CorpusIds {
  readonly corpus: string;
  readonly organizationId: string;
  readonly legalName: string;
  readonly people: Record<
    string,
    { personId: string; assignmentId: string; subject: string; username: string }
  >;
  readonly documents: Record<string, { artifactId?: string; textArtifactId?: string }>;
}
export declare function corpusSessions(
  corpus: string,
  people: ReadonlyArray<{ key: string; username: string; clearance: string }>,
  options?: { personasCorpus?: string; settings?: StackSettings },
): Promise<{
  ids: CorpusIds;
  sessionOf: (key: string) => PersonaSession;
  docOfArtifact: Map<string, string>;
  settings: StackSettings;
}>;
