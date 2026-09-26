// Sign in as a loaded corpus's people, from what its load left behind: the ids file in the
// stack's state directory (organization, each person's assignment) and the corpus's personas
// file (passwords, never printed). Used by the baselines and the tests.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PersonaSession } from './kf.mjs';
import { readPasswords } from './loader.mjs';
import { personasFile, stackSettings } from './stack.mjs';

export async function corpusSessions(
  corpus,
  people,
  { personasCorpus = corpus, settings = stackSettings() } = {},
) {
  const ids = JSON.parse(await readFile(path.join(settings.state, `${corpus}-ids.json`), 'utf8'));
  const passwords = await readPasswords(personasFile(personasCorpus));
  const byKey = new Map(people.map((p) => [p.key, p]));
  const sessions = new Map();
  const sessionOf = (key) => {
    if (!sessions.has(key)) {
      const person = byKey.get(key);
      if (person === undefined || ids.people[key] === undefined)
        throw new Error(`${corpus}: no loaded person ${key}`);
      sessions.set(
        key,
        new PersonaSession({
          oidc: settings.oidc,
          apiOrigin: settings.api,
          person,
          password: passwords.get(person.username),
          organizationId: ids.organizationId,
          assignmentId: ids.people[key].assignmentId,
        }),
      );
    }
    return sessions.get(key);
  };
  const docOfArtifact = new Map();
  for (const [key, entry] of Object.entries(ids.documents ?? {})) {
    if (entry.artifactId) docOfArtifact.set(entry.artifactId, key);
    if (entry.textArtifactId) docOfArtifact.set(entry.textArtifactId, key);
  }
  return { ids, sessionOf, docOfArtifact, settings };
}
