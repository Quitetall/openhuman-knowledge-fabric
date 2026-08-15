/** Load OpenHuman's founding documents as draft, parsed, auditable dogfood records. */

import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  mediaTypeForDocumentFile,
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

async function readManifest(): Promise<{
  readonly bytes: Buffer;
  readonly entries: ManifestEntry[];
}> {
  const bytes = await readFile(MANIFEST);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Dogfood manifest is empty.');
  return { bytes, entries: raw.map(manifestEntry) };
}

async function sourceFile(directory: string, file: string): Promise<Buffer> {
  const root = await realpath(directory);
  const candidate = await realpath(resolve(root, file));
  const fromRoot = relative(root, candidate);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Manifest source escapes source directory: ${file}`);
  }
  return readFile(candidate);
}

async function createAppLogin(owner: Pool): Promise<string> {
  return withTransaction(owner, async (tx) => {
    const role = await tx.one<{ sql: string }>(
      `select case when exists (select from pg_roles where rolname = $1)
              then format('alter role %I login password %L inherit', $1::text, $2::text)
              else format('create role %I login password %L inherit', $1::text, $2::text)
              end as sql`,
      [APP_LOGIN, APP_PASSWORD],
    );
    await tx.query(role.sql);
    const membership = await tx.one<{ sql: string }>(
      `select format('grant kf_app to %I', $1::text) as sql`,
      [APP_LOGIN],
    );
    await tx.query(membership.sql);
    const grant = await tx.one<{ sql: string }>(
      `select format('grant connect on database %I to %I', current_database(), $1::text) as sql`,
      [APP_LOGIN],
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
    title: 'Local dogfood document performer',
    organizationId,
    createdBy: BOOTSTRAP_IDENTITY,
  });
  await tx.query(
    `insert into org.role_assignment (id, subject_id, role_id, scope_id)
     values ($1,$2,'performer',$3)`,
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
          where subject_id = $1 and role_id = 'performer'
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

interface CurrentFragmentSource extends Record<string, unknown> {
  readonly objectId: string;
  readonly holderId: string;
  readonly holderKind: string;
  readonly contentDigest: string;
  readonly revisionId: string;
  readonly mediaType: string;
  readonly classification: string;
}

async function currentFragmentSource(
  pool: Pool,
  organizationId: string,
  stableKey: string,
): Promise<CurrentFragmentSource | undefined> {
  return withTransaction(pool, async (tx) => {
    await setAccessContext(tx, { organizationId, maxClassification: 'restricted' });
    return tx.maybeOne<CurrentFragmentSource>(
      `select s.object_id as "objectId", h.id as "holderId", h.holder_kind as "holderKind",
              h.content_digest as "contentDigest", r.id as "revisionId",
              r.media_type as "mediaType", r.classification
         from content.document_subject s
         join content.document_source_holder h on h.id = s.current_holder_id
         join content.authored_fragment_revision r
           on r.fragment_id = s.id and r.holder_id = h.id
        where s.stable_key = $1 and s.subject_kind = 'fragment'
          and not exists (
            select 1 from content.authored_fragment_revision next
             where next.previous_revision_id = r.id
          )`,
      [stableKey],
    );
  });
}

interface CurrentCompositionSource extends Record<string, unknown> {
  readonly objectId: string;
  readonly holderId: string;
  readonly holderKind: string;
  readonly contentDigest: string;
  readonly revisionId: string;
  readonly classification: string;
  readonly fragmentRevisionIds: readonly string[];
}

interface CurrentCompositionRow extends Record<string, unknown> {
  readonly objectId: string;
  readonly holderId: string;
  readonly holderKind: string;
  readonly contentDigest: string;
  readonly revisionId: string;
  readonly classification: string;
}

async function currentCompositionSource(
  pool: Pool,
  organizationId: string,
  stableKey: string,
): Promise<CurrentCompositionSource | undefined> {
  return withTransaction(pool, async (tx) => {
    await setAccessContext(tx, { organizationId, maxClassification: 'restricted' });
    const row = await tx.maybeOne<CurrentCompositionRow>(
      `select s.object_id as "objectId", h.id as "holderId", h.holder_kind as "holderKind",
              h.content_digest as "contentDigest", r.id as "revisionId", o.classification
         from content.document_subject s
         join core.object o on o.id = s.object_id
         join content.document_source_holder h on h.id = s.current_holder_id
         join content.composition_revision r on r.composition_id = s.id
        where s.stable_key = $1 and s.subject_kind = 'composition'
          and not exists (
            select 1 from content.composition_revision next
             where next.previous_revision_id = r.id
          )`,
      [stableKey],
    );
    if (row === undefined) return undefined;
    const inputs = await tx.query<{ fragment_revision_id: string }>(
      `select fragment_revision_id
         from content.composition_input
        where composition_revision_id = $1 and input_role = 'fragment'
        order by ordinal`,
      [row.revisionId],
    );
    return { ...row, fragmentRevisionIds: inputs.map((input) => input.fragment_revision_id) };
  });
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
    const manifest = await readManifest();
    const loaded: Array<Record<string, unknown>> = [];
    const fragmentRevisionIds: string[] = [];
    for (const entry of manifest.entries) {
      const bytes = await sourceFile(directory, entry.file);
      const mediaType = mediaTypeForDocumentFile(entry.file);
      if (mediaType === undefined) throw new Error(`Unsupported document file: ${entry.file}`);
      const sha256 = digestOf(bytes);
      const key = `document-imports/${sha256}`;
      await store.put(key, bytes, mediaType);
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
          media_type: mediaType,
          storage_uri: key,
          revision_label: entry.revision,
        },
      });
      const artifactId = artifact.objectIds[0];
      if (artifactId === undefined) throw new Error('attach_evidence returned no artifact id');
      const version = await latestVersion(app, identity.organizationId, artifactId);
      const stableKey = `openhuman.constitution.${entry.documentNumber}`;
      const currentFragment = await currentFragmentSource(app, identity.organizationId, stableKey);
      if (currentFragment !== undefined && currentFragment.holderKind !== 'fabric_native') {
        throw new Error(
          `Dogfood loader cannot transfer Holder authority for existing source ${stableKey}.`,
        );
      }
      let fragmentId: string;
      let fragmentRevisionId: string;
      let fragmentReplayed: boolean;
      if (
        currentFragment !== undefined &&
        currentFragment.contentDigest === sha256 &&
        currentFragment.mediaType === mediaType &&
        currentFragment.classification === 'internal'
      ) {
        fragmentId = currentFragment.objectId;
        fragmentRevisionId = currentFragment.revisionId;
        fragmentReplayed = true;
      } else if (currentFragment === undefined) {
        const holderId = randomUUID();
        fragmentRevisionId = randomUUID();
        const fragment = await execute({
          ...common,
          actionType: 'add_authored_fragment',
          idempotencyKey: `dogfood:${entry.documentNumber}:${entry.revision}:${sha256}:fragment`,
          payload: {
            title: entry.title,
            stable_key: stableKey,
            holder_id: holderId,
            holder: {
              kind: 'fabric_native',
              artifact_version_id: version.id,
              content_digest: sha256,
            },
            revision_id: fragmentRevisionId,
            media_type: mediaType,
            classification: 'internal',
            document_policy: 'ordinary',
          },
        });
        const createdId = fragment.objectIds[0];
        if (createdId === undefined) throw new Error('add_authored_fragment returned no object id');
        fragmentId = createdId;
        fragmentReplayed = fragment.replayed;
      } else {
        fragmentRevisionId = randomUUID();
        const fragment = await execute({
          ...common,
          actionType: 'revise_authored_fragment',
          targetIds: [currentFragment.objectId],
          idempotencyKey: `dogfood:${entry.documentNumber}:${entry.revision}:${sha256}:fragment`,
          payload: {
            revision_id: fragmentRevisionId,
            previous_revision_id: currentFragment.revisionId,
            holder_id: randomUUID(),
            previous_holder_id: currentFragment.holderId,
            holder: {
              kind: 'fabric_native',
              artifact_version_id: version.id,
              content_digest: sha256,
            },
            media_type: mediaType,
            classification: 'internal',
          },
        });
        fragmentId = currentFragment.objectId;
        fragmentReplayed = fragment.replayed;
      }
      fragmentRevisionIds.push(fragmentRevisionId);
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
        fragmentId,
        fragmentRevisionId,
        sha256,
        replayed: artifact.replayed && fragmentReplayed && document.replayed,
      });
    }

    const manifestSha256 = digestOf(manifest.bytes);
    const manifestKey = `document-imports/${manifestSha256}`;
    await store.put(manifestKey, manifest.bytes, 'application/json');
    const common = {
      ...identity,
      maxClassification: 'restricted',
      targetIds: [],
      requestId: 'document-constitution-dogfood',
    } as const;
    const manifestArtifact = await execute({
      ...common,
      actionType: 'attach_evidence',
      idempotencyKey: `dogfood:document-constitution:${manifestSha256}:artifact`,
      payload: {
        title: basename(MANIFEST),
        artifact_kind: 'specification',
        sha256: manifestSha256,
        size_bytes: manifest.bytes.length,
        media_type: 'application/json',
        storage_uri: manifestKey,
      },
    });
    const manifestArtifactId = manifestArtifact.objectIds[0];
    if (manifestArtifactId === undefined) {
      throw new Error('constitution manifest attach_evidence returned no artifact id');
    }
    const manifestVersion = await latestVersion(app, identity.organizationId, manifestArtifactId);
    const compositionStableKey = 'openhuman.document-constitution';
    const currentComposition = await currentCompositionSource(
      app,
      identity.organizationId,
      compositionStableKey,
    );
    if (currentComposition !== undefined && currentComposition.holderKind !== 'fabric_native') {
      throw new Error(
        `Dogfood loader cannot transfer Holder authority for existing source ${compositionStableKey}.`,
      );
    }
    const inputs = fragmentRevisionIds.map((fragmentRevisionId, index) => ({
      ordinal: index + 1,
      role: 'fragment' as const,
      fragment_revision_id: fragmentRevisionId,
    }));
    const compositionDigest = digestOf(
      Buffer.from(JSON.stringify({ manifestSha256, fragmentRevisionIds })),
    );
    let compositionId: string;
    let compositionRevisionId: string;
    let compositionReplayed: boolean;
    if (
      currentComposition !== undefined &&
      currentComposition.contentDigest === manifestSha256 &&
      currentComposition.classification === 'internal' &&
      sameSequence(currentComposition.fragmentRevisionIds, fragmentRevisionIds)
    ) {
      compositionId = currentComposition.objectId;
      compositionRevisionId = currentComposition.revisionId;
      compositionReplayed = true;
    } else if (currentComposition === undefined) {
      compositionRevisionId = randomUUID();
      const composition = await execute({
        ...common,
        actionType: 'add_document_composition',
        idempotencyKey: `dogfood:document-constitution:${compositionDigest}:composition`,
        payload: {
          title: 'OpenHuman Document Constitution',
          stable_key: compositionStableKey,
          holder_id: randomUUID(),
          holder: {
            kind: 'fabric_native',
            artifact_version_id: manifestVersion.id,
            content_digest: manifestSha256,
          },
          revision_id: compositionRevisionId,
          classification: 'internal',
          document_policy: 'ordinary',
          inputs,
        },
      });
      const createdId = composition.objectIds[0];
      if (createdId === undefined) {
        throw new Error('add_document_composition returned no object id');
      }
      compositionId = createdId;
      compositionReplayed = composition.replayed;
    } else {
      compositionRevisionId = randomUUID();
      const composition = await execute({
        ...common,
        actionType: 'revise_document_composition',
        targetIds: [currentComposition.objectId],
        idempotencyKey: `dogfood:document-constitution:${compositionDigest}:composition`,
        payload: {
          revision_id: compositionRevisionId,
          previous_revision_id: currentComposition.revisionId,
          holder_id: randomUUID(),
          previous_holder_id: currentComposition.holderId,
          holder: {
            kind: 'fabric_native',
            artifact_version_id: manifestVersion.id,
            content_digest: manifestSha256,
          },
          classification: 'internal',
          inputs,
        },
      });
      compositionId = currentComposition.objectId;
      compositionReplayed = composition.replayed;
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          identity,
          loaded,
          composition: {
            compositionId,
            compositionRevisionId,
            manifestArtifactId,
            manifestSha256,
            replayed: manifestArtifact.replayed && compositionReplayed,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await app?.end();
    await owner.end();
  }
}

await main();
