/**
 * Grant one person the authority to act. Owner credentials, one transaction, fully recorded.
 *
 * See `./admin/grant-authority.ts` for why this is a bootstrap act rather than a dispatched
 * action, and `docs/deployment/identity-and-login.md` for where it sits in getting a login to
 * work end to end.
 */

import { createPool } from '@kf/database';
import {
  parseGrantAuthorityArgs,
  planGrantAuthority,
  runGrantAuthority,
} from './admin/grant-authority.js';

const ownerUrl = process.env['DATABASE_OWNER_URL'];
if (ownerUrl === undefined || ownerUrl.trim() === '') {
  console.error('DATABASE_OWNER_URL is required: this writes authority and needs the owner role');
  process.exit(1);
}

let request;
try {
  request = parseGrantAuthorityArgs(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const plan = planGrantAuthority(request);
if (!plan.ok) {
  console.error('refusing to grant authority:');
  for (const refusal of plan.refusals) console.error(`  - ${refusal}`);
  process.exit(1);
}

const owner = createPool({ connectionString: ownerUrl, maxConnections: 2 });
try {
  const result = await runGrantAuthority(owner, plan.grant);
  const held = (reused: boolean): string => (reused ? '(already held)' : '(granted now)');
  if (result.changed) {
    console.log('authority granted, and recorded:');
    console.log(`  action        ${result.actionId}  (grant_person_clearance)`);
    console.log(`  audit digest  ${result.auditDigest}`);
  } else {
    // No act, so no action row and no audit link. Saying "granted" here would put a decision in
    // the operator's head that is not in the record.
    console.log('nothing to do — this authority already holds. Nothing was written:');
  }
  console.log(
    `  clearance     ${result.clearanceId}  ${plan.grant.classification} ${held(result.clearanceReused)}`,
  );
  console.log(
    `  role          ${result.roleAssignmentId}  ${plan.grant.roleId} ${held(result.roleAssignmentReused)}`,
  );
  if (result.identityId !== undefined) {
    console.log(`  identity      ${result.identityId} ${held(result.identityReused)}`);
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await owner.end();
}
