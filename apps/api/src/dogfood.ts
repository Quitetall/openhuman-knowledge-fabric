/** Load OpenHuman's founding documents as draft, parsed, auditable dogfood records. */

import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { digestOf, S3ObjectStore } from '@kf/artifacts';
import {
  createPool,
  setAccessContext,
  setTransactionContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';
import {
  artifactKindForDocumentClass,
  createDocumentActionAtoms,
  PandocDocumentParser,
} from '@kf/documents';
import { createFabricDispatcher } from '@kf/orchestrator';
import { createControlledObject } from '@kf/record-atoms';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MANIFEST = join(ROOT, 'dogfood', 'document-constitution.json');
const BOOTSTRAP_IDENTITY = '01930000-0000-7000-8000-00000000b007';
const BOOTSTRAP_ACTION = '01930000-0000-7000-8000-00000000ac10';
const APP_LOGIN = 'kf_api_dev';
const APP_PASSWORD = 'dev-only-not-a-secret';

interface ManifestEntry {
  readonly file: string;
  readonly title: string;
  readonly documentNumber: string;
  readonly revision: string;
  readonly documentClass: string;
  readonly owningRole: string;
}

interface DogfoodIdentity {
  readonly organizationId: string;
  readonly actorId: string;
  readonly actingRoleId: string;
}

function sourceDirectory(): string {
  const flag = process.argv.indexOf('--source-dir');
  const argument = flag === -1 ? undefined : process.argv[flag + 1];
  const source = argument ?? process.env['KF_CONSTITUTION_DIR'];
  if (source === undefined || source.trim() === '') {
    throw new Error('Pass --source-dir or set KF_CONSTITUTION_DIR.');
  }
  return resolve(source);
}

function requiredOwnerUrl(): string {
  if (process.env['NODE_ENV'] !== 'development') {
    throw new Error('Dogfood loader runs only with NODE_ENV=development.');
  }
  const value = process.env['DATABASE_OWNER_URL'];
  if (value === undefined || value.trim() === '') {
    throw new Error('DATABASE_OWNER_URL is required for local bootstrap.');
  }
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('DATABASE_OWNER_URL must target local PostgreSQL.');
  }
  return value;
}

function mediaType(file: string): string {
  const extension = extname(file).toLowerCase();
  if (extension === '.docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (extension === '.odt') return 'application/vnd.oasis.opendocument.text';
  if (extension === '.md') return 'text/markdown';
  if (extension === '.txt') return 'text/plain';
  throw new Error(`Unsupported document extension: ${extension || '(none)'}`);
}

function manifestEntry(value: unknown, index: number): ManifestEntry {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Manifest entry ${index + 1} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const read = (key: string): string => {
    const field = record[key];
    if (typeof field !== 'string' || field.trim() === '') {
      throw new Error(`Manifest entry ${index + 1} has invalid ${key}.`);
    }
    return field;
  };
  return {
    file: read('file'),
    title: read('title'),
    documentNumber: read('documentNumber'),
    revision: read('revision'),
    documentClass: read('documentClass'),
    owningRole: read('owningRole'),
  };
}

async function readManifest(): Promise<ManifestEntry[]> {
  const raw: unknown = JSON.parse(await readFile(MANIFEST, 'utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Dogfood manifest is empty.');
  return raw.map(manifestEntry);
}

async function createAppLogin(owner: Pool): Promise<string> {
  return withTransaction(owner, async (tx) => {
    await tx.query(
      `do $$ begin
         if not exists (select from pg_roles where rolname = '${APP_LOGIN}') then
           create role ${APP_LOGIN} login password '${APP_PASSWORD}' inherit;
         else
           alter role ${APP_LOGIN} login password '${APP_PASSWORD}' inherit;
         end if;
       end $$`,
    );
    await tx.query(`grant kf_app to ${APP_LOGIN}`);
    const grant = await tx.one<{ sql: string }>(
      `select format('grant connect on database %I to ${APP_LOGIN}', current_database()) as sql`,
    );
    await tx.query(grant.sql);
    const database = await tx.one<{ name: string }>('select current_database() as name');
    return database.name;
  });
}

async function createPerson(tx: Tx, organizationId: string): Promise<string> {
  const id = await createControlledObject(tx, {
    objectType: 'person',
    authorityDomain: 'organization',
    lifecycleState: 'active',
    title: 'Local Dogfood Operator',
    organizationId,
    createdBy: BOOTSTRAP_IDENTITY,
  });
  await tx.query(
    `insert into org.person (id, display_name, organization)
     values ($1, 'Local Dogfood Operator', $2)`,
    [id, organizationId],
  );
  return id;
}

async function createRole(tx: Tx, organizationId: string, actorId: string): Promise<string> {
  const id = await createControlledObject(tx, {
    objectType: 'role_assignment',
    authorityDomain: 'organization',
    lifecycleState: 'active',
    title: 'Local dogfood system administrator',
    organizationId,
    createdBy: BOOTSTRAP_IDENTITY,
  });
  await tx.query(
    `insert into org.role_assignment (id, subject_id, role_id, scope_id)
     values ($1,$2,'system_administrator',$3)`,
    [id, actorId, organizationId],
  );
  return id;
}

async function bootstrapIdentity(owner: Pool): Promise<DogfoodIdentity> {
  return withTransaction(owner, async (tx) => {
    await setAccessContext(tx, {
      organizationId: BOOTSTRAP_IDENTITY,
      maxClassification: 'restricted',
    });
    await setTransactionContext(tx, {
      actorId: BOOTSTRAP_IDENTITY,
      actingRoleId: BOOTSTRAP_IDENTITY,
      actionId: BOOTSTRAP_ACTION,
      requestId: 'local-dogfood-bootstrap',
    });

    let organizationId = (
      await tx.maybeOne<{ id: string }>(
        `select o.id
           from core.object o
           join org.organization g on g.id = o.id
          where g.legal_name = 'OpenHuman Technologies LLC'
          order by o.created_at limit 1`,
      )
    )?.id;
    if (organizationId === undefined) {
      organizationId = await createControlledObject(tx, {
        objectType: 'organization',
        authorityDomain: 'organization',
        lifecycleState: 'active',
        title: 'OpenHuman Technologies LLC',
        organizationId: BOOTSTRAP_IDENTITY,
        createdBy: BOOTSTRAP_IDENTITY,
      });
      await tx.query(
        `update core.object
            set organization_id = $1, row_version = row_version + 1
          where id = $1`,
        [organizationId],
      );
      await tx.query(
        `insert into org.organization (id, legal_name, organization_kind)
         values ($1, 'OpenHuman Technologies LLC', 'company')`,
        [organizationId],
      );
    }
    await setAccessContext(tx, { organizationId, maxClassification: 'restricted' });

    let actorId = (
      await tx.maybeOne<{ id: string }>(
        `select p.id
           from org.person p
          where p.organization = $1 and p.display_name = 'Local Dogfood Operator'
          order by p.id limit 1`,
        [organizationId],
      )
    )?.id;
    actorId ??= await createPerson(tx, organizationId);

    let actingRoleId = (
      await tx.maybeOne<{ id: string }>(
        `select id from org.role_assignment
          where subject_id = $1 and role_id = 'system_administrator'
            and scope_id = $2 and valid_from <= now()
            and (valid_to is null or valid_to > now())
          order by valid_from limit 1`,
        [actorId, organizationId],
      )
    )?.id;
    actingRoleId ??= await createRole(tx, organizationId, actorId);
    return { organizationId, actorId, actingRoleId };
  });
}

async function latestVersion(pool: Pool, organizationId: string, artifactId: string) {
  return withTransaction(pool, async (tx) => {
    await setAccessContext(tx, { organizationId, maxClassification: 'restricted' });
    return tx.one<{ id: string }>(
      `select id from content.artifact_version
        where artifact_id = $1 order by version_no desc limit 1`,
      [artifactId],
    );
  });
}

async function main(): Promise<void> {
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
    const execute = createFabricDispatcher(
      app,
      createDocumentActionAtoms({ store, parser: new PandocDocumentParser() }),
    );
    const loaded: Array<Record<string, unknown>> = [];
    for (const entry of await readManifest()) {
      const bytes = await readFile(join(directory, entry.file));
      const sha256 = digestOf(bytes);
      const key = `document-imports/${sha256}`;
      await store.put(key, bytes, mediaType(entry.file));
      const common = {
        ...identity,
        maxClassification: 'restricted',
        targetIds: [],
        requestId: 'document-constitution-dogfood',
      } as const;
      const artifact = await execute({
        ...common,
        actionType: 'attach_evidence',
        idempotencyKey: `dogfood:${entry.documentNumber}:${entry.revision}:${sha256}:artifact`,
        payload: {
          title: basename(entry.file),
          artifact_kind: artifactKindForDocumentClass(entry.documentClass),
          sha256,
          size_bytes: bytes.length,
          media_type: mediaType(entry.file),
          storage_uri: key,
          revision_label: entry.revision,
        },
      });
      const artifactId = artifact.objectIds[0];
      if (artifactId === undefined) throw new Error('attach_evidence returned no artifact id');
      const version = await latestVersion(app, identity.organizationId, artifactId);
      const document = await execute({
        ...common,
        actionType: 'add_controlled_document',
        idempotencyKey: `dogfood:${entry.documentNumber}:${entry.revision}:${sha256}:document`,
        payload: {
          title: entry.title,
          document_number: entry.documentNumber,
          revision: entry.revision,
          document_class: entry.documentClass,
          owning_role: entry.owningRole,
          content_version: version.id,
        },
      });
      loaded.push({
        documentNumber: entry.documentNumber,
        revision: entry.revision,
        documentId: document.objectIds[0],
        artifactId,
        sha256,
        replayed: artifact.replayed && document.replayed,
      });
    }
    process.stdout.write(`${JSON.stringify({ identity, loaded }, null, 2)}\n`);
  } finally {
    await app?.end();
    await owner.end();
  }
}

await main();
