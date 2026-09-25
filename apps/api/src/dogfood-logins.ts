/**
 * `pnpm dogfood:logins` — the dogfood API's and kf-attestor's workstation logins, with their
 * connection strings written owner-only. See `./dogfood/logins.ts`.
 *
 * Workstation only: refused where /etc/kf marks a provisioned host, without NODE_ENV=development,
 * and for a database that is not on loopback — exactly as `pnpm dogfood:load` is.
 */

import { createPool } from '@kf/database';
import { assertNotPrivateHost, requiredOwnerUrl } from './dogfood/config.js';
import { createDogfoodLogins } from './dogfood/logins.js';

assertNotPrivateHost();
const ownerUrl = requiredOwnerUrl();
const owner = createPool({ connectionString: ownerUrl, maxConnections: 2 });
try {
  const logins = await createDogfoodLogins(owner, ownerUrl);
  // Paths, never passwords: each password is new on this run and lives only in its file.
  process.stdout.write(
    [
      `${logins.apiLogin} (kf_app only)            -> ${logins.apiUrlFile}`,
      `${logins.attestorLogin} (kf_attestor only) -> ${logins.attestorUrlFile}`,
      `${logins.workerLogin} (kf_worker only)   -> ${logins.workerUrlFile}`,
      '',
      'Next, with the OIDC_* values set in .env:  pnpm dev:dogfood',
      '',
    ].join('\n'),
  );
} finally {
  await owner.end();
}
