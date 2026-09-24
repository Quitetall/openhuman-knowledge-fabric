/**
 * What `pnpm dev:dogfood` starts, and in which order, decided without starting anything.
 *
 * The dogfood profile on a workstation is three processes that must agree on two things: the
 * attestor's socket, and which database login each holds. kf-attestor holds `kf_attestor` only;
 * the API holds `kf_app` only and reaches the attestor over the socket; the web app holds neither.
 * The attestor starts FIRST and must answer on its socket before the API starts, because a dogfood
 * API with no attestor answers every bearer request 503 (and its startup check refuses a
 * login holding kf_attestor, so there is no in-process fallback to reach for).
 *
 * The worker is not started: it needs a `kf_worker` login no workstation command creates, and the
 * dogfood rehearsal is about identity. `pnpm dev` (development profile) still runs it.
 */

import { existsSync } from 'node:fs';
import { devAttestorSocket, devStateFile } from './dev-state.js';

export interface DevProcess {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export type DogfoodDevPlan =
  | {
      readonly ok: true;
      readonly socket: string;
      /** Started first; the apps wait for it to answer GET /health on `socket`. */
      readonly attestor: DevProcess;
      /** The API and the web app, started once the attestor answers. */
      readonly apps: DevProcess;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

const OIDC = ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URI'] as const;
const WEB_OIDC = [
  'KF_WEB_OIDC_ISSUER',
  'KF_WEB_OIDC_CLIENT_ID',
  'KF_WEB_OIDC_REDIRECT_URI',
] as const;

/** An environment without any database credential, so a child can only use the one it is given. */
function withoutDatabase(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out['DATABASE_URL'];
  delete out['DATABASE_URL_FILE'];
  delete out['WORKER_DATABASE_URL'];
  delete out['WORKER_DATABASE_URL_FILE'];
  delete out['DATABASE_OWNER_URL'];
  delete out['DATABASE_OWNER_URL_FILE'];
  return out;
}

export function planDogfoodDev(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): DogfoodDevPlan {
  const problems: string[] = [];
  const set = (name: string): boolean => env[name] !== undefined && env[name]!.trim() !== '';

  const missingOidc = OIDC.filter((name) => !set(name));
  if (missingOidc.length > 0) {
    problems.push(
      `${missingOidc.join(', ')} not set: the API and kf-attestor verify bearer tokens against ` +
        'the identity provider (uncomment them in .env and `set -a; . ./.env; set +a`)',
    );
  }
  const missingWeb = WEB_OIDC.filter((name) => !set(name));
  if (!set('KF_WEB_SESSION_SECRET') && !set('KF_WEB_SESSION_SECRET_FILE')) {
    missingWeb.push('KF_WEB_SESSION_SECRET' as (typeof WEB_OIDC)[number]);
  }
  if (missingWeb.length > 0) {
    problems.push(`${missingWeb.join(', ')} not set: the web app signs people in under dogfood`);
  }

  const apiFile = devStateFile('dogfoodApi', env);
  const attestorFile = devStateFile('attestor', env);
  for (const file of [apiFile, attestorFile]) {
    if (!exists(file)) {
      problems.push(
        `${file} does not exist: run \`pnpm dogfood:logins\` once (owner connection) to create ` +
          'the kf_app-only API login and the kf_attestor-only attestor login',
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const socket = devAttestorSocket(env);
  const base = withoutDatabase(env);
  return {
    ok: true,
    socket,
    attestor: {
      command: 'pnpm',
      args: ['--filter', '@kf/attestor', 'dev'],
      env: { ...base, KF_ATTESTOR_SOCKET: socket, DATABASE_URL_FILE: attestorFile },
    },
    apps: {
      command: 'pnpm',
      args: ['--parallel', '--filter', '@kf/api', '--filter', '@kf/web', 'dev'],
      env: {
        ...base,
        KF_DEPLOYMENT_PROFILE: 'dogfood',
        KF_ATTESTOR_SOCKET: socket,
        DATABASE_URL_FILE: apiFile,
      },
    },
  };
}
