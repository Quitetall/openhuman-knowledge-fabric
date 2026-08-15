/**
 * Document composition.
 *
 * Source bytes remain one immutable artifact version. Parsing produces ordered atoms with
 * independent digests; those atoms are disposable projections rebuildable from source bytes.
 */

export * from './compiler.js';
export * from './lamquant-compat.js';
export * from './liminal-adapter.js';

import { spawn } from 'node:child_process';
import {
  ActionRejected,
  type ActionEffect,
  type ActionMaterializer,
  type ActionRequest,
  type ObjectRow,
  type PreconditionCheck,
} from '@kf/actions';
import { recordVersion, verifyUpload, type ObjectStore, type VerifiedUpload } from '@kf/artifacts';
import { digest, type JsonValue } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import {
  createControlledObject,
  optionalString,
  requireInteger,
  requireString,
} from '@kf/record-atoms';
import {
  createAuthoredFragmentRevision,
  createCompilationBasis,
  createCompositionRevision,
  createProposalOverlay,
  type CompilationBasis,
  type CompilationBasisInput,
  type CompositionInput,
  type DocumentClassification,
  type SourceHolder,
} from './compiler.js';

export type DocumentAtomKind =
  'heading' | 'paragraph' | 'list_item' | 'quote' | 'code' | 'table' | 'horizontal_rule';

export interface DocumentAtom {
  readonly ordinal: number;
  readonly kind: DocumentAtomKind;
  readonly level: number | null;
  readonly text: string;
  readonly attributes: Readonly<Record<string, JsonValue>>;
  readonly digest: string;
}

export interface ParsedDocument {
  readonly parser: string;
  readonly parserVersion: string;
  readonly atoms: readonly DocumentAtom[];
  readonly contentDigest: string;
}

export interface DocumentParser {
  parse(bytes: Buffer, mediaType: string): Promise<ParsedDocument | undefined>;
}

interface PandocNode {
  readonly t?: unknown;
  readonly c?: unknown;
}

interface PandocDocument {
  readonly 'pandoc-api-version'?: unknown;
  readonly blocks?: unknown;
}

function node(value: unknown): PandocNode | undefined {
  return typeof value === 'object' && value !== null ? (value as PandocNode) : undefined;
}

function inlineText(value: unknown): string {
  if (Array.isArray(value)) return value.map(inlineText).join('');
  const item = node(value);
  if (item === undefined || typeof item.t !== 'string') return '';
  if (item.t === 'Space' || item.t === 'SoftBreak') return ' ';
  if (item.t === 'LineBreak') return '\n';
  if (item.t === 'Str' && typeof item.c === 'string') return item.c;
  if ((item.t === 'Code' || item.t === 'Math') && Array.isArray(item.c)) {
    const text = item.c.at(-1);
    return typeof text === 'string' ? text : '';
  }
  if (item.t === 'RawInline' && Array.isArray(item.c)) {
    return typeof item.c[1] === 'string' ? item.c[1] : '';
  }
  if (Array.isArray(item.c)) return inlineText(item.c);
  return typeof item.c === 'string' ? item.c : '';
}

function normalized(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function blockText(value: unknown): string {
  if (Array.isArray(value)) return normalized(value.map(blockText).filter(Boolean).join(' '));
  const item = node(value);
  if (item === undefined) return '';
  if (item.t === 'Para' || item.t === 'Plain' || item.t === 'Header') {
    const content = item.t === 'Header' && Array.isArray(item.c) ? item.c[2] : item.c;
    return normalized(inlineText(content));
  }
  if (item.t === 'CodeBlock' && Array.isArray(item.c)) {
    return typeof item.c[1] === 'string' ? item.c[1] : '';
  }
  return Array.isArray(item.c) ? blockText(item.c) : normalized(inlineText(item.c));
}

function createAtom(
  atoms: DocumentAtom[],
  kind: DocumentAtomKind,
  text: string,
  level: number | null = null,
  attributes: Readonly<Record<string, JsonValue>> = {},
): void {
  const ordinal = atoms.length + 1;
  const claim = { ordinal, kind, level, text: normalized(text), attributes };
  atoms.push({ ...claim, digest: digest(claim) });
}

function walkBlocks(blocks: unknown, atoms: DocumentAtom[], listDepth = 0): void {
  if (!Array.isArray(blocks)) return;
  for (const raw of blocks) {
    const block = node(raw);
    if (block === undefined || typeof block.t !== 'string') continue;
    if (block.t === 'Header' && Array.isArray(block.c)) {
      createAtom(
        atoms,
        'heading',
        inlineText(block.c[2]),
        typeof block.c[0] === 'number' ? block.c[0] : 1,
      );
    } else if (block.t === 'Para' || block.t === 'Plain') {
      createAtom(atoms, 'paragraph', inlineText(block.c));
    } else if (block.t === 'BulletList' && Array.isArray(block.c)) {
      for (const item of block.c) {
        createAtom(atoms, 'list_item', blockText(item), listDepth + 1, { list: 'bullet' });
      }
    } else if (block.t === 'OrderedList' && Array.isArray(block.c)) {
      const items = Array.isArray(block.c[1]) ? block.c[1] : [];
      let order = 1;
      for (const item of items) {
        createAtom(atoms, 'list_item', blockText(item), listDepth + 1, {
          list: 'ordered',
          order: order++,
        });
      }
    } else if (block.t === 'BlockQuote') {
      createAtom(atoms, 'quote', blockText(block.c));
    } else if (block.t === 'CodeBlock') {
      createAtom(atoms, 'code', blockText(block));
    } else if (block.t === 'Table') {
      createAtom(atoms, 'table', blockText(block.c), null, { source: 'pandoc-table' });
    } else if (block.t === 'HorizontalRule') {
      createAtom(atoms, 'horizontal_rule', '');
    } else if (block.t === 'Div' && Array.isArray(block.c)) {
      walkBlocks(block.c[1], atoms, listDepth);
    } else if (block.t === 'Figure' && Array.isArray(block.c)) {
      // Pandoc Figure is [Attr, Caption, Blocks]. Body is explicit index 2; caption is
      // metadata around it and should not replace the document content being composed.
      walkBlocks(block.c[2], atoms, listDepth);
    } else if (block.t === 'RawBlock') {
      const text = blockText(block);
      if (text !== '') createAtom(atoms, 'paragraph', text, null, { source: 'raw-block' });
    }
  }
}

export function atomsFromPandoc(document: PandocDocument): DocumentAtom[] {
  const atoms: DocumentAtom[] = [];
  walkBlocks(document.blocks, atoms);
  return atoms;
}

const PANDOC_FORMATS: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'text/markdown': 'gfm',
  'text/plain': 'markdown',
};

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
};

/** Browser MIME detection is inconsistent for Markdown/text; extension provides safe fallback. */
export function mediaTypeForDocumentFile(
  fileName: string,
  declaredMediaType?: string,
): string | undefined {
  const extension = /\.([^.]+)$/.exec(fileName)?.[1]?.toLowerCase();
  const fromExtension = extension === undefined ? undefined : EXTENSION_MEDIA_TYPES[extension];
  if (fromExtension !== undefined) return fromExtension;
  return declaredMediaType !== undefined && PANDOC_FORMATS[declaredMediaType] !== undefined
    ? declaredMediaType
    : undefined;
}

/** Map controlled-document semantics onto evidence-vault artifact vocabulary. */
export function artifactKindForDocumentClass(documentClass: string): string {
  if (documentClass === 'specification') return 'specification';
  if (documentClass === 'report') return 'report';
  return 'other';
}

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PANDOC_JSON_BYTES = 64 * 1024 * 1024;

async function pandocJson(bytes: Buffer, format: string): Promise<PandocDocument> {
  return new Promise((resolve, reject) => {
    const child = spawn('pandoc', [`--from=${format}`, '--to=json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PANDOC_JSON_BYTES) {
        child.kill('SIGKILL');
        reject(new Error('pandoc output exceeded 64 MiB safety limit'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `pandoc exited ${String(code)}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as PandocDocument);
      } catch (error: unknown) {
        reject(new Error('pandoc returned invalid JSON', { cause: error }));
      }
    });
    child.stdin.end(bytes);
  });
}

export class PandocDocumentParser implements DocumentParser {
  async parse(bytes: Buffer, mediaType: string): Promise<ParsedDocument | undefined> {
    const format = PANDOC_FORMATS[mediaType];
    if (format === undefined) return undefined;
    if (bytes.length === 0) throw new Error('document source is empty');
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('document source exceeds 20 MiB limit');
    const document = await pandocJson(bytes, format);
    const atoms = atomsFromPandoc(document);
    const apiVersion = Array.isArray(document['pandoc-api-version'])
      ? document['pandoc-api-version'].join('.')
      : 'unknown';
    const claims = atoms.map(({ digest: _digest, ...claim }) => claim);
    return {
      parser: 'pandoc',
      parserVersion: apiVersion,
      atoms,
      contentDigest: digest(claims),
    };
  }
}

function requireSha256(payload: Readonly<Record<string, unknown>> | undefined): string {
  const value = requireString(payload, 'sha256');
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('sha256 must be lowercase hexadecimal');
  return value;
}

export interface DocumentActionAtoms {
  readonly name: string;
  readonly materializers: Readonly<Record<string, ActionMaterializer>>;
  readonly effects: Readonly<Record<string, ActionEffect>>;
  readonly preconditions: Readonly<Record<string, PreconditionCheck>>;
}

export const DOCUMENT_ACTION_IDS = [
  'add_authored_fragment',
  'revise_authored_fragment',
  'retire_authored_fragment',
  'add_document_composition',
  'revise_document_composition',
  'change_document_source_holder',
  'request_document_compilation',
  'accept_document_compilation',
  'publish_document_view',
  'record_document_proposal',
  'apply_document_proposal',
] as const;

const DOCUMENT_AUTHOR_ROLES = new Set([
  'performer',
  'technical_authority',
  'design_authority',
  'quality_authority',
]);
const TECHNICAL_AUTHORITY_ROLE = new Set(['technical_authority']);

function refuseDocumentAuthority(
  rule: string,
  message: string,
  detail: Readonly<Record<string, unknown>>,
): never {
  throw new ActionRejected('actor_not_authorized', `${rule}: ${message}`, { rule, ...detail });
}

async function assertDocumentRole(
  tx: Tx,
  request: ActionRequest,
  objects: readonly ObjectRow[],
  allowedRoles: ReadonlySet<string>,
): Promise<void> {
  const assignment = await tx.maybeOne<{ role_id: string; scope_id: string }>(
    `select role_id, scope_id
       from org.role_assignment
      where id = $1 and subject_id = $2
        and valid_from <= now() and (valid_to is null or valid_to > now())`,
    [request.actingRoleId, request.actorId],
  );
  if (assignment === undefined || !allowedRoles.has(assignment.role_id)) {
    refuseDocumentAuthority(
      'KF-DOC-AUTH-001',
      `${request.actionType} requires an allowed document role`,
      { actionType: request.actionType, allowedRoles: [...allowedRoles] },
    );
  }
  const permittedScopes = new Set([request.organizationId, ...objects.map((object) => object.id)]);
  if (!permittedScopes.has(assignment.scope_id)) {
    refuseDocumentAuthority(
      'KF-DOC-AUTH-002',
      'document authority must be scoped to the target or its organization',
      { actionType: request.actionType, scopeId: assignment.scope_id },
    );
  }
}

function requireDocumentPolicy(request: ActionRequest): 'ordinary' | 'controlled' | 'regulated' {
  const policy = request.payload?.['document_policy'];
  if (policy !== 'ordinary' && policy !== 'controlled' && policy !== 'regulated') {
    throw new ActionRejected(
      'precondition_failed',
      'KF-DOC-POLICY-001: document_policy must be ordinary, controlled, or regulated',
      { rule: 'KF-DOC-POLICY-001', actionType: request.actionType },
    );
  }
  return policy;
}

async function assertQualityAuthorityWhenRequired(
  tx: Tx,
  request: ActionRequest,
  objects: readonly ObjectRow[],
  policy: 'ordinary' | 'controlled' | 'regulated',
): Promise<void> {
  if (policy === 'ordinary') return;
  const qualityRoleAssignmentId = request.payload?.['quality_role_assignment_id'];
  const assignment =
    typeof qualityRoleAssignmentId === 'string'
      ? await tx.maybeOne<{ role_id: string; scope_id: string }>(
          `select role_id, scope_id
             from org.role_assignment
            where id = $1 and subject_id = $2
              and valid_from <= now() and (valid_to is null or valid_to > now())`,
          [qualityRoleAssignmentId, request.actorId],
        )
      : undefined;
  if (assignment?.role_id !== 'quality_authority') {
    refuseDocumentAuthority(
      'KF-DOC-AUTH-003',
      `${policy} document policy also requires an active quality_authority assignment`,
      { actionType: request.actionType },
    );
  }
  const permittedScopes = new Set([request.organizationId, ...objects.map((object) => object.id)]);
  if (!permittedScopes.has(assignment.scope_id)) {
    refuseDocumentAuthority(
      'KF-DOC-AUTH-002',
      'quality authority must be scoped to the target or its organization',
      { actionType: request.actionType, scopeId: assignment.scope_id },
    );
  }
}

async function subjectDocumentPolicy(
  tx: Tx,
  objectId: string,
): Promise<'ordinary' | 'controlled' | 'regulated'> {
  const row = await tx.one<{ document_policy: 'ordinary' | 'controlled' | 'regulated' }>(
    `select s.document_policy
       from content.document_subject s
       join core.object o on o.id = s.object_id
      where o.id = $1`,
    [objectId],
  );
  return row.document_policy;
}

const assertDocumentAuthor: PreconditionCheck = async (tx, request, objects) => {
  await assertDocumentRole(tx, request, objects, DOCUMENT_AUTHOR_ROLES);
};

const assertTechnicalDocumentAuthority: PreconditionCheck = async (tx, request, objects) => {
  await assertDocumentRole(tx, request, objects, TECHNICAL_AUTHORITY_ROLE);
  const object = objects[0];
  if (object !== undefined) {
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await subjectDocumentPolicy(tx, object.id),
    );
  }
};

function refuseDocument(
  rule: string,
  message: string,
  detail: Readonly<Record<string, unknown>> = {},
): never {
  throw new ActionRejected('precondition_failed', `${rule}: ${message}`, { rule, ...detail });
}

function requireRecord(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = payload?.[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} is required and must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireArray(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly unknown[] {
  const value = payload?.[key];
  if (!Array.isArray(value)) throw new Error(`${key} is required and must be an array`);
  return value;
}

function requireDigest(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const value = requireString(payload, key);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${key} must be a lowercase hexadecimal SHA-256 digest`);
  }
  return value;
}

function requireCommit(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const value = requireString(payload, key);
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${key} must be a full lowercase hexadecimal Git commit`);
  }
  return value;
}

function sourceHolderFromPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
  subjectId: string,
): SourceHolder {
  const holder = requireRecord(payload, 'holder');
  const kind = requireString(holder, 'kind');
  const contentDigest = requireDigest(holder, 'content_digest');
  if (kind === 'fabric_native') {
    return {
      kind,
      subjectId,
      artifactVersionId: requireString(holder, 'artifact_version_id'),
      contentDigest,
    };
  }
  if (kind === 'git') {
    const submoduleCommitSha = optionalString(holder, 'submodule_commit_sha');
    if (submoduleCommitSha !== null && !/^[0-9a-f]{40}$/.test(submoduleCommitSha)) {
      throw new Error('holder.submodule_commit_sha must be a full lowercase Git commit');
    }
    return {
      kind,
      subjectId,
      repository: requireString(holder, 'repository'),
      commitSha: requireCommit(holder, 'commit_sha'),
      path: requireString(holder, 'path'),
      submoduleCommitSha,
      contentDigest,
    };
  }
  if (kind === 'external') {
    return {
      kind,
      subjectId,
      authority: requireString(holder, 'authority'),
      revision: requireString(holder, 'revision'),
      contentDigest,
    };
  }
  throw new Error('holder.kind must be fabric_native, git, or external');
}

async function insertSourceHolder(
  tx: Tx,
  input: {
    readonly id: string;
    readonly subjectId: string;
    readonly previousHolderId: string | null;
    readonly holder: SourceHolder;
    readonly conversionLoss: readonly unknown[];
    readonly migrationReason: string | null;
    readonly reversibleMigrationPlan: string | null;
    readonly actorId: string;
    readonly actionId: string;
  },
): Promise<void> {
  await tx.query(
    `insert into content.document_source_holder
       (id, subject_id, previous_holder_id, holder_kind, fabric_artifact_version_id,
        git_repository, git_commit_sha, git_path, git_submodule_commit_sha,
        external_authority, external_revision, content_digest, conversion_loss,
        migration_reason, reversible_migration_plan, recorded_by, recorded_by_action)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      input.id,
      input.subjectId,
      input.previousHolderId,
      input.holder.kind,
      input.holder.kind === 'fabric_native' ? input.holder.artifactVersionId : null,
      input.holder.kind === 'git' ? input.holder.repository : null,
      input.holder.kind === 'git' ? input.holder.commitSha : null,
      input.holder.kind === 'git' ? input.holder.path : null,
      input.holder.kind === 'git' ? input.holder.submoduleCommitSha : null,
      input.holder.kind === 'external' ? input.holder.authority : null,
      input.holder.kind === 'external' ? input.holder.revision : null,
      input.holder.contentDigest,
      JSON.stringify(input.conversionLoss),
      input.migrationReason,
      input.reversibleMigrationPlan,
      input.actorId,
      input.actionId,
    ],
  );
}

interface HolderRow extends Record<string, unknown> {
  readonly subject_id: string;
  readonly holder_id: string;
  readonly holder_kind: 'fabric_native' | 'git' | 'external';
  readonly fabric_artifact_version_id: string | null;
  readonly git_repository: string | null;
  readonly git_commit_sha: string | null;
  readonly git_path: string | null;
  readonly git_submodule_commit_sha: string | null;
  readonly external_authority: string | null;
  readonly external_revision: string | null;
  readonly content_digest: string;
}

function sourceHolderFromRow(row: HolderRow): SourceHolder {
  if (row.holder_kind === 'fabric_native' && row.fabric_artifact_version_id !== null) {
    return {
      kind: row.holder_kind,
      subjectId: row.subject_id,
      artifactVersionId: row.fabric_artifact_version_id,
      contentDigest: row.content_digest,
    };
  }
  if (
    row.holder_kind === 'git' &&
    row.git_repository !== null &&
    row.git_commit_sha !== null &&
    row.git_path !== null
  ) {
    return {
      kind: row.holder_kind,
      subjectId: row.subject_id,
      repository: row.git_repository,
      commitSha: row.git_commit_sha,
      path: row.git_path,
      submoduleCommitSha: row.git_submodule_commit_sha,
      contentDigest: row.content_digest,
    };
  }
  if (
    row.holder_kind === 'external' &&
    row.external_authority !== null &&
    row.external_revision !== null
  ) {
    return {
      kind: row.holder_kind,
      subjectId: row.subject_id,
      authority: row.external_authority,
      revision: row.external_revision,
      contentDigest: row.content_digest,
    };
  }
  return refuseDocument('KF-DOC-001', 'stored Source Holder is incomplete', {
    subjectId: row.subject_id,
    holderId: row.holder_id,
  });
}

async function currentHolder(tx: Tx, objectId: string): Promise<HolderRow> {
  const row = await tx.maybeOne<HolderRow>(
    `select s.id as subject_id, h.id as holder_id, h.holder_kind,
            h.fabric_artifact_version_id, h.git_repository, h.git_commit_sha, h.git_path,
            h.git_submodule_commit_sha, h.external_authority, h.external_revision,
            h.content_digest
       from content.document_subject s
       join content.document_source_holder h on h.id = s.current_holder_id
      where s.object_id = $1`,
    [objectId],
  );
  if (row === undefined) {
    return refuseDocument('KF-DOC-001', 'document target has no visible current Source Holder', {
      objectId,
    });
  }
  return row;
}

async function assertSameSourceAuthority(
  tx: Tx,
  current: HolderRow,
  proposed: SourceHolder,
  classification: DocumentClassification,
): Promise<void> {
  if (current.holder_kind !== proposed.kind) {
    refuseDocument(
      'KF-DOC-HOLDER-001',
      'source revision cannot change Holder kind; use change_document_source_holder',
    );
  }
  if (proposed.kind === 'git') {
    if (current.git_repository !== proposed.repository || current.git_path !== proposed.path) {
      refuseDocument(
        'KF-DOC-HOLDER-002',
        'Git source revision must retain repository and path authority',
      );
    }
    return;
  }
  if (proposed.kind === 'external') {
    if (current.external_authority !== proposed.authority) {
      refuseDocument(
        'KF-DOC-HOLDER-003',
        'external source revision must retain its named authority',
      );
    }
    return;
  }
  const authority = await tx.maybeOne<{
    artifact_organization_id: string;
    artifact_classification: string;
    subject_organization_id: string;
  }>(
    `select artifact_object.organization_id as artifact_organization_id,
            artifact_object.classification as artifact_classification,
            subject_object.organization_id as subject_organization_id
       from content.artifact_version proposed
       join core.object artifact_object on artifact_object.id = proposed.artifact_id
       join content.document_subject subject on subject.id = $1
       join core.object subject_object on subject_object.id = subject.object_id
      where proposed.id = $2 and proposed.sha256 = $3`,
    [current.subject_id, proposed.artifactVersionId, proposed.contentDigest],
  );
  if (
    authority === undefined ||
    authority.artifact_organization_id !== authority.subject_organization_id
  ) {
    refuseDocument(
      'KF-DOC-HOLDER-004',
      'fabric-native source revision must name exact KF bytes in the subject organization',
    );
  }
  if (classificationRank(classification) < classificationRank(authority.artifact_classification)) {
    refuseDocument(
      'KF-DOC-HOLDER-007',
      'document revision classification cannot be below its fabric-native source artifact',
    );
  }
}

async function assertRevisionHolder(
  tx: Tx,
  payload: Readonly<Record<string, unknown>> | undefined,
  objectId: string,
): Promise<void> {
  const current = await currentHolder(tx, objectId);
  if (current.holder_id !== requireString(payload, 'previous_holder_id')) {
    refuseDocument('KF-DOC-HOLDER-005', 'source revision must name the current exact Holder', {
      objectId,
      currentHolderId: current.holder_id,
    });
  }
  if (requireString(payload, 'holder_id') === current.holder_id) {
    refuseDocument('KF-DOC-HOLDER-006', 'source revision requires a new Holder snapshot id', {
      objectId,
    });
  }
  await assertSameSourceAuthority(
    tx,
    current,
    sourceHolderFromPayload(payload, current.subject_id),
    requireDocumentClassification(payload),
  );
}

async function appendRevisionHolder(
  tx: Tx,
  request: ActionRequest,
  objectId: string,
  actionId: string,
  payload: Readonly<Record<string, unknown>> | undefined = request.payload,
): Promise<HolderRow> {
  const current = await currentHolder(tx, objectId);
  const holderId = requireString(payload, 'holder_id');
  await insertSourceHolder(tx, {
    id: holderId,
    subjectId: current.subject_id,
    previousHolderId: current.holder_id,
    holder: sourceHolderFromPayload(payload, current.subject_id),
    conversionLoss: [],
    migrationReason: null,
    reversibleMigrationPlan: null,
    actorId: request.actorId,
    actionId,
  });
  await tx.query(
    'update content.document_subject set current_holder_id = $2 where object_id = $1',
    [objectId, holderId],
  );
  return currentHolder(tx, objectId);
}

function requireDocumentTarget(
  objects: readonly ObjectRow[],
  allowedTypes: ReadonlySet<string>,
  actionType: string,
): ObjectRow {
  if (objects.length !== 1 || !allowedTypes.has(objects[0]!.object_type)) {
    return refuseDocument(
      'KF-DOC-TARGET-001',
      `${actionType} requires exactly one document target`,
      {
        allowedTypes: [...allowedTypes],
        actualTypes: objects.map((object) => object.object_type),
      },
    );
  }
  return objects[0]!;
}

const FRAGMENT_TARGET = new Set(['authored_fragment']);
const COMPOSITION_TARGET = new Set(['document_composition']);
const DOCUMENT_TARGET = new Set(['authored_fragment', 'document_composition']);

const CLASSIFICATION_RANK: Readonly<Record<DocumentClassification, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function documentClassification(value: string, field = 'classification'): DocumentClassification {
  if (Object.hasOwn(CLASSIFICATION_RANK, value)) return value as DocumentClassification;
  throw new Error(`${field} must be public, internal, confidential, or restricted`);
}

function requireDocumentClassification(
  payload: Readonly<Record<string, unknown>> | undefined,
  key = 'classification',
): DocumentClassification {
  return documentClassification(requireString(payload, key), key);
}

function classificationRank(value: string): number {
  return CLASSIFICATION_RANK[documentClassification(value)];
}

async function assertClassificationMayAdvance(
  tx: Tx,
  objectId: string,
  classification: DocumentClassification,
): Promise<void> {
  const row = await tx.one<{ classification: string }>(
    'select classification from core.object where id = $1',
    [objectId],
  );
  if (classificationRank(classification) < classificationRank(row.classification)) {
    refuseDocument('KF-DOC-CLASS-001', 'document classification cannot be lowered by revision', {
      objectId,
      current: row.classification,
      requested: classification,
    });
  }
}

type DeclaredCompositionInput =
  | Extract<CompositionInput, { readonly role: 'fragment' | 'composition' | 'binding' }>
  | Omit<Extract<CompositionInput, { readonly role: 'resource' }>, 'classification'>
  | Omit<Extract<CompositionInput, { readonly role: 'generated_view' }>, 'classification'>;

function declaredCompositionInputs(
  payload: Readonly<Record<string, unknown>> | undefined,
): DeclaredCompositionInput[] {
  return requireArray(payload, 'inputs').map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`inputs[${index}] must be an object`);
    }
    const input = raw as Readonly<Record<string, unknown>>;
    const ordinal = requireInteger(input, 'ordinal', 1);
    const role = requireString(input, 'role');
    if (role === 'fragment') {
      return {
        ordinal,
        role,
        fragmentRevisionId: requireString(input, 'fragment_revision_id'),
      };
    }
    if (role === 'composition') {
      return {
        ordinal,
        role,
        compositionRevisionId: requireString(input, 'composition_revision_id'),
      };
    }
    if (role === 'resource') {
      return {
        ordinal,
        role,
        resourceVersionId: requireString(input, 'resource_version_id'),
        contentDigest: requireDigest(input, 'content_digest'),
      };
    }
    if (role === 'binding') {
      return { ordinal, role, bindingId: requireString(input, 'binding_id') };
    }
    if (role === 'generated_view') {
      return {
        ordinal,
        role,
        compiledViewId: requireString(input, 'compiled_view_id'),
        contentDigest: requireDigest(input, 'content_digest'),
      };
    }
    throw new Error(`inputs[${index}].role is not supported`);
  });
}

async function compositionInputs(
  tx: Tx,
  payload: Readonly<Record<string, unknown>> | undefined,
): Promise<CompositionInput[]> {
  const declared = declaredCompositionInputs(payload);
  const hydrated: CompositionInput[] = [];
  for (const input of declared) {
    if (input.role === 'resource') {
      const row = await tx.maybeOne<{ classification: string }>(
        `select o.classification
           from content.artifact_version v
           join core.object o on o.id = v.artifact_id
          where v.id = $1 and v.sha256 = $2`,
        [input.resourceVersionId, input.contentDigest],
      );
      if (row === undefined) {
        refuseDocument('KF-DOC-COMP-002', 'resource input is missing, mismatched, or not visible', {
          ordinal: input.ordinal,
        });
      }
      hydrated.push({
        ...input,
        classification: documentClassification(row.classification, 'resource classification'),
      });
    } else if (input.role === 'generated_view') {
      const row = await tx.maybeOne<{ classification: string }>(
        `select effective_classification as classification
           from content.compiled_view
          where id = $1 and content_digest = $2`,
        [input.compiledViewId, input.contentDigest],
      );
      if (row === undefined) {
        refuseDocument(
          'KF-DOC-COMP-002',
          'generated-view input is missing, mismatched, or not visible',
          { ordinal: input.ordinal },
        );
      }
      hydrated.push({
        ...input,
        classification: documentClassification(row.classification, 'generated-view classification'),
      });
    } else {
      hydrated.push(input);
    }
  }
  return hydrated;
}

async function classificationForCompositionInputs(
  tx: Tx,
  inputs: readonly CompositionInput[],
): Promise<string> {
  if (inputs.length === 0) {
    refuseDocument('KF-DOC-COMP-001', 'a document composition must contain at least one input');
  }
  let highest = 'public';
  for (const input of inputs) {
    let row: { classification: string } | undefined;
    if (input.role === 'fragment') {
      const fragment = await tx.maybeOne<{
        classification: string;
        holder_kind: string;
        holder_classification: string | null;
      }>(
        `select r.classification, h.holder_kind,
                artifact_object.classification as holder_classification
           from content.authored_fragment_revision r
           join content.document_subject s on s.id = r.fragment_id
           join content.document_source_holder h on h.id = r.holder_id
           left join content.artifact_version av on av.id = h.fabric_artifact_version_id
           left join core.object artifact_object on artifact_object.id = av.artifact_id
          where r.id = $1`,
        [input.fragmentRevisionId],
      );
      if (
        fragment !== undefined &&
        (fragment.holder_kind !== 'fabric_native' || fragment.holder_classification !== null)
      ) {
        row = {
          classification:
            fragment.holder_classification !== null &&
            classificationRank(fragment.holder_classification) >
              classificationRank(fragment.classification)
              ? fragment.holder_classification
              : fragment.classification,
        };
      }
    } else if (input.role === 'composition') {
      row = await tx.maybeOne<{ classification: string }>(
        `select o.classification
           from content.composition_revision r
           join content.document_subject s on s.id = r.composition_id
           join core.object o on o.id = s.object_id
          where r.id = $1`,
        [input.compositionRevisionId],
      );
    } else if (input.role === 'resource') {
      row = await tx.maybeOne<{ classification: string }>(
        `select o.classification
           from content.artifact_version v
           join core.object o on o.id = v.artifact_id
          where v.id = $1 and v.sha256 = $2`,
        [input.resourceVersionId, input.contentDigest],
      );
    } else if (input.role === 'binding') {
      row = await tx.maybeOne<{ classification: string }>(
        `select o.classification
           from content.typed_binding b
           join core.object o on o.id = b.object_id
          where b.id = $1`,
        [input.bindingId],
      );
    } else {
      row = await tx.maybeOne<{ classification: string }>(
        `select effective_classification as classification
           from content.compiled_view
          where id = $1 and content_digest = $2`,
        [input.compiledViewId, input.contentDigest],
      );
    }
    if (row === undefined) {
      refuseDocument(
        'KF-DOC-COMP-002',
        'composition input is missing, mismatched, or not visible',
        {
          role: input.role,
          ordinal: input.ordinal,
        },
      );
    }
    if (classificationRank(row.classification) > classificationRank(highest)) {
      highest = row.classification;
    }
  }
  return highest;
}

async function assertCompositionClassification(
  tx: Tx,
  classification: DocumentClassification,
  inputs: readonly CompositionInput[],
): Promise<void> {
  const highest = await classificationForCompositionInputs(tx, inputs);
  if (classificationRank(classification) < classificationRank(highest)) {
    refuseDocument(
      'KF-DOC-CLASS-002',
      'composition classification must be at least its highest visible input',
      { requested: classification, required: highest },
    );
  }
}

async function insertCompositionRevision(
  tx: Tx,
  input: {
    readonly id: string;
    readonly compositionId: string;
    readonly previousRevisionId: string | null;
    readonly classification: DocumentClassification;
    readonly inputs: readonly CompositionInput[];
    readonly actorId: string;
    readonly actionId: string;
  },
): Promise<void> {
  const revision = createCompositionRevision({
    id: input.id,
    compositionId: input.compositionId,
    previousRevisionId: input.previousRevisionId,
    classification: input.classification,
    inputs: input.inputs,
  });
  await tx.query(
    `insert into content.composition_revision
       (id, composition_id, previous_revision_id, revision_digest, created_by, created_by_action)
     values ($1,$2,$3,$4,$5,$6)`,
    [
      revision.id,
      revision.compositionId,
      revision.previousRevisionId,
      revision.revisionDigest,
      input.actorId,
      input.actionId,
    ],
  );
  for (const item of revision.inputs) {
    await tx.query(
      `insert into content.composition_input
         (composition_revision_id, ordinal, input_role, fragment_revision_id,
          child_composition_revision_id, resource_version_id, binding_id,
          compiled_view_id, content_digest)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        revision.id,
        item.ordinal,
        item.role,
        item.role === 'fragment' ? item.fragmentRevisionId : null,
        item.role === 'composition' ? item.compositionRevisionId : null,
        item.role === 'resource' ? item.resourceVersionId : null,
        item.role === 'binding' ? item.bindingId : null,
        item.role === 'generated_view' ? item.compiledViewId : null,
        item.role === 'resource' || item.role === 'generated_view' ? item.contentDigest : null,
      ],
    );
  }
}

async function touchDocumentObject(
  tx: Tx,
  request: ActionRequest,
  objectId: string,
  classification?: string,
): Promise<void> {
  await tx.query(
    `update core.object
        set classification = coalesce($2, classification),
            row_version = row_version + 1,
            updated_at = now(),
            updated_by = $3
      where id = $1`,
    [objectId, classification ?? null, request.actorId],
  );
}

async function objectClassification(tx: Tx, objectId: string): Promise<DocumentClassification> {
  const row = await tx.one<{ classification: string }>(
    'select classification from core.object where id = $1',
    [objectId],
  );
  return documentClassification(row.classification, 'object classification');
}

function basisFromRequest(request: ActionRequest): { id: string; basis: CompilationBasis } {
  const id = requireString(request.payload, 'basis_id');
  const supplied = requireRecord(request.payload, 'basis') as unknown as CompilationBasis;
  const basis = createCompilationBasis(supplied as CompilationBasisInput);
  if (
    supplied.basisDigest !== basis.basisDigest ||
    supplied.effectiveClassification !== basis.effectiveClassification
  ) {
    refuseDocument('KF-DOC-BASIS-001', 'supplied Basis digest does not match canonical contents', {
      basisId: id,
    });
  }
  return { id, basis };
}

async function assertBasisMatchesDatabase(
  tx: Tx,
  basis: CompilationBasis,
  targetObjectId: string,
): Promise<void> {
  const root = await tx.maybeOne<{
    object_id: string;
    revision_digest: string;
    classification: string;
  }>(
    `select s.object_id, r.revision_digest, o.classification
       from content.composition_revision r
       join content.document_subject s on s.id = r.composition_id
       join core.object o on o.id = s.object_id
      where r.id = $1`,
    [basis.rootCompositionRevisionId],
  );
  if (root?.object_id !== targetObjectId) {
    refuseDocument('KF-DOC-BASIS-002', 'Basis root is not the targeted document composition', {
      targetObjectId,
      rootCompositionRevisionId: basis.rootCompositionRevisionId,
    });
  }
  for (const revision of basis.fragmentRevisions) {
    const stored = await tx.maybeOne<{ revision_digest: string; classification: string }>(
      'select revision_digest, classification from content.authored_fragment_revision where id = $1',
      [revision.id],
    );
    if (
      stored?.revision_digest !== revision.revisionDigest ||
      stored.classification !== revision.classification
    ) {
      refuseDocument('KF-DOC-BASIS-003', 'Basis fragment does not match visible stored revision', {
        revisionId: revision.id,
      });
    }
  }
  for (const revision of basis.compositionRevisions) {
    const stored = await tx.maybeOne<{ revision_digest: string; classification: string }>(
      `select r.revision_digest, o.classification
         from content.composition_revision r
         join content.document_subject s on s.id = r.composition_id
         join core.object o on o.id = s.object_id
        where r.id = $1`,
      [revision.id],
    );
    if (
      stored?.revision_digest !== revision.revisionDigest ||
      stored.classification !== revision.classification
    ) {
      refuseDocument(
        'KF-DOC-BASIS-004',
        'Basis composition does not match visible stored revision',
        {
          revisionId: revision.id,
        },
      );
    }
  }
  for (const binding of basis.bindings) {
    const stored = await tx.maybeOne<{ binding_digest: string; classification: string }>(
      `select b.binding_digest, o.classification
         from content.typed_binding b
         join core.object o on o.id = b.object_id
        where b.id = $1`,
      [binding.id],
    );
    if (
      stored?.binding_digest !== binding.bindingDigest ||
      stored.classification !== binding.sourceClassification
    ) {
      refuseDocument('KF-DOC-BASIS-005', 'Basis binding does not match visible stored binding', {
        bindingId: binding.id,
      });
    }
  }
}

export function createDocumentActionAtoms(options: {
  readonly store: ObjectStore;
  readonly parser: DocumentParser;
}): DocumentActionAtoms {
  const attachEvidence: ActionMaterializer = async (tx, request) => {
    if (request.targetIds.length > 0) return [];
    const id = await createControlledObject(tx, {
      objectType: 'artifact',
      authorityDomain: 'artifact',
      lifecycleState: 'draft',
      title: requireString(request.payload, 'title'),
      organizationId: request.organizationId,
      createdBy: request.actorId,
      retentionClass: 'quality_record',
    });
    await tx.query(
      `insert into content.artifact (id, artifact_kind, source_system) values ($1,$2,'object_store')`,
      [id, requireString(request.payload, 'artifact_kind')],
    );
    return [id];
  };

  const recordEvidence: ActionEffect = async (tx, request, objects, ctx) => {
    const artifact = objects.find((object) => object.object_type === 'artifact');
    if (artifact === undefined) throw new Error('attach_evidence created no artifact target');
    const key = requireString(request.payload, 'storage_uri');
    const mediaType = requireString(request.payload, 'media_type');
    const verified: VerifiedUpload = await verifyUpload(options.store, {
      key,
      claimedSha256: requireSha256(request.payload),
      claimedSizeBytes: requireInteger(request.payload, 'size_bytes'),
    });
    const revisionLabel = optionalString(request.payload, 'revision_label');
    const version = await recordVersion(tx, {
      artifactId: artifact.id,
      verified,
      mediaType,
      createdBy: request.actorId,
      createdByAction: ctx.actionId,
      ...(revisionLabel === null ? {} : { revisionLabel }),
    });

    const parsed = await options.parser.parse(
      await options.store.read(verified.key, verified.storageVersion),
      mediaType,
    );
    if (parsed === undefined) return;
    const parse = await tx.one<{ id: string }>(
      `insert into content.document_parse
         (artifact_version_id, parser, parser_version, content_digest,
          created_by, created_by_action)
       values ($1,$2,$3,$4,$5,$6)
       returning id`,
      [
        version.id,
        parsed.parser,
        parsed.parserVersion,
        parsed.contentDigest,
        request.actorId,
        ctx.actionId,
      ],
    );
    for (const atom of parsed.atoms) {
      await tx.query(
        `insert into content.document_atom
           (parse_id, ordinal, atom_kind, heading_level, text_content, attributes, atom_digest)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          parse.id,
          atom.ordinal,
          atom.kind,
          atom.level,
          atom.text,
          JSON.stringify(atom.attributes),
          atom.digest,
        ],
      );
    }
  };

  const addControlledDocument: ActionMaterializer = async (tx, request) => {
    if (request.targetIds.length > 0) return [];
    const id = await createControlledObject(tx, {
      objectType: 'controlled_document',
      authorityDomain: 'qms',
      lifecycleState: 'draft',
      title: requireString(request.payload, 'title'),
      organizationId: request.organizationId,
      createdBy: request.actorId,
      retentionClass: 'quality_record',
    });
    await tx.query(
      `insert into quality.controlled_document
         (id, document_class, document_number, revision, owning_role, content_version)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        requireString(request.payload, 'document_class'),
        requireString(request.payload, 'document_number'),
        requireString(request.payload, 'revision'),
        requireString(request.payload, 'owning_role'),
        requireString(request.payload, 'content_version'),
      ],
    );
    return [id];
  };

  const addAuthoredFragment: ActionMaterializer = async (tx, request) => {
    if (request.targetIds.length !== 0) {
      refuseDocument(
        'KF-DOC-TARGET-002',
        'add_authored_fragment does not accept an existing target',
      );
    }
    const id = await createControlledObject(tx, {
      objectType: 'authored_fragment',
      authorityDomain: 'qms',
      lifecycleState: 'active',
      title: requireString(request.payload, 'title'),
      organizationId: request.organizationId,
      createdBy: request.actorId,
      classification: requireDocumentClassification(request.payload),
      retentionClass: 'quality_record',
    });
    return [id];
  };

  const materializeAuthoredFragment: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    const holderId = requireString(request.payload, 'holder_id');
    const revisionId = requireString(request.payload, 'revision_id');
    const holder = sourceHolderFromPayload(request.payload, object.id);
    const revision = createAuthoredFragmentRevision({
      id: revisionId,
      fragmentId: object.id,
      previousRevisionId: null,
      mediaType: requireString(request.payload, 'media_type'),
      classification: requireDocumentClassification(request.payload),
      state: 'active',
      holder,
    });
    await tx.query(
      `insert into content.document_subject
         (id, object_id, subject_kind, stable_key, document_policy, current_holder_id,
          created_by, created_by_action)
       values ($1,$1,'fragment',$2,$3,$4,$5,$6)`,
      [
        object.id,
        requireString(request.payload, 'stable_key'),
        requireDocumentPolicy(request),
        holderId,
        request.actorId,
        ctx.actionId,
      ],
    );
    await tx.query('insert into content.authored_fragment (id) values ($1)', [object.id]);
    await insertSourceHolder(tx, {
      id: holderId,
      subjectId: object.id,
      previousHolderId: null,
      holder,
      conversionLoss: [],
      migrationReason: null,
      reversibleMigrationPlan: null,
      actorId: request.actorId,
      actionId: ctx.actionId,
    });
    await tx.query(
      `insert into content.authored_fragment_revision
         (id, fragment_id, previous_revision_id, holder_id, media_type, classification,
          revision_state, content_digest, revision_digest, created_by, created_by_action)
       values ($1,$2,null,$3,$4,$5,'active',$6,$7,$8,$9)`,
      [
        revision.id,
        revision.fragmentId,
        holderId,
        revision.mediaType,
        revision.classification,
        revision.holder.contentDigest,
        revision.revisionDigest,
        request.actorId,
        ctx.actionId,
      ],
    );
  };

  const addDocumentComposition: ActionMaterializer = async (tx, request) => {
    if (request.targetIds.length !== 0) {
      refuseDocument(
        'KF-DOC-TARGET-002',
        'add_document_composition does not accept an existing target',
      );
    }
    const id = await createControlledObject(tx, {
      objectType: 'document_composition',
      authorityDomain: 'qms',
      lifecycleState: 'active',
      title: requireString(request.payload, 'title'),
      organizationId: request.organizationId,
      createdBy: request.actorId,
      classification: requireDocumentClassification(request.payload),
      retentionClass: 'quality_record',
    });
    return [id];
  };

  const materializeDocumentComposition: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const holderId = requireString(request.payload, 'holder_id');
    const holder = sourceHolderFromPayload(request.payload, object.id);
    await tx.query(
      `insert into content.document_subject
         (id, object_id, subject_kind, stable_key, document_policy, current_holder_id,
          created_by, created_by_action)
       values ($1,$1,'composition',$2,$3,$4,$5,$6)`,
      [
        object.id,
        requireString(request.payload, 'stable_key'),
        requireDocumentPolicy(request),
        holderId,
        request.actorId,
        ctx.actionId,
      ],
    );
    await tx.query('insert into content.document_composition (id) values ($1)', [object.id]);
    await insertSourceHolder(tx, {
      id: holderId,
      subjectId: object.id,
      previousHolderId: null,
      holder,
      conversionLoss: [],
      migrationReason: null,
      reversibleMigrationPlan: null,
      actorId: request.actorId,
      actionId: ctx.actionId,
    });
    await insertCompositionRevision(tx, {
      id: requireString(request.payload, 'revision_id'),
      compositionId: object.id,
      previousRevisionId: null,
      classification: await objectClassification(tx, object.id),
      inputs: await compositionInputs(tx, request.payload),
      actorId: request.actorId,
      actionId: ctx.actionId,
    });
  };

  const assertAddFragment: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    await assertQualityAuthorityWhenRequired(tx, request, objects, requireDocumentPolicy(request));
  };

  const assertAddComposition: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const inputs = await compositionInputs(tx, request.payload);
    await assertCompositionClassification(
      tx,
      requireDocumentClassification(request.payload),
      inputs,
    );
    await assertQualityAuthorityWhenRequired(tx, request, objects, requireDocumentPolicy(request));
  };

  const latestFragmentRevision = async (
    tx: Tx,
    objectId: string,
  ): Promise<{ subject_id: string; revision_id: string; revision_state: string } | undefined> =>
    tx.maybeOne<{ subject_id: string; revision_id: string; revision_state: string }>(
      `select s.id as subject_id, r.id as revision_id, r.revision_state
         from content.document_subject s
         join content.authored_fragment_revision r on r.fragment_id = s.id
        where s.object_id = $1
          and not exists (
            select 1 from content.authored_fragment_revision next
             where next.previous_revision_id = r.id
          )`,
      [objectId],
    );

  const assertFragmentRevisionBase = async (
    tx: Tx,
    request: ActionRequest,
    object: ObjectRow,
  ): Promise<void> => {
    if (object.lifecycle_state !== 'active') {
      refuseDocument('KF-DOC-FRAG-001', 'only an active Authored Fragment may be revised', {
        objectId: object.id,
      });
    }
    const latest = await latestFragmentRevision(tx, object.id);
    if (
      latest === undefined ||
      latest.revision_state === 'retired' ||
      latest.revision_id !== requireString(request.payload, 'previous_revision_id')
    ) {
      refuseDocument('KF-DOC-FRAG-002', 'revision must name the latest fragment revision', {
        objectId: object.id,
      });
    }
  };

  const assertReviseFragment: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    await assertFragmentRevisionBase(tx, request, object);
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await subjectDocumentPolicy(tx, object.id),
    );
    await assertClassificationMayAdvance(
      tx,
      object.id,
      requireDocumentClassification(request.payload),
    );
    await assertRevisionHolder(tx, request.payload, object.id);
  };

  const appendFragmentRevision = async (
    tx: Tx,
    request: ActionRequest,
    object: ObjectRow,
    actionId: string,
    state: 'active' | 'retired',
    holderRow?: HolderRow,
  ): Promise<void> => {
    const exactHolder = holderRow ?? (await currentHolder(tx, object.id));
    const holder = sourceHolderFromRow(exactHolder);
    const revision = createAuthoredFragmentRevision({
      id: requireString(request.payload, 'revision_id'),
      fragmentId: exactHolder.subject_id,
      previousRevisionId: requireString(request.payload, 'previous_revision_id'),
      mediaType: requireString(request.payload, 'media_type'),
      classification: requireDocumentClassification(request.payload),
      state,
      holder,
    });
    await tx.query(
      `insert into content.authored_fragment_revision
         (id, fragment_id, previous_revision_id, holder_id, media_type, classification,
          revision_state, content_digest, revision_digest, created_by, created_by_action)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        revision.id,
        revision.fragmentId,
        revision.previousRevisionId,
        exactHolder.holder_id,
        revision.mediaType,
        revision.classification,
        revision.state,
        revision.holder.contentDigest,
        revision.revisionDigest,
        request.actorId,
        actionId,
      ],
    );
  };

  const reviseAuthoredFragment: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    const holder = await appendRevisionHolder(tx, request, object.id, ctx.actionId);
    await appendFragmentRevision(tx, request, object, ctx.actionId, 'active', holder);
    await touchDocumentObject(
      tx,
      request,
      object.id,
      requireDocumentClassification(request.payload),
    );
  };

  const assertRetireFragment: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentRole(tx, request, objects, TECHNICAL_AUTHORITY_ROLE);
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    await assertFragmentRevisionBase(tx, request, object);
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await subjectDocumentPolicy(tx, object.id),
    );
    await assertClassificationMayAdvance(
      tx,
      object.id,
      requireDocumentClassification(request.payload),
    );
  };

  const retireAuthoredFragment: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, FRAGMENT_TARGET, request.actionType);
    await appendFragmentRevision(tx, request, object, ctx.actionId, 'retired');
  };

  const latestCompositionRevision = async (
    tx: Tx,
    objectId: string,
  ): Promise<{ subject_id: string; revision_id: string } | undefined> =>
    tx.maybeOne<{ subject_id: string; revision_id: string }>(
      `select s.id as subject_id, r.id as revision_id
         from content.document_subject s
         join content.composition_revision r on r.composition_id = s.id
        where s.object_id = $1
          and not exists (
            select 1 from content.composition_revision next
             where next.previous_revision_id = r.id
          )`,
      [objectId],
    );

  const assertReviseComposition: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const latest = await latestCompositionRevision(tx, object.id);
    if (latest?.revision_id !== requireString(request.payload, 'previous_revision_id')) {
      refuseDocument('KF-DOC-COMP-003', 'revision must name the latest composition revision', {
        objectId: object.id,
      });
    }
    const classification = requireDocumentClassification(request.payload);
    const inputs = await compositionInputs(tx, request.payload);
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await subjectDocumentPolicy(tx, object.id),
    );
    await assertClassificationMayAdvance(tx, object.id, classification);
    await assertCompositionClassification(tx, classification, inputs);
    await assertRevisionHolder(tx, request.payload, object.id);
  };

  const reviseDocumentComposition: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const subject = await tx.one<{ id: string }>(
      'select id from content.document_subject where object_id = $1',
      [object.id],
    );
    await appendRevisionHolder(tx, request, object.id, ctx.actionId);
    await touchDocumentObject(
      tx,
      request,
      object.id,
      requireDocumentClassification(request.payload),
    );
    await insertCompositionRevision(tx, {
      id: requireString(request.payload, 'revision_id'),
      compositionId: subject.id,
      previousRevisionId: requireString(request.payload, 'previous_revision_id'),
      classification: await objectClassification(tx, object.id),
      inputs: await compositionInputs(tx, request.payload),
      actorId: request.actorId,
      actionId: ctx.actionId,
    });
  };

  const assertChangeHolder: PreconditionCheck = async (tx, request, objects) => {
    await assertTechnicalDocumentAuthority(tx, request, objects);
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    if (request.reason?.trim() === '') {
      refuseDocument('KF-DOC-001', 'Source Holder change requires a reason', {
        objectId: object.id,
      });
    }
    if (request.reason === undefined) {
      refuseDocument('KF-DOC-001', 'Source Holder change requires a reason', {
        objectId: object.id,
      });
    }
    requireString(request.payload, 'reversible_migration_plan');
    const current = await currentHolder(tx, object.id);
    if (current.holder_id !== requireString(request.payload, 'previous_holder_id')) {
      refuseDocument('KF-DOC-001', 'Source Holder change must name the current Holder', {
        objectId: object.id,
        currentHolderId: current.holder_id,
      });
    }
    sourceHolderFromPayload(request.payload, current.subject_id);
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await subjectDocumentPolicy(tx, object.id),
    );
  };

  const changeDocumentSourceHolder: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const current = await currentHolder(tx, object.id);
    const holderId = requireString(request.payload, 'holder_id');
    await insertSourceHolder(tx, {
      id: holderId,
      subjectId: current.subject_id,
      previousHolderId: current.holder_id,
      holder: sourceHolderFromPayload(request.payload, current.subject_id),
      conversionLoss: Array.isArray(request.payload?.['conversion_loss'])
        ? request.payload['conversion_loss']
        : [],
      migrationReason: request.reason ?? null,
      reversibleMigrationPlan: requireString(request.payload, 'reversible_migration_plan'),
      actorId: request.actorId,
      actionId: ctx.actionId,
    });
    await tx.query(
      'update content.document_subject set current_holder_id = $2 where object_id = $1',
      [object.id, holderId],
    );
    await touchDocumentObject(tx, request, object.id);
  };

  const assertRequestCompilation: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const { basis } = basisFromRequest(request);
    await assertBasisMatchesDatabase(tx, basis, object.id);
  };

  const requestDocumentCompilation: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const { id, basis } = basisFromRequest(request);
    const compiler = basis.compiler;
    await tx.query(
      `insert into content.compilation_basis
         (id, protocol, root_composition_revision_id, basis, basis_digest,
          ontology_digest, policy_digest, target_profiles, compiler_kind,
          compiler_name, compiler_version, liminal_commit_sha, cargo_lock_digest,
          executable_digest, qualification_state, qualification_receipt_digest,
          qualification_ratified, created_by, created_by_action)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id,
        basis.protocol,
        basis.rootCompositionRevisionId,
        JSON.stringify(basis),
        basis.basisDigest,
        basis.ontologyDigest,
        basis.policyDigest,
        JSON.stringify(basis.targetProfiles),
        compiler.kind,
        compiler.name,
        compiler.version,
        compiler.kind === 'liminal' ? compiler.commitSha : null,
        compiler.kind === 'liminal' ? compiler.cargoLockDigest : null,
        compiler.executableDigest,
        compiler.kind === 'liminal' ? compiler.qualification.state : 'not_applicable',
        compiler.kind === 'liminal' ? compiler.qualification.receiptDigest : null,
        compiler.kind === 'liminal' ? compiler.qualification.ratified : false,
        request.actorId,
        ctx.actionId,
      ],
    );
    for (const revision of basis.fragmentRevisions) {
      await tx.query(
        `insert into content.compilation_basis_fragment (basis_id, fragment_revision_id)
         values ($1,$2)`,
        [id, revision.id],
      );
    }
    for (const revision of basis.compositionRevisions) {
      await tx.query(
        `insert into content.compilation_basis_composition
           (basis_id, composition_revision_id) values ($1,$2)`,
        [id, revision.id],
      );
    }
    for (const binding of basis.bindings) {
      await tx.query(
        'insert into content.compilation_basis_binding (basis_id, binding_id) values ($1,$2)',
        [id, binding.id],
      );
    }
    const finalized = await tx.one<{ classification: string }>(
      'select content.finalize_compilation_basis($1) as classification',
      [id],
    );
    if (finalized.classification !== basis.effectiveClassification) {
      refuseDocument(
        'KF-DOC-BASIS-006',
        'database-derived Basis classification differs from the canonical Basis',
        {
          basisId: id,
          canonical: basis.effectiveClassification,
          authoritative: finalized.classification,
        },
      );
    }
    await touchDocumentObject(tx, request, object.id);
  };

  interface CompilationRunReceipt extends Record<string, unknown> {
    readonly run_id: string;
    readonly run_digest: string;
    readonly run_status: string;
    readonly draft_only: boolean;
    readonly semantic_digest: string | null;
    readonly diagnostics: unknown;
    readonly conversion_loss: unknown;
    readonly requested_by_action: string;
    readonly basis_id: string;
    readonly basis_digest: string;
    readonly target_profiles: unknown;
    readonly basis_created_by_action: string;
    readonly target_object_id: string;
  }

  const compilationRunReceipt = async (tx: Tx, runId: string): Promise<CompilationRunReceipt> => {
    const row = await tx.maybeOne<CompilationRunReceipt>(
      `select r.id as run_id, r.run_digest, r.run_status, r.draft_only, r.semantic_digest,
              r.diagnostics, r.conversion_loss, r.requested_by_action, r.basis_id,
              b.basis_digest, b.target_profiles,
              b.created_by_action as basis_created_by_action,
              s.object_id as target_object_id
         from content.compilation_run r
         join content.compilation_basis b on b.id = r.basis_id
         join content.composition_revision cr on cr.id = b.root_composition_revision_id
         join content.document_subject s on s.id = cr.composition_id
        where r.id = $1`,
      [runId],
    );
    if (row === undefined) {
      return refuseDocument('KF-DOC-COMPILE-001', 'compilation run is missing or not visible', {
        runId,
      });
    }
    return row;
  };

  interface RecordedAction extends Record<string, unknown> {
    readonly action_type: string;
    readonly target_ids: string[];
    readonly parameters: unknown;
  }

  const actionReceipt = async (tx: Tx, actionId: string): Promise<RecordedAction> => {
    const action = await tx.maybeOne<RecordedAction>(
      'select action_type, target_ids, parameters from core.action where id = $1',
      [actionId],
    );
    if (action === undefined) {
      return refuseDocument('KF-DOC-COMPILE-002', 'referenced action receipt is not visible', {
        actionId,
      });
    }
    return action;
  };

  const actionParameters = (
    action: RecordedAction,
    rule: string,
  ): Readonly<Record<string, unknown>> => {
    if (
      action.parameters === null ||
      typeof action.parameters !== 'object' ||
      Array.isArray(action.parameters)
    ) {
      return refuseDocument(rule, 'recorded action parameters are not an object');
    }
    return action.parameters as Readonly<Record<string, unknown>>;
  };

  const assertAuthorizedCompilationRun = async (
    tx: Tx,
    request: ActionRequest,
    object: ObjectRow,
  ): Promise<CompilationRunReceipt> => {
    const runId = requireString(request.payload, 'run_id');
    const receipt = await compilationRunReceipt(tx, runId);
    if (
      receipt.run_digest !== requireDigest(request.payload, 'run_digest') ||
      receipt.target_object_id !== object.id
    ) {
      refuseDocument(
        'KF-DOC-COMPILE-003',
        'compilation receipt does not match the request target',
        {
          runId,
          objectId: object.id,
        },
      );
    }
    const targetProfiles = Array.isArray(receipt.target_profiles)
      ? receipt.target_profiles
      : undefined;
    const expectedTargets = targetProfiles
      ? targetProfiles
          .map((profile) =>
            profile !== null && typeof profile === 'object' && !Array.isArray(profile)
              ? (profile as Record<string, unknown>)['target']
              : undefined,
          )
          .filter((target): target is string => typeof target === 'string')
          .sort()
      : [];
    const recordedViews = await tx.query<{ target: string }>(
      'select target from content.compiled_view where compilation_run_id = $1 order by target',
      [runId],
    );
    if (
      expectedTargets.length === 0 ||
      expectedTargets.length !== targetProfiles?.length ||
      JSON.stringify(recordedViews.map((view) => view.target)) !== JSON.stringify(expectedTargets)
    ) {
      refuseDocument(
        'KF-DOC-COMPILE-005',
        'compilation run does not contain exactly its Basis-declared views',
        { runId },
      );
    }
    if (
      receipt.run_status !== 'succeeded' ||
      receipt.draft_only ||
      receipt.semantic_digest === null ||
      !Array.isArray(receipt.diagnostics) ||
      !receipt.diagnostics.every((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
        const diagnostic = item as Record<string, unknown>;
        return (
          (diagnostic['severity'] === 'info' ||
            diagnostic['severity'] === 'warning' ||
            diagnostic['severity'] === 'error') &&
          diagnostic['severity'] !== 'error' &&
          typeof diagnostic['code'] === 'string' &&
          diagnostic['code'].trim() !== '' &&
          typeof diagnostic['message'] === 'string' &&
          diagnostic['message'].trim() !== ''
        );
      }) ||
      !Array.isArray(receipt.conversion_loss) ||
      receipt.conversion_loss.length !== 0
    ) {
      refuseDocument(
        'KF-DOC-COMPILE-004',
        'only a succeeded, qualified, lossless compilation may be accepted',
        { runId },
      );
    }
    if (
      receipt.requested_by_action !== receipt.basis_created_by_action ||
      receipt.requested_by_action.trim() === ''
    ) {
      refuseDocument(
        'KF-DOC-002',
        'compilation run is not tied to the action that authorized its exact Basis',
        { runId },
      );
    }
    const authorization = await actionReceipt(tx, receipt.requested_by_action);
    const parameters = actionParameters(authorization, 'KF-DOC-002');
    if (
      authorization.action_type !== 'request_document_compilation' ||
      authorization.target_ids.length !== 1 ||
      authorization.target_ids[0] !== object.id ||
      parameters['basis_id'] !== receipt.basis_id ||
      parameters['basis'] === null ||
      typeof parameters['basis'] !== 'object' ||
      Array.isArray(parameters['basis']) ||
      (parameters['basis'] as Record<string, unknown>)['basisDigest'] !== receipt.basis_digest
    ) {
      refuseDocument('KF-DOC-002', 'compilation request receipt does not authorize this run', {
        runId,
        requestActionId: receipt.requested_by_action,
      });
    }
    return receipt;
  };

  const assertAcceptCompilation: PreconditionCheck = async (tx, request, objects) => {
    await assertTechnicalDocumentAuthority(tx, request, objects);
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    await assertQualityAuthorityWhenRequired(
      tx,
      request,
      objects,
      await subjectDocumentPolicy(tx, object.id),
    );
    await assertAuthorizedCompilationRun(tx, request, object);
  };

  const acceptDocumentCompilation: ActionEffect = async (tx, request, objects) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    await touchDocumentObject(tx, request, object.id);
  };

  interface CompiledViewReceipt extends CompilationRunReceipt {
    readonly view_id: string;
    readonly view_target: string;
    readonly content_digest: string;
    readonly target_profiles: unknown;
  }

  const assertPublishDocumentView: PreconditionCheck = async (tx, request, objects) => {
    await assertTechnicalDocumentAuthority(tx, request, objects);
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    const policy = await subjectDocumentPolicy(tx, object.id);
    await assertQualityAuthorityWhenRequired(tx, request, objects, policy);
    const publicationTarget = requireString(request.payload, 'publication_target');
    const viewId = requireString(request.payload, 'compiled_view_id');
    const view = await tx.maybeOne<CompiledViewReceipt>(
      `select v.id as view_id, v.target as view_target, v.content_digest,
              r.id as run_id, r.run_digest, r.run_status, r.draft_only, r.semantic_digest,
              r.diagnostics, r.conversion_loss, r.requested_by_action, r.basis_id,
              b.basis_digest, b.target_profiles,
              b.created_by_action as basis_created_by_action,
              s.object_id as target_object_id
         from content.compiled_view v
         join content.compilation_run r on r.id = v.compilation_run_id
         join content.compilation_basis b on b.id = r.basis_id
         join content.composition_revision cr on cr.id = b.root_composition_revision_id
         join content.document_subject s on s.id = cr.composition_id
        where v.id = $1`,
      [viewId],
    );
    if (
      view === undefined ||
      view.target_object_id !== object.id ||
      !Array.isArray(view.target_profiles) ||
      !view.target_profiles.some(
        (profile) =>
          profile !== null &&
          typeof profile === 'object' &&
          !Array.isArray(profile) &&
          (profile as Record<string, unknown>)['target'] === view.view_target,
      )
    ) {
      refuseDocument('KF-DOC-PUBLISH-001', 'compiled view is missing or targets another document', {
        viewId,
      });
    }
    const target = await tx.maybeOne<{ id: string; max_classification: string; active: boolean }>(
      `select id, max_classification, active
         from content.document_publication_target
        where id = $1
          and organization_id = $2`,
      [publicationTarget, request.organizationId],
    );
    if (target === undefined || !target.active) {
      refuseDocument('KF-DOC-PUBLISH-003', 'publication target is missing or inactive', {
        publicationTarget,
      });
    }
    const targetRank = await tx.one<{ rank: number }>(
      'select rank from registry.classification where id = $1',
      [target.max_classification],
    );
    const viewRank = await tx.one<{ rank: number }>(
      'select rank from registry.classification where id = $1',
      [view.effective_classification],
    );
    if (viewRank.rank > targetRank.rank) {
      refuseDocument('KF-DOC-PUBLISH-004', 'compiled view classification exceeds target max', {
        publicationTarget,
      });
    }
    const acceptanceId = requireString(request.payload, 'acceptance_action_id');
    const acceptance = await actionReceipt(tx, acceptanceId);
    const parameters = actionParameters(acceptance, 'KF-DOC-PUBLISH-002');
    if (
      acceptance.action_type !== 'accept_document_compilation' ||
      acceptance.target_ids.length !== 1 ||
      acceptance.target_ids[0] !== object.id ||
      parameters['run_id'] !== view.run_id ||
      parameters['run_digest'] !== view.run_digest ||
      view.run_status !== 'succeeded' ||
      view.draft_only
    ) {
      refuseDocument(
        'KF-DOC-PUBLISH-002',
        'publication requires the exact accepted, qualified compilation run',
        { viewId, acceptanceId },
      );
    }
    const controlledDocumentId = requireString(request.payload, 'controlled_document_id');
    const contentVersionId = requireString(request.payload, 'content_version_id');
    const controlledDocument = await tx.maybeOne<{
      id: string;
      content_version: string | null;
      lifecycle_state: string;
      classification: string;
      organization_id: string;
    }>(
      `select cd.id, cd.content_version, o.lifecycle_state, o.classification, o.organization_id
         from quality.controlled_document cd
         join core.object o on o.id = cd.id
        where cd.id = $1`,
      [controlledDocumentId],
    );
    if (
      controlledDocument === undefined ||
      controlledDocument.content_version !== contentVersionId ||
      controlledDocument.lifecycle_state !== 'effective' ||
      controlledDocument.organization_id !== request.organizationId
    ) {
      refuseDocument(
        'KF-DOC-PUBLISH-005',
        'publication requires the exact effective controlled document revision',
        { controlledDocumentId, contentVersionId },
      );
    }
    const controlledRank = await tx.one<{ rank: number }>(
      'select rank from registry.classification where id = $1',
      [controlledDocument.classification],
    );
    if (controlledRank.rank < viewRank.rank) {
      refuseDocument('KF-DOC-PUBLISH-006', 'controlled document classification is below the view', {
        controlledDocumentId,
      });
    }
  };

  const publishDocumentView: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, COMPOSITION_TARGET, request.actionType);
    await tx.query(
      `insert into content.document_publication
         (subject_id, compiled_view_id, compiled_view_digest, controlled_document_id, content_version_id,
          publication_target, target_max_classification, effective_classification,
          recorded_by, recorded_by_action)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        object.id,
        requireString(request.payload, 'compiled_view_id'),
        view.content_digest,
        requireString(request.payload, 'controlled_document_id'),
        requireString(request.payload, 'content_version_id'),
        requireString(request.payload, 'publication_target'),
        (
          await tx.one<{ max_classification: string }>(
            `select max_classification
               from content.document_publication_target
              where id = $1
                and organization_id = $2`,
            [requireString(request.payload, 'publication_target'), request.organizationId],
          )
        ).max_classification,
        await subjectDocumentPolicy(tx, object.id),
        request.actorId,
        ctx.actionId,
      ],
    );
    await touchDocumentObject(tx, request, object.id);
  };

  type ProposalOperation = Readonly<Record<string, JsonValue>>;

  const proposalOperations = (
    payload: Readonly<Record<string, unknown>> | undefined,
  ): readonly ProposalOperation[] =>
    requireArray(payload, 'operations').map((operation, index) => {
      if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
        throw new Error(`operations[${index}] must be an object`);
      }
      return operation as ProposalOperation;
    });

  interface ProposalRow extends Record<string, unknown> {
    readonly id: string;
    readonly subject_id: string;
    readonly subject_kind: 'fragment' | 'composition';
    readonly object_id: string;
    readonly base_fragment_revision_id: string | null;
    readonly base_composition_revision_id: string | null;
    readonly basis_id: string;
    readonly proposal_kind: 'source_patch' | 'semantic_operations';
    readonly operations: unknown;
    readonly proposal_digest: string;
  }

  const proposalRow = async (tx: Tx, proposalId: string): Promise<ProposalRow> => {
    const proposal = await tx.maybeOne<ProposalRow>(
      `select p.id, p.subject_id, s.subject_kind, s.object_id,
              p.base_fragment_revision_id, p.base_composition_revision_id,
              p.basis_id, p.proposal_kind, p.operations, p.proposal_digest
         from content.proposal_overlay p
         join content.document_subject s on s.id = p.subject_id
        where p.id = $1`,
      [proposalId],
    );
    if (proposal === undefined) {
      return refuseDocument('KF-DOC-PROPOSAL-001', 'proposal is missing or not visible', {
        proposalId,
      });
    }
    return proposal;
  };

  const assertRecordProposal: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentAuthor(tx, request, objects);
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const basisId = requireString(request.payload, 'basis_id');
    const basis = await tx.maybeOne<{ basis_digest: string; finalized_at: Date | null }>(
      'select basis_digest, finalized_at from content.compilation_basis where id = $1',
      [basisId],
    );
    if (basis?.finalized_at === null || basis === undefined) {
      refuseDocument('KF-DOC-PROPOSAL-002', 'proposal requires a visible finalized Basis', {
        basisId,
      });
    }
    const proposalKind = requireString(request.payload, 'proposal_kind');
    if (proposalKind !== 'source_patch' && proposalKind !== 'semantic_operations') {
      throw new Error('proposal_kind must be source_patch or semantic_operations');
    }
    if (
      (object.object_type === 'authored_fragment' && proposalKind !== 'source_patch') ||
      (object.object_type === 'document_composition' && proposalKind !== 'semantic_operations')
    ) {
      refuseDocument('KF-DOC-PROPOSAL-012', 'proposal kind does not match its document subject', {
        proposalKind,
        objectType: object.object_type,
      });
    }
    const proposedByKind = requireString(request.payload, 'proposed_by_kind');
    if (proposedByKind === 'human') {
      const declaredActor = optionalString(request.payload, 'actor_id');
      if (declaredActor !== null && declaredActor !== request.actorId) {
        refuseDocument('KF-DOC-PROPOSAL-003', 'a human proposal may only name the action actor');
      }
    } else if (proposedByKind === 'model') {
      requireString(request.payload, 'model_provider');
      requireString(request.payload, 'model_profile');
      requireString(request.payload, 'model_request_id');
    } else {
      throw new Error('proposed_by_kind must be human or model');
    }
    proposalOperations(request.payload);
    const membership =
      object.object_type === 'authored_fragment'
        ? await tx.maybeOne<{ subject_id: string }>(
            `select r.fragment_id as subject_id
               from content.authored_fragment_revision r
               join content.compilation_basis_fragment bf on bf.fragment_revision_id = r.id
              where r.id = $1 and bf.basis_id = $2`,
            [requireString(request.payload, 'base_fragment_revision_id'), basisId],
          )
        : await tx.maybeOne<{ subject_id: string }>(
            `select r.composition_id as subject_id
               from content.composition_revision r
               join content.compilation_basis_composition bc on bc.composition_revision_id = r.id
              where r.id = $1 and bc.basis_id = $2`,
            [requireString(request.payload, 'base_composition_revision_id'), basisId],
          );
    if (membership?.subject_id !== object.id) {
      refuseDocument(
        'KF-DOC-PROPOSAL-004',
        'proposal base revision is not the targeted subject in the named Basis',
        { basisId, objectId: object.id },
      );
    }
  };

  const recordDocumentProposal: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const basisId = requireString(request.payload, 'basis_id');
    const basis = await tx.one<{ basis_digest: string }>(
      'select basis_digest from content.compilation_basis where id = $1',
      [basisId],
    );
    const proposedByKind = requireString(request.payload, 'proposed_by_kind');
    const proposedBy =
      proposedByKind === 'human'
        ? ({ kind: 'human', actorId: request.actorId } as const)
        : ({
            kind: 'model',
            provider: requireString(request.payload, 'model_provider'),
            modelProfile: requireString(request.payload, 'model_profile'),
            requestId: requireString(request.payload, 'model_request_id'),
          } as const);
    const proposal = createProposalOverlay({
      id: requireString(request.payload, 'proposal_id'),
      subjectId: object.id,
      baseRevisionId:
        object.object_type === 'authored_fragment'
          ? requireString(request.payload, 'base_fragment_revision_id')
          : requireString(request.payload, 'base_composition_revision_id'),
      basisDigest: basis.basis_digest,
      kind: requireString(request.payload, 'proposal_kind') as
        'source_patch' | 'semantic_operations',
      proposedBy,
      operations: proposalOperations(request.payload),
      createdAt: ctx.effectiveAt.toISOString(),
    });
    await tx.query(
      `insert into content.proposal_overlay
         (id, subject_id, base_fragment_revision_id, base_composition_revision_id,
          basis_id, proposal_kind, proposed_by_kind, actor_id, model_provider,
          model_profile, model_request_id, operations, proposal_digest, created_by_action)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        proposal.id,
        proposal.subjectId,
        object.object_type === 'authored_fragment' ? proposal.baseRevisionId : null,
        object.object_type === 'document_composition' ? proposal.baseRevisionId : null,
        basisId,
        proposal.kind,
        proposal.proposedBy.kind,
        proposal.proposedBy.kind === 'human' ? proposal.proposedBy.actorId : null,
        proposal.proposedBy.kind === 'model' ? proposal.proposedBy.provider : null,
        proposal.proposedBy.kind === 'model' ? proposal.proposedBy.modelProfile : null,
        proposal.proposedBy.kind === 'model' ? proposal.proposedBy.requestId : null,
        JSON.stringify(proposal.operations),
        proposal.proposalDigest,
        ctx.actionId,
      ],
    );
    await touchDocumentObject(tx, request, object.id);
  };

  const parsedStoredOperations = (proposal: ProposalRow): readonly ProposalOperation[] => {
    if (!Array.isArray(proposal.operations)) {
      return refuseDocument('KF-DOC-PROPOSAL-005', 'stored proposal operations are malformed');
    }
    return proposal.operations.map((operation, index) => {
      if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
        return refuseDocument('KF-DOC-PROPOSAL-005', 'stored proposal operation is malformed', {
          index,
        });
      }
      return operation as ProposalOperation;
    });
  };

  const soleProposalOperation = (proposal: ProposalRow): ProposalOperation => {
    const operations = parsedStoredOperations(proposal);
    if (operations.length !== 1) {
      return refuseDocument(
        'KF-DOC-PROPOSAL-006',
        'this action applies exactly one supported typed proposal operation',
        { proposalId: proposal.id },
      );
    }
    return operations[0]!;
  };

  const assertApplyProposal: PreconditionCheck = async (tx, request, objects) => {
    await assertDocumentRole(tx, request, objects, TECHNICAL_AUTHORITY_ROLE);
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const person = await tx.maybeOne<{ id: string }>(
      'select id from org.person where id = $1 and organization = $2',
      [request.actorId, request.organizationId],
    );
    if (person === undefined) {
      refuseDocumentAuthority(
        'KF-DOC-AUTH-004',
        'Proposal Overlay application requires a human organization member',
        { actorId: request.actorId },
      );
    }
    const proposalId = requireString(request.payload, 'proposal_id');
    const proposal = await proposalRow(tx, proposalId);
    if (
      proposal.object_id !== object.id ||
      proposal.proposal_digest !== requireDigest(request.payload, 'proposal_digest')
    ) {
      refuseDocument('KF-DOC-PROPOSAL-007', 'proposal identity or target does not match', {
        proposalId,
        objectId: object.id,
      });
    }
    const alreadyApplied = await tx.maybeOne<{ id: string }>(
      `select id from core.action
        where action_type = 'apply_document_proposal'
          and parameters ->> 'proposal_id' = $1
        limit 1`,
      [proposal.id],
    );
    if (alreadyApplied !== undefined) {
      refuseDocument('KF-DOC-PROPOSAL-008', 'Proposal Overlay has already been applied', {
        proposalId,
      });
    }
    const operation = soleProposalOperation(proposal);
    if (object.object_type === 'authored_fragment') {
      const latest = await latestFragmentRevision(tx, object.id);
      if (
        proposal.subject_kind !== 'fragment' ||
        proposal.proposal_kind !== 'source_patch' ||
        proposal.base_fragment_revision_id === null ||
        latest?.revision_id !== proposal.base_fragment_revision_id ||
        latest.revision_state !== 'active' ||
        operation['operation'] !== 'replace_fragment_source'
      ) {
        refuseDocument(
          'KF-DOC-PROPOSAL-009',
          'fragment proposal is stale or is not a supported source patch',
          { proposalId },
        );
      }
      requireString(operation, 'media_type');
      const classification = requireDocumentClassification(operation);
      await assertClassificationMayAdvance(tx, object.id, classification);
      await assertRevisionHolder(tx, operation, object.id);
    } else {
      const latest = await latestCompositionRevision(tx, object.id);
      if (
        proposal.subject_kind !== 'composition' ||
        proposal.proposal_kind !== 'semantic_operations' ||
        proposal.base_composition_revision_id === null ||
        latest?.revision_id !== proposal.base_composition_revision_id ||
        operation['operation'] !== 'replace_composition_inputs'
      ) {
        refuseDocument(
          'KF-DOC-PROPOSAL-011',
          'composition proposal is stale or is not a supported typed composition operation',
          { proposalId },
        );
      }
      const classification = requireDocumentClassification(operation);
      const inputs = await compositionInputs(tx, operation);
      await assertClassificationMayAdvance(tx, object.id, classification);
      await assertCompositionClassification(tx, classification, inputs);
      await assertRevisionHolder(tx, operation, object.id);
    }
    requireString(request.payload, 'revision_id');
  };

  const applyDocumentProposal: ActionEffect = async (tx, request, objects, ctx) => {
    const object = requireDocumentTarget(objects, DOCUMENT_TARGET, request.actionType);
    const proposal = await proposalRow(tx, requireString(request.payload, 'proposal_id'));
    const operation = soleProposalOperation(proposal);
    const classification = requireDocumentClassification(operation);
    if (object.object_type === 'authored_fragment') {
      const holderRow = await appendRevisionHolder(tx, request, object.id, ctx.actionId, operation);
      const revision = createAuthoredFragmentRevision({
        id: requireString(request.payload, 'revision_id'),
        fragmentId: holderRow.subject_id,
        previousRevisionId: proposal.base_fragment_revision_id!,
        mediaType: requireString(operation, 'media_type'),
        classification,
        state: 'active',
        holder: sourceHolderFromRow(holderRow),
      });
      await tx.query(
      `insert into content.authored_fragment_revision
         (id, fragment_id, previous_revision_id, holder_id, media_type, classification,
          revision_state, content_digest, revision_digest, created_by, created_by_action)
         values ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10)`,
        [
          revision.id,
          revision.fragmentId,
          revision.previousRevisionId,
          holderRow.holder_id,
          revision.mediaType,
          revision.classification,
          revision.holder.contentDigest,
          revision.revisionDigest,
          request.actorId,
          ctx.actionId,
        ],
      );
      await touchDocumentObject(tx, request, object.id, classification);
    } else {
      await appendRevisionHolder(tx, request, object.id, ctx.actionId, operation);
      await touchDocumentObject(tx, request, object.id, classification);
      await insertCompositionRevision(tx, {
        id: requireString(request.payload, 'revision_id'),
        compositionId: object.id,
        previousRevisionId: proposal.base_composition_revision_id!,
        classification: await objectClassification(tx, object.id),
        inputs: await compositionInputs(tx, operation),
        actorId: request.actorId,
        actionId: ctx.actionId,
      });
    }
  };

  return {
    name: 'documents',
    materializers: {
      attach_evidence: attachEvidence,
      add_controlled_document: addControlledDocument,
      add_authored_fragment: addAuthoredFragment,
      add_document_composition: addDocumentComposition,
    },
    effects: {
      attach_evidence: recordEvidence,
      add_authored_fragment: materializeAuthoredFragment,
      revise_authored_fragment: reviseAuthoredFragment,
      retire_authored_fragment: retireAuthoredFragment,
      add_document_composition: materializeDocumentComposition,
      revise_document_composition: reviseDocumentComposition,
      change_document_source_holder: changeDocumentSourceHolder,
      request_document_compilation: requestDocumentCompilation,
      accept_document_compilation: acceptDocumentCompilation,
      publish_document_view: publishDocumentView,
      record_document_proposal: recordDocumentProposal,
      apply_document_proposal: applyDocumentProposal,
    },
    preconditions: {
      add_authored_fragment: assertAddFragment,
      revise_authored_fragment: assertReviseFragment,
      retire_authored_fragment: assertRetireFragment,
      add_document_composition: assertAddComposition,
      revise_document_composition: assertReviseComposition,
      change_document_source_holder: assertChangeHolder,
      request_document_compilation: assertRequestCompilation,
      accept_document_compilation: assertAcceptCompilation,
      publish_document_view: assertPublishDocumentView,
      record_document_proposal: assertRecordProposal,
      apply_document_proposal: assertApplyProposal,
    },
  };
}

export interface DocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly documentNumber: string;
  readonly revision: string;
  readonly documentClass: string;
  readonly lifecycleState: string;
  readonly rowVersion: string;
  readonly mediaType: string | null;
  readonly sha256: string | null;
  readonly atomCount: number;
}

export interface DocumentDetail extends DocumentSummary {
  readonly owningRole: string;
  readonly contentVersionId: string | null;
  readonly sizeBytes: number | null;
  readonly parser: string | null;
  readonly parserVersion: string | null;
  readonly contentDigest: string | null;
  readonly atoms: readonly DocumentAtom[];
}

export async function listDocuments(tx: Tx): Promise<DocumentSummary[]> {
  const rows = await tx.query<{
    id: string;
    title: string;
    document_number: string;
    revision: string;
    document_class: string;
    lifecycle_state: string;
    row_version: string;
    media_type: string | null;
    sha256: string | null;
    atom_count: string;
  }>(
    `select o.id, o.title, d.document_number, d.revision, d.document_class,
            o.lifecycle_state, o.row_version, v.media_type, v.sha256,
            (select count(*)::text from content.document_atom a where a.parse_id = p.id)
              as atom_count
       from core.object o
       join quality.controlled_document d on d.id = o.id
       left join content.artifact_version v on v.id = d.content_version
       left join content.document_parse p on p.artifact_version_id = v.id
      order by d.document_number, d.revision desc`,
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    documentNumber: row.document_number,
    revision: row.revision,
    documentClass: row.document_class,
    lifecycleState: row.lifecycle_state,
    rowVersion: row.row_version,
    mediaType: row.media_type,
    sha256: row.sha256,
    atomCount: Number(row.atom_count),
  }));
}

export async function getDocument(tx: Tx, id: string): Promise<DocumentDetail | undefined> {
  const row = await tx.maybeOne<{
    id: string;
    title: string;
    document_number: string;
    revision: string;
    document_class: string;
    lifecycle_state: string;
    row_version: string;
    owning_role: string;
    content_version_id: string | null;
    media_type: string | null;
    sha256: string | null;
    size_bytes: string | null;
    parser: string | null;
    parser_version: string | null;
    content_digest: string | null;
    atom_count: string;
    parse_id: string | null;
  }>(
    `select o.id, o.title, d.document_number, d.revision, d.document_class,
            o.lifecycle_state, o.row_version, d.owning_role, d.content_version as content_version_id,
            v.media_type, v.sha256,
            v.size_bytes, p.parser, p.parser_version, p.content_digest,
            (select count(*)::text from content.document_atom a where a.parse_id = p.id)
              as atom_count,
            p.id as parse_id
       from core.object o
       join quality.controlled_document d on d.id = o.id
       left join content.artifact_version v on v.id = d.content_version
       left join content.document_parse p on p.artifact_version_id = v.id
      where o.id = $1`,
    [id],
  );
  if (row === undefined) return undefined;
  const atoms =
    row.parse_id === null
      ? []
      : await tx.query<{
          ordinal: number;
          atom_kind: DocumentAtomKind;
          heading_level: number | null;
          text_content: string;
          attributes: Record<string, JsonValue>;
          atom_digest: string;
        }>(
          `select ordinal, atom_kind, heading_level, text_content, attributes, atom_digest
             from content.document_atom where parse_id = $1 order by ordinal`,
          [row.parse_id],
        );
  return {
    id: row.id,
    title: row.title,
    documentNumber: row.document_number,
    revision: row.revision,
    documentClass: row.document_class,
    lifecycleState: row.lifecycle_state,
    rowVersion: row.row_version,
    owningRole: row.owning_role,
    contentVersionId: row.content_version_id,
    mediaType: row.media_type,
    sha256: row.sha256,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    parser: row.parser,
    parserVersion: row.parser_version,
    contentDigest: row.content_digest,
    atomCount: Number(row.atom_count),
    atoms: atoms.map((atom) => ({
      ordinal: atom.ordinal,
      kind: atom.atom_kind,
      level: atom.heading_level,
      text: atom.text_content,
      attributes: atom.attributes,
      digest: atom.atom_digest,
    })),
  };
}

export const PACKAGE = {
  name: '@kf/documents',
  role: 'Document parsing, composition, and controlled-document action atoms',
  owns: [],
} as const;
