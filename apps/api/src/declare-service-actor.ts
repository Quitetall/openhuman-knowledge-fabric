/**
 * Declare a service actor. Owner credentials, one transaction, fully recorded (ADR 0020).
 *
 * See `./admin/declare-service-actor.ts` for what it creates and why it is an operator command.
 */
import { createPool } from '@kf/database';

import { ownerUrl as loadOwnerUrl } from './admin/commands.js';
import {
  parseDeclareServiceActorArgs,
  planDeclareServiceActor,
  runDeclareServiceActor,
} from './admin/declare-service-actor.js';

// The same loader as the other owner-tier commands: DATABASE_OWNER_URL_FILE, inline only in
// development and test (RQ-151).
const ownerUrl = loadOwnerUrl(process.env, process.stderr);
if (ownerUrl === undefined) process.exit(1);

let request;
try {
  request = parseDeclareServiceActorArgs(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const plan = planDeclareServiceActor(request);
if (!plan.ok || plan.declaration === undefined) {
  console.error('refusing to declare a service actor:');
  for (const refusal of plan.refusals) console.error(`  - ${refusal}`);
  process.exit(1);
}

const pool = createPool({ connectionString: ownerUrl, maxConnections: 1 });
runDeclareServiceActor(pool, plan.declaration).then(
  async (result) => {
    console.log(
      JSON.stringify(
        {
          service_actor: plan.declaration?.name,
          person_id: result.personId,
          role_assignment_id: result.roleAssignmentId,
          role_assignment_valid_to: result.roleAssignmentValidTo?.toISOString() ?? null,
          clearance_id: result.clearanceId,
          action_id: result.actionId,
          reused: result.reused,
          next:
            'set KF_STORAGE_ACTOR=<person_id> KF_STORAGE_ROLE=<role_assignment_id> for kf-storage; ' +
            'renew before role_assignment_valid_to with kf:grant-authority --renew (ADR 0036)',
        },
        null,
        2,
      ),
    );
    await pool.end();
  },
  async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await pool.end();
    process.exitCode = 1;
  },
);
