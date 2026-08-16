import { randomUUID } from 'node:crypto';

/** Preserve persisted identifier meaning when allocating new fragment authority records. */
export function allocateNewFragmentIds(generate: () => string = randomUUID): {
  readonly holderId: string;
  readonly revisionId: string;
} {
  const holderId = generate();
  const revisionId = generate();
  return { holderId, revisionId };
}
