import { S3ObjectStore } from '@kf/artifacts';
import { createPool, type Pool } from '@kf/database';
import { createDocumentActionAtoms, PandocDocumentParser } from '@kf/documents';
import { createFabricTransactionalDispatcher } from '@kf/orchestrator';
import { bootstrapIdentity, createAppLogin } from './bootstrap.js';
import { APP_LOGIN, APP_PASSWORD, requiredOwnerUrl, sourceDirectory } from './config.js';
import { loadDocumentConstitution } from './load.js';
import { stageDocumentConstitution } from './manifest.js';

export async function runDocumentConstitutionDogfood(): Promise<void> {
  const directory = sourceDirectory();
  const ownerUrl = requiredOwnerUrl();
  const owner = createPool({ connectionString: ownerUrl, maxConnections: 2 });
  let app: Pool | undefined;
  try {
    const database = await createAppLogin(owner);
    const identity = await bootstrapIdentity(owner);
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
  } finally {
    await app?.end();
    await owner.end();
  }
}
