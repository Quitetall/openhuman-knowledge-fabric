import { S3ObjectStore } from '@kf/artifacts';
import { createPool, setResolvedAccessContext, withTransaction, type Pool } from '@kf/database';
import { createDocumentActionAtoms, PandocDocumentParser } from '@kf/documents';
import { createFabricTransactionalDispatcher } from '@kf/orchestrator';
import { bootstrapIdentity, createAppLogin } from './bootstrap.js';
import { APP_LOGIN, APP_PASSWORD, requiredOwnerUrl, sourceDirectory } from './config.js';
import { loadDocumentConstitution } from './load.js';
import { stageDocumentConstitution } from './manifest.js';

async function assertDogfoodIdentityReady(
  owner: Pool,
  identity: {
    readonly organizationId: string;
    readonly actorId: string;
    readonly actingRoleId: string;
  },
): Promise<void> {
  try {
    await withTransaction(owner, async (tx) => {
      const decision = await setResolvedAccessContext(tx, {
        subjectId: identity.actorId,
        assignmentId: identity.actingRoleId,
        organizationId: identity.organizationId,
        requestedClassification: 'restricted',
      });
      if (decision !== 'restricted') {
        throw new Error('classification resolver returned no restricted dogfood decision');
      }
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `dogfood identity is not ready: actor ${identity.actorId} in organization ` +
        `${identity.organizationId} needs a human-authorized restricted clearance before ` +
        `document loading (${detail})`,
      { cause: error },
    );
  }
}

export async function runDocumentConstitutionDogfood(): Promise<void> {
  const directory = sourceDirectory();
  const ownerUrl = requiredOwnerUrl();
  const owner = createPool({ connectionString: ownerUrl, maxConnections: 2 });
  let app: Pool | undefined;
  try {
    const identity = await bootstrapIdentity(owner);
    // Validate authority before staging bytes. A missing clearance is an expected fail-closed
    // operator state, not a reason to write unreferenced object-store data first.
    await assertDogfoodIdentityReady(owner, identity);
    const database = await createAppLogin(owner);
    const appUrl = new URL(ownerUrl);
    appUrl.username = APP_LOGIN;
    appUrl.password = APP_PASSWORD;
    appUrl.pathname = `/${database}`;
    app = createPool({ connectionString: appUrl.toString(), maxConnections: 4 });

    const store = new S3ObjectStore({
      endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
      region: process.env['S3_REGION'] ?? 'us-east-1',
      accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'kf-dev-access-key',
      secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? APP_PASSWORD,
      bucket: process.env['S3_BUCKET_ARTIFACTS'] ?? 'kf-artifacts',
      forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] !== 'false',
    });
    const execute = createFabricTransactionalDispatcher(
      createDocumentActionAtoms({ store, parser: new PandocDocumentParser() }),
    );
    const staged = await stageDocumentConstitution(directory, store);
    const result = await loadDocumentConstitution(app, store, execute, identity, staged);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

    // `.env.example` told the reader "the dogfood loader prints the three generated UUIDs; copy
    // them into the blank values below before starting the web app" — and until 2026-08-21 it
    // printed no such thing. The instruction had never been walked. Without these three values
    // the web app throws on `required('KF_DEV_ACTOR')`, and the only way to recover was to know
    // the schema well enough to query core.object by hand, which is not onboarding.
    //
    // Printed last, in paste-ready form, so it is what remains on screen when the loader ends.
    // All three are UUIDs — KF_DEV_ACTING_ROLE is an `org.role_assignment` id, not a role name.
    // Printing the real values rather than describing them is what makes that unarguable; a
    // comment claiming otherwise survived a day here before the output disproved it.
    process.stdout.write(
      [
        '',
        '# Paste into .env before `pnpm dev` — the web app requires all three.',
        `KF_DEV_ORGANIZATION=${identity.organizationId}`,
        `KF_DEV_ACTOR=${identity.actorId}`,
        `KF_DEV_ACTING_ROLE=${identity.actingRoleId}`,
        '',
      ].join('\n'),
    );
  } finally {
    await app?.end();
    await owner.end();
  }
}
