// Where a fixture stack listens, read from the environment `stack.sh` exports.
//
// One stack script serves every fixture (fixtures/veracier/stack/stack.sh, parameterized by
// KF_STACK_*); the Véracier defaults stand when nothing is set, and the older KF_VERACIER_*
// names still work, so `pnpm fixture:veracier` against the Véracier stack is unchanged.
//
//   KF_STACK_STATE          state directory (credentials, logins, ids files)   ~/.local/state/kf-veracier
//   KF_STACK_API_PORT       API port on 127.0.0.1                                4100
//   KF_STACK_WEB_PORT       web port on localhost                                3100
//   KF_STACK_KEYCLOAK_PORT  Keycloak port on localhost                           18080
//   KF_STACK_PG_PORT        PostgreSQL port on 127.0.0.1                         15432

import { homedir } from 'node:os';
import path from 'node:path';

export const REALM = 'knowledge-fabric';

export function stackSettings(env = process.env) {
  const pick = (name, legacy, fallback) => env[`KF_STACK_${name}`] ?? env[legacy] ?? fallback;
  const state = pick(
    'STATE',
    'KF_VERACIER_STATE',
    path.join(homedir(), '.local', 'state', 'kf-veracier'),
  );
  const apiPort = pick('API_PORT', 'KF_VERACIER_API_PORT', '4100');
  const webPort = pick('WEB_PORT', 'KF_VERACIER_WEB_PORT', '3100');
  const keycloak =
    env.KF_STACK_KEYCLOAK_PORT !== undefined
      ? `http://localhost:${env.KF_STACK_KEYCLOAK_PORT}`
      : (env.KF_VERACIER_KEYCLOAK ?? 'http://localhost:18080');
  const pgPort = env.KF_STACK_PG_PORT ?? '15432';
  const web = `http://localhost:${webPort}`;
  return {
    state,
    api: `http://127.0.0.1:${apiPort}`,
    web,
    keycloak,
    ownerUrl: `postgres://kf_owner@localhost:${pgPort}/kf?sslmode=disable`,
    oidc: {
      issuer: `${keycloak}/realms/${REALM}`,
      clientId: 'knowledge-fabric-web',
      redirectUri: `${web}/auth/callback`,
    },
  };
}

/** ~/.config/kf/<corpus>-personas.txt unless KF_<CORPUS>_PERSONAS names another file. */
export function personasFile(corpus, env = process.env) {
  const variable = `KF_${corpus.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PERSONAS`;
  return env[variable] ?? path.join(homedir(), '.config', 'kf', `${corpus}-personas.txt`);
}
