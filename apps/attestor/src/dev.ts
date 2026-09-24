/**
 * kf-attestor on a workstation: `pnpm --filter @kf/attestor dev`, or started by `pnpm dev:dogfood`.
 *
 * The same process as `main.ts` — nothing here changes what it verifies or whom it accepts — with
 * the two workstation defaults filled in when they are unset: the database login `pnpm
 * dogfood:logins` wrote (kf_attestor and nothing else) and the local socket path. Every other
 * input (OIDC_*) is still required, and main still refuses a login that could act as well as
 * attest.
 *
 * Refused outside NODE_ENV=development, so a host can never start it by mistake: a host's unit
 * runs dist/main.js with its own EnvironmentFile and /etc/kf/attestor/database-url.
 */

import { existsSync } from 'node:fs';
import { devAttestorSocket, devStateFile } from '@kf/operations';

if (process.env['NODE_ENV'] !== 'development') {
  console.error('fatal: the attestor dev entry runs only with NODE_ENV=development');
  process.exit(1);
}
if (existsSync('/etc/kf')) {
  console.error('fatal: /etc/kf exists, so this is a provisioned host; run kf-attestor.service');
  process.exit(1);
}

const env = process.env;
const unset = (name: string): boolean => env[name] === undefined || env[name] === '';
if (unset('DATABASE_URL') && unset('DATABASE_URL_FILE')) {
  const file = devStateFile('attestor', env);
  if (!existsSync(file)) {
    console.error(
      `fatal: ${file} does not exist. Run \`pnpm dogfood:logins\` (owner connection, once) to ` +
        'create the attestor login and write it there.',
    );
    process.exit(1);
  }
  env['DATABASE_URL_FILE'] = file;
}
if (unset('KF_ATTESTOR_SOCKET')) env['KF_ATTESTOR_SOCKET'] = devAttestorSocket(env);

await import('./main.js');
