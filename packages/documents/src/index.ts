/**
 * Document composition.
 *
 * Source bytes remain one immutable artifact version. Parsing produces ordered atoms with
 * independent digests; those atoms are disposable projections rebuildable from source bytes.
 */

import { spawn } from 'node:child_process';
import type { ActionEffect, ActionMaterializer, PreconditionCheck } from '@kf/actions';
import { recordVersion, verifyUpload, type ObjectStore, type VerifiedUpload } from '@kf/artifacts';
import { digest, type JsonValue } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import {
  createControlledObject,
  optionalString,
  requireInteger,
  requireString,
} from '@kf/record-atoms';

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
      walkBlocks(block.c[1], atoms, listDepth);
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

  return {
    name: 'documents',
    materializers: {
      attach_evidence: attachEvidence,
      add_controlled_document: addControlledDocument,
    },
    effects: { attach_evidence: recordEvidence },
    preconditions: {},
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
            o.lifecycle_state, o.row_version, d.owning_role, v.media_type, v.sha256,
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
