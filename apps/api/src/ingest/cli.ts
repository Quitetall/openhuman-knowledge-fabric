/**
 * The operator-facing ingest seam.
 *
 * Planning is pure and happens before credentials, database pools, source files, or object
 * storage are touched. Once a plan is accepted, authority is checked through the owner
 * connection, bytes are staged (copy) or hashed (reference), and every record is dispatched
 * through the constrained application connection in one transaction.
 */

import { readFile, lstat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { digest, digestBytes, type JsonValue } from '@kf/canonicalization';
import {
  createPool,
  setResolvedAccessContext,
  withTransaction,
  type Pool,
  type Tx,
} from '@kf/database';
import { S3ObjectStore, verifyUpload, type ObjectStore } from '@kf/artifacts';
import { resolveCaller, TokenVerifier, type Caller, type IdentityConfig } from '@kf/authorization';
import {
  createDocumentActionAtoms,
  PandocDocumentParser,
  type DocumentParser,
} from '@kf/documents';
import { createFabricTransactionalDispatcher } from '@kf/orchestrator';
import { loadSecret, readSecretFile } from '@kf/operations';
import type { ActionResult, TransactionalActionDispatcher } from '@kf/actions';
import { planIngest, type IngestMode, type IngestPlan } from './plan.js';
import { driveClientFromEnv, type DriveClient, type DriveFetched } from './drive.js';

export type IngestIdentity = 'dev' | 'oidc';

export interface IngestCliArgs {
  readonly mode?: string;
  readonly classification?: string;
  readonly identity?: IngestIdentity;
  readonly revisionLabel?: string;
  readonly artifactKind?: string;
  readonly referenceManifest?: string;
  readonly organizationId?: string;
  readonly actingRoleId?: string;
  readonly tokenFile?: string;
  readonly reason?: string;
  /** Google Drive sources (ADR 0022), repeatable. */
  readonly driveRefs?: readonly string[];
  /** Export MIME type for Google-native documents; defaults per type. */
  readonly exportMimeType?: string;
  readonly json: boolean;
  readonly paths: readonly string[];
}

export interface ReferenceManifestEntry {
  readonly path: string;
  readonly source_system: string;
  readonly authority: string;
  readonly locator_system: string;
  readonly external_id: string;
  readonly title?: string;
  readonly uri?: string;
}

export interface IngestItemResult {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly actionId: string;
  readonly artifactId: string;
  readonly versionId: string;
  readonly replayed: boolean;
  /** For a Drive source: the id, the revision the bytes were read at, and the exporter. */
  readonly drive?: {
    readonly fileId: string;
    readonly revisionId: string;
    readonly exporter: string;
  };
}

export interface IngestResult {
  readonly mode: IngestMode;
  readonly classification: string;
  readonly organizationId: string;
  readonly items: readonly IngestItemResult[];
}

export class IngestCliError extends Error {
  readonly refusals?: readonly string[];

  constructor(message: string, refusals?: readonly string[]) {
    super(message);
    this.name = 'IngestCliError';
    if (refusals !== undefined) this.refusals = refusals;
  }
}

const OPTION_NAMES = new Set([
  'mode',
  'classification',
  'identity',
  'revision',
  'kind',
  'reference-manifest',
  'organization',
  'acting-role',
  'token-file',
  'reason',
  'drive',
  'export-mime',
]);

/** Parse only CLI shape. Policy validation remains in planIngest. */
export function parseIngestArgs(argv: readonly string[]): IngestCliArgs {
  const values: Record<string, string> = {};
  const paths: string[] = [];
  const driveRefs: string[] = [];
  let json = false;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (positionalOnly || !arg.startsWith('-')) {
      paths.push(arg);
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (arg === '--json') {
      if (json) throw new IngestCliError('duplicate option --json');
      json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new IngestCliError(usage());
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match === null) throw new IngestCliError(`unknown option ${arg}`);
    const name = match[1];
    if (name === undefined) throw new IngestCliError(`unknown option ${arg}`);
    if (!OPTION_NAMES.has(name)) {
      throw new IngestCliError(
        name === 'token' ? 'unknown option --token; use --token-file' : `unknown option --${name}`,
      );
    }
    const inline = match[2];
    const value = inline ?? argv[++index];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new IngestCliError(`option --${name} needs a non-empty value`);
    }
    if (name === 'drive') {
      driveRefs.push(value);
      continue;
    }
    if (values[name] !== undefined) throw new IngestCliError(`duplicate option --${name}`);
    values[name] = value;
  }

  const identity = values['identity'];
  if (identity !== undefined && identity !== 'dev' && identity !== 'oidc') {
    throw new IngestCliError(`unknown --identity ${identity}; expected dev or oidc`);
  }
  return {
    ...(values['mode'] === undefined ? {} : { mode: values['mode'] }),
    ...(values['classification'] === undefined ? {} : { classification: values['classification'] }),
    ...(identity === undefined ? {} : { identity }),
    ...(values['revision'] === undefined ? {} : { revisionLabel: values['revision'] }),
    ...(values['kind'] === undefined ? {} : { artifactKind: values['kind'] }),
    ...(values['reference-manifest'] === undefined
      ? {}
      : { referenceManifest: values['reference-manifest'] }),
    ...(values['organization'] === undefined ? {} : { organizationId: values['organization'] }),
    ...(values['acting-role'] === undefined ? {} : { actingRoleId: values['acting-role'] }),
    ...(values['token-file'] === undefined ? {} : { tokenFile: values['token-file'] }),
    ...(values['reason'] === undefined ? {} : { reason: values['reason'] }),
    ...(driveRefs.length === 0 ? {} : { driveRefs }),
    ...(values['export-mime'] === undefined ? {} : { exportMimeType: values['export-mime'] }),
    json,
    paths,
  };
}

function exactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.has(key)))
    throw new IngestCliError('reference manifest has unknown fields');
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new IngestCliError(`reference manifest entry needs ${key}`);
    }
  }
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IngestCliError(`reference manifest ${field} must be a non-empty string`);
  }
  return value;
}

/** Parse and bind exact external metadata to exact lexical CLI paths. */
export function parseReferenceManifest(
  text: string,
  paths: readonly string[],
  cwd = process.cwd(),
): ReadonlyMap<string, ReferenceManifestEntry> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new IngestCliError(
      `reference manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new IngestCliError('reference manifest must be an object with an entries array');
  }
  exactKeys(decoded, ['entries']);
  const entries = (decoded as { entries?: unknown }).entries;
  if (!Array.isArray(entries))
    throw new IngestCliError('reference manifest entries must be an array');
  const expected = new Set(paths.map((path) => resolve(cwd, path)));
  if (expected.size !== paths.length) {
    throw new IngestCliError('reference manifest entries must match CLI paths exactly');
  }
  const result = new Map<string, ReferenceManifestEntry>();
  for (const raw of entries) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new IngestCliError('reference manifest entries must be objects');
    }
    exactKeys(
      raw,
      ['path', 'source_system', 'authority', 'locator_system', 'external_id'],
      ['title', 'uri'],
    );
    const entry = raw as Record<string, unknown>;
    const parsed: ReferenceManifestEntry = {
      path: nonEmpty(entry['path'], 'path'),
      source_system: nonEmpty(entry['source_system'], 'source_system'),
      authority: nonEmpty(entry['authority'], 'authority'),
      locator_system: nonEmpty(entry['locator_system'], 'locator_system'),
      external_id: nonEmpty(entry['external_id'], 'external_id'),
      ...(entry['title'] === undefined ? {} : { title: nonEmpty(entry['title'], 'title') }),
      ...(entry['uri'] === undefined ? {} : { uri: nonEmpty(entry['uri'], 'uri') }),
    };
    const key = resolve(cwd, parsed.path);
    if (!expected.has(key) || result.has(key)) {
      throw new IngestCliError('reference manifest entries must match CLI paths exactly');
    }
    result.set(key, parsed);
  }
  if (result.size !== expected.size) {
    throw new IngestCliError('reference manifest entries must match CLI paths exactly');
  }
  return result;
}

interface ResolvedIdentity {
  readonly actorId: string;
  readonly actingRoleId: string;
  readonly organizationId: string;
}

interface IngestRuntimeDeps {
  readonly ownerPool?: Pool;
  readonly appPool?: Pool;
  readonly store?: ObjectStore;
  readonly parser?: DocumentParser;
  readonly executeInTransaction?: TransactionalActionDispatcher;
  readonly readFile?: (path: string) => Promise<Buffer>;
  /** Drive client (ADR 0022); defaults to a service-account client from KF_DRIVE_SERVICE_ACCOUNT_FILE. */
  readonly drive?: DriveClient;
  readonly stat?: (path: string) => Promise<{ isFile(): boolean }>;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') throw new IngestCliError(`${name} is required`);
  return value;
}

function validateIdentityArgs(args: IngestCliArgs): void {
  if (args.identity === undefined) {
    throw new IngestCliError('no --identity given. State dev or oidc explicitly');
  }
  if (args.identity === 'oidc') {
    if (args.tokenFile === undefined)
      throw new IngestCliError('oidc identity requires --token-file');
    if (args.organizationId === undefined) {
      throw new IngestCliError('oidc identity requires --organization');
    }
    if (args.actingRoleId === undefined) {
      throw new IngestCliError('oidc identity requires --acting-role');
    }
  }
}

function configuredStore(env: NodeJS.ProcessEnv): ObjectStore {
  const secret = loadSecret('S3_SECRET_ACCESS_KEY', env, {
    allowInline: env['NODE_ENV'] === 'development' || env['NODE_ENV'] === 'test',
  });
  return new S3ObjectStore({
    endpoint: requiredEnv(env, 'S3_ENDPOINT'),
    region: requiredEnv(env, 'S3_REGION'),
    accessKeyId: requiredEnv(env, 'S3_ACCESS_KEY_ID'),
    secretAccessKey: secret,
    bucket: requiredEnv(env, 'S3_BUCKET_ARTIFACTS'),
    forcePathStyle: env['S3_FORCE_PATH_STYLE'] !== 'false',
  });
}

/** Adapter required by document atoms; reference actions must never call it. */
function referenceOnlyStore(): ObjectStore {
  const refused = async (): Promise<never> => {
    throw new Error('object store access is forbidden for reference-mode ingest');
  };
  return {
    presignPut: refused,
    head: refused,
    read: refused,
    putIfAbsent: refused,
    put: refused,
  };
}

async function resolveIdentity(
  args: IngestCliArgs,
  classification: string,
  env: NodeJS.ProcessEnv,
  appPool: Pool,
): Promise<ResolvedIdentity> {
  validateIdentityArgs(args);
  if (args.identity === 'dev') {
    if (env['NODE_ENV'] !== 'development' || env['KF_ALLOW_FIXED_IDENTITY'] !== '1') {
      throw new IngestCliError(
        'dev identity requires NODE_ENV=development and KF_ALLOW_FIXED_IDENTITY=1',
      );
    }
    return {
      actorId: requiredEnv(env, 'KF_DEV_ACTOR'),
      actingRoleId: requiredEnv(env, 'KF_DEV_ACTING_ROLE'),
      organizationId: requiredEnv(env, 'KF_DEV_ORGANIZATION'),
    };
  }

  const tokenFile = args.tokenFile;
  if (tokenFile === undefined) throw new IngestCliError('oidc identity requires --token-file');
  const organizationId = args.organizationId;
  if (organizationId === undefined)
    throw new IngestCliError('oidc identity requires --organization');
  const actingRoleId = args.actingRoleId;
  if (actingRoleId === undefined) throw new IngestCliError('oidc identity requires --acting-role');
  const config: IdentityConfig = {
    issuer: requiredEnv(env, 'OIDC_ISSUER'),
    audience: requiredEnv(env, 'OIDC_AUDIENCE'),
    jwksUri: requiredEnv(env, 'OIDC_JWKS_URI'),
  };
  const token = readSecretFile(tokenFile, 'OIDC token file');
  const caller: Caller = await resolveCaller(appPool, new TokenVerifier(config), {
    token,
    actingRoleId,
    organizationId,
    maxClassification: classification,
  });
  return {
    actorId: caller.actorId,
    actingRoleId: caller.actingRoleId,
    organizationId: caller.organizationId,
  };
}

async function assertClearance(
  owner: Pool,
  identity: ResolvedIdentity,
  classification: string,
): Promise<void> {
  await withTransaction(owner, async (tx) => {
    const decision = await setResolvedAccessContext(tx, {
      subjectId: identity.actorId,
      assignmentId: identity.actingRoleId,
      organizationId: identity.organizationId,
      requestedClassification: classification,
    });
    if (decision !== classification) {
      throw new IngestCliError(
        `classification resolver returned ${decision}, not requested ${classification}`,
      );
    }
  });
}

function actionPayload(
  mode: IngestMode,
  item: { readonly path: string; readonly artifactKind: string; readonly mediaType: string },
  bytes: Buffer,
  revisionLabel: string | undefined,
  reference: ReferenceManifestEntry | undefined,
  storeKey: string | undefined,
  organizationId: string,
  drive?: DriveFetched,
): Readonly<Record<string, JsonValue>> {
  if (mode === 'reference') {
    if (reference === undefined) throw new IngestCliError(`no manifest entry for ${item.path}`);
    return {
      title: reference.title ?? basename(item.path),
      artifact_kind: item.artifactKind,
      source_system: reference.source_system,
      revision_label: revisionLabel!,
      authority: reference.authority,
      sha256: digestBytes(bytes),
      size_bytes: bytes.length,
      media_type: item.mediaType,
      locator_system: reference.locator_system,
      external_id: reference.external_id,
      ...(reference.uri === undefined ? {} : { uri: reference.uri }),
    };
  }
  if (storeKey === undefined) throw new IngestCliError(`no storage key for ${item.path}`);
  return {
    title: drive === undefined ? basename(item.path) : drive.name,
    artifact_kind: item.artifactKind,
    sha256: digestBytes(bytes),
    size_bytes: bytes.length,
    media_type: item.mediaType,
    storage_uri: storeKey,
    ...(revisionLabel === undefined ? {} : { revision_label: revisionLabel }),
    ...(drive === undefined
      ? {}
      : {
          // ADR 0022: Drive holds the source; we hold a copy read at exactly this revision,
          // produced by exactly this exporter. Both are recorded on the act.
          source_locator: {
            system: 'google-drive',
            external_id: `${drive.fileId}@${drive.revisionId}`,
            authority: 'authoritative',
            ...(drive.webViewLink === undefined ? {} : { uri: drive.webViewLink }),
          },
          exporter: drive.exporter,
          source_media_type: drive.sourceMimeType,
          source_modified_at: drive.modifiedTime,
        }),
    // Kept in payload so idempotency digest remains bound to organization even if a caller
    // accidentally reuses a path and digest across tenants.
    organization_id: organizationId,
  };
}

async function versionForAction(tx: Tx, artifactId: string, actionId: string): Promise<string> {
  return (
    await tx.one<{ id: string }>(
      `select id from content.artifact_version
        where artifact_id = $1 and created_by_action = $2
        order by version_no desc limit 1`,
      [artifactId, actionId],
    )
  ).id;
}

/** Execute one complete ingest batch. Dependencies are injectable for seam tests. */
export async function runIngest(
  args: IngestCliArgs,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  deps: IngestRuntimeDeps = {},
): Promise<IngestResult> {
  const planned: IngestPlan = planIngest({
    paths: args.paths,
    ...(args.mode === undefined ? {} : { mode: args.mode }),
    ...(args.classification === undefined ? {} : { classification: args.classification }),
    ...(args.artifactKind === undefined ? {} : { artifactKind: args.artifactKind }),
    ...(args.revisionLabel === undefined ? {} : { revisionLabel: args.revisionLabel }),
    ...(args.driveRefs === undefined ? {} : { driveRefs: args.driveRefs }),
  });
  if (!planned.ok) throw new IngestCliError(planned.refusals.join('\n'), planned.refusals);
  const classification = planned.classification;

  if (planned.mode === 'reference' && args.referenceManifest === undefined) {
    throw new IngestCliError('reference mode requires --reference-manifest');
  }
  if (planned.mode === 'copy' && args.referenceManifest !== undefined) {
    throw new IngestCliError('--reference-manifest is only valid in reference mode');
  }
  validateIdentityArgs(args);

  const read = deps.readFile ?? (async (path: string) => readFile(path));
  const stat = deps.stat ?? (async (path: string) => lstat(path));
  const manifest =
    planned.mode === 'reference'
      ? parseReferenceManifest(
          (await read(resolve(cwd, args.referenceManifest!))).toString('utf8'),
          args.paths,
          cwd,
        )
      : undefined;

  const owner =
    deps.ownerPool ??
    createPool({
      connectionString: loadSecret('DATABASE_OWNER_URL', env, {
        allowInline: env['NODE_ENV'] === 'development' || env['NODE_ENV'] === 'test',
      }),
      maxConnections: 2,
    });
  let app: Pool | undefined = deps.appPool;
  const ownsOwner = deps.ownerPool === undefined;
  let ownsApp = false;
  try {
    if (app === undefined) {
      app = createPool({
        connectionString: loadSecret('DATABASE_URL', env, {
          allowInline: env['NODE_ENV'] === 'development' || env['NODE_ENV'] === 'test',
        }),
        maxConnections: 4,
      });
      ownsApp = true;
    }
    const identity = await resolveIdentity(args, classification, env, app);
    await assertClearance(owner, identity, classification);

    const staged: Array<{
      readonly item: (typeof planned.items)[number];
      readonly bytes: Buffer;
      readonly sha256: string;
      readonly storeKey?: string;
      readonly reference?: ReferenceManifestEntry;
      readonly drive?: DriveFetched;
    }> = [];
    const drive =
      deps.drive ??
      (planned.items.some((i) => i.drive !== undefined) ? driveClientFromEnv(env) : undefined);
    for (const item of planned.items) {
      if (item.drive !== undefined) {
        if (drive === undefined) {
          throw new IngestCliError(
            'a Drive source needs KF_DRIVE_SERVICE_ACCOUNT_FILE (a permission-checked service-account key)',
          );
        }
        const fetched = await drive.fetch(item.drive.fileId, {
          ...(item.drive.revisionId === undefined ? {} : { revisionId: item.drive.revisionId }),
          ...(args.exportMimeType === undefined ? {} : { exportMimeType: args.exportMimeType }),
        });
        if (fetched.bytes.length === 0) {
          throw new IngestCliError(`Drive source is empty: ${item.path}`);
        }
        const sha256 = digestBytes(fetched.bytes);
        staged.push({
          item: { ...item, mediaType: fetched.mediaType },
          bytes: fetched.bytes,
          sha256,
          storeKey: `ingest/${identity.organizationId}/${sha256}`,
          drive: fetched,
        });
        continue;
      }
      const absolutePath = resolve(cwd, item.path);
      if (!(await stat(absolutePath)).isFile()) {
        throw new IngestCliError(`ingest path is not a regular file: ${item.path}`);
      }
      const bytes = await read(absolutePath);
      if (bytes.length === 0) throw new IngestCliError(`ingest path is empty: ${item.path}`);
      const sha256 = digestBytes(bytes);
      const storeKey =
        planned.mode === 'copy' ? `ingest/${identity.organizationId}/${sha256}` : undefined;
      const reference = manifest?.get(absolutePath);
      if (planned.mode === 'reference' && reference === undefined) {
        throw new IngestCliError(`no manifest entry for ${item.path}`);
      }
      staged.push({
        item,
        bytes,
        sha256,
        ...(storeKey === undefined ? {} : { storeKey }),
        ...(reference === undefined ? {} : { reference }),
      });
    }

    const store =
      deps.store ?? (planned.mode === 'copy' ? configuredStore(env) : referenceOnlyStore());
    const parser = deps.parser ?? new PandocDocumentParser();
    const execute =
      deps.executeInTransaction ??
      createFabricTransactionalDispatcher(createDocumentActionAtoms({ store, parser }));
    if (app === undefined) throw new IngestCliError('application database pool was not created');
    const items = await withTransaction(app, async (tx) => {
      const results: IngestItemResult[] = [];
      for (const source of staged) {
        if (planned.mode === 'copy') {
          const uploaded = await store.putIfAbsent(
            source.storeKey!,
            source.bytes,
            source.item.mediaType,
          );
          await verifyUpload(store, {
            key: source.storeKey!,
            claimedSha256: source.sha256,
            claimedSizeBytes: source.bytes.length,
          });
          if (uploaded.versionId === undefined) {
            throw new IngestCliError(
              `object store returned no immutable version for ${source.item.path}`,
            );
          }
        }
        const reference = source.reference;
        const payload = actionPayload(
          planned.mode,
          source.item,
          source.bytes,
          source.drive === undefined ? args.revisionLabel : source.drive.revisionId,
          reference,
          source.storeKey,
          identity.organizationId,
          source.drive,
        );
        const idempotencyKey = `kf-ingest-v1-${digest({
          mode: planned.mode,
          organization_id: identity.organizationId,
          path: resolve(cwd, source.item.path),
          sha256: source.sha256,
          payload,
        })}`;
        const action: ActionResult = await execute(tx, {
          actionType: planned.mode === 'copy' ? 'attach_evidence' : 'register_external_artifact',
          actorId: identity.actorId,
          actingRoleId: identity.actingRoleId,
          targetIds: [],
          payload,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
          idempotencyKey,
          organizationId: identity.organizationId,
          maxClassification: classification,
        });
        const artifactId = action.objectIds[0];
        if (artifactId === undefined)
          throw new IngestCliError(`action returned no artifact for ${source.item.path}`);
        results.push({
          path: source.item.path,
          sha256: source.sha256,
          sizeBytes: source.bytes.length,
          actionId: action.actionId,
          artifactId,
          versionId: await versionForAction(tx, artifactId, action.actionId),
          replayed: action.replayed,
          ...(source.drive === undefined
            ? {}
            : {
                drive: {
                  fileId: source.drive.fileId,
                  revisionId: source.drive.revisionId,
                  exporter: source.drive.exporter,
                },
              }),
        });
      }
      return results;
    });
    return {
      mode: planned.mode,
      classification,
      organizationId: identity.organizationId,
      items,
    };
  } finally {
    if (ownsApp) await app?.end();
    if (ownsOwner) await owner.end();
  }
}

export function formatIngestResult(result: IngestResult, json: boolean): string {
  if (json) return `${JSON.stringify(result)}\n`;
  const lines = [`ingested ${String(result.items.length)} item(s) in ${result.mode} mode`];
  for (const item of result.items) {
    lines.push(`${item.path}\t${item.artifactId}\t${item.versionId}\t${item.sha256}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runIngestCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  try {
    const args = parseIngestArgs(argv);
    const result = await runIngest(args, env);
    output.write(formatIngestResult(result, args.json));
    return 0;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail === usage()) {
      output.write(`${detail}\n`);
      return 0;
    }
    errorOutput.write(`${detail}\n`);
    return 1;
  }
}

export function usage(): string {
  return (
    'kf ingest --mode=copy|reference --classification=<id> --identity=dev|oidc ' +
    '[--revision=<label>] [--kind=<artifact-kind>] [--reference-manifest=<file>] ' +
    '[--organization=<uuid> --acting-role=<uuid> --token-file=<file>] [--reason=<text>] ' +
    '[--json] <paths...>'
  );
}
