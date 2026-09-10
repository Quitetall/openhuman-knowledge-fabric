import { createPool } from '@kf/database';
import {
  bootstrapUsage,
  parseBootstrapArgs,
  planBootstrap,
  runBootstrap,
} from './admin/bootstrap-organization.js';

const ownerUrl = process.env['DATABASE_OWNER_URL'];
if (ownerUrl === undefined || ownerUrl.trim() === '') {
  console.error('DATABASE_OWNER_URL is required: this writes authority and needs the owner role');
  process.exit(1);
}

let request;
try {
  request = parseBootstrapArgs(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`\n${bootstrapUsage()}`);
  process.exit(1);
}

const plan = planBootstrap(request);
if (!plan.ok) {
  for (const refusal of plan.refusals) console.error(refusal);
  console.error(`\n${bootstrapUsage()}`);
  process.exit(1);
}

const pool = createPool({ connectionString: ownerUrl });
try {
  let result;
  try {
    result = await runBootstrap(pool, plan.declaration!);
  } catch (error: unknown) {
    // A refusal is a feature, and a refusal printed as a stack trace is not one. The message
    // says what happened and what to do; the trace says where the throw was written.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    await pool.end();
    process.exit(1);
  }
  console.error(result.reused ? 'already present:' : 'created:');
  console.error(`  organization ${result.organizationId}`);
  console.error(`  person       ${result.personId}`);
  console.error('\nNext: grant this person a role and a clearance. That is a human act:');
  console.error(`  pnpm kf:grant-authority --person ${result.personId} \\`);
  console.error(`      --organization ${result.organizationId} --role <role> ...`);
} finally {
  await pool.end();
}
