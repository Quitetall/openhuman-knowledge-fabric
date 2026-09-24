import { StoreRegistry } from '@kf/artifacts';
import {
  createPool,
  issueAttestation,
  registerAttestationIssuer,
  setResolvedAccessContext,
  withTransaction,
  type Pool,
} from '@kf/database';
import { createDocumentActionAtoms, PandocDocumentParser } from '@kf/documents';
import { createFabricTransactionalDispatcher } from '@kf/orchestrator';
import { bootstrapIdentity, createAppLogin } from './bootstrap.js';
import {
  APP_LOGIN,
  assertNotPrivateHost,
  DEV_S3_SECRET,
  devDatabaseUrlFile,
  generateAppPassword,
  requiredOwnerUrl,
  sourceDirectory,
  writeOwnerOnly,
} from './config.js';
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
        // The OWNER connection: an administrator binds without an attestation.
        attestation: undefined,
      });
      if (decision !== 'restricted') {
        throw new Error('classification resolver returned no restricted dogfood decision');
      }
    });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { readonly code?: unknown }).code ?? '')
        : '';
    if (code !== '42501' && code !== 'P0001' && !/classification|clearance/i.test(detail)) {
      throw error;
    }
    throw new Error(
      `dogfood identity is not ready: actor ${identity.actorId} in organization ` +
        `${identity.organizationId} needs a human-authorized restricted clearance before ` +
        `document loading (${detail})`,
      { cause: error },
    );
  }
}

export async function runDocumentConstitutionDogfood(): Promise<void> {
  assertNotPrivateHost();
  const directory = sourceDirectory();
  const ownerUrl = requiredOwnerUrl();
  const owner = createPool({ connectionString: ownerUrl, maxConnections: 2 });
  let app: Pool | undefined;
  try {
    const identity = await bootstrapIdentity(owner);
    // Validate authority before staging bytes. A missing clearance is an expected fail-closed
    // operator state, not a reason to write unreferenced object-store data first.
    await assertDogfoodIdentityReady(owner, identity);
    const password = generateAppPassword();
    const database = await createAppLogin(owner, password);
    const appUrl = new URL(ownerUrl);
    appUrl.username = APP_LOGIN;
    appUrl.password = password;
    appUrl.pathname = `/${database}`;
    // Written before use, so a run that fails later still leaves the API a working credential
    // for the login it just re-keyed.
    const urlFile = devDatabaseUrlFile();
    await writeOwnerOnly(urlFile, appUrl.toString());
    app = createPool({ connectionString: appUrl.toString(), maxConnections: 4 });
    // The loader binds its operator through the development login, which attests in-process
    // exactly as the development API does (createAppLogin granted it kf_attestor).
    const attesting = app;
    registerAttestationIssuer(attesting, (principal) =>
      withTransaction(attesting, (tx) => issueAttestation(tx, principal)),
    );

    // Through the registry like every other store holder (KF-SAS-RQ-095): a loader pointed at a
    // bucket other than the one this database registered as `working` is refused.
    const working = {
      endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
      region: process.env['S3_REGION'] ?? 'us-east-1',
      accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'kf-dev-access-key',
      secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? DEV_S3_SECRET,
      bucket: process.env['S3_BUCKET_ARTIFACTS'] ?? 'kf-artifacts',
      forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] !== 'false',
    };
    const registry = await withTransaction(attesting, (tx) =>
      StoreRegistry.fromDatabase(tx, { working }),
    );
    const store = registry.get('working');
    if (store === undefined) throw new Error('the working store did not resolve');
    const execute = createFabricTransactionalDispatcher(
      createDocumentActionAtoms({ store, parser: new PandocDocumentParser() }),
    );
    const staged = await stageDocumentConstitution(directory, store, identity.organizationId);
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
        // The login's password changes on every run and is never printed; the API reads the
        // connection string from this owner-only file.
        `DATABASE_URL_FILE=${urlFile}`,
        '',
      ].join('\n'),
    );
  } finally {
    await app?.end();
    await owner.end();
  }
}
