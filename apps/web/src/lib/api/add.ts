import {
  apiBaseUrl,
  callerHeaders,
  decodeSuccessfulResponse,
  parseResponse,
  type Caller,
} from './client';
import { CaptureInputRefused, classificationsUpTo, parseIngestOutcome } from './capture';

/**
 * Adding files (`/add`): each file is one `POST /ingest` — the path the capture page's photos and
 * voice notes take — scanned for what never enters the Fabric, stored content-addressed, verified
 * and recorded by `attach_evidence` as the signed-in person. One act per file. Nothing here
 * decides whether a file may be kept; the API does, and its refusal comes back with its code.
 *
 * A controlled document — with a number, a revision, a class and an owning role — is still added
 * on the Documents page. This is for everything else a person has.
 */

/** Per file: what the web's server-action limit leaves room for after the form's framing. */
export const MAX_ADD_FILE_BYTES = 10 * 1024 * 1024;

/** The record's own title limit (`core.object`: 1 to 240 characters). */
const TITLE_MAX = 240;

const DOCUMENT_TYPES = [
  /^text\//,
  /^application\/pdf$/,
  /^application\/msword$/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/vnd\.oasis\.opendocument\./,
  /^application\/rtf$/,
];

const BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  json: 'application/json',
};

/** The media type the browser stated, else one from the extension, else a plain octet stream. */
export function mediaTypeOf(name: string, stated: string): string {
  const type = (stated.split(';')[0] ?? '').trim().toLowerCase();
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) return type;
  const extension = name.toLowerCase().split('.').pop() ?? '';
  return BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** `document` for what the parser reads as text, `other` for everything else. */
export function artifactKindOf(mediaType: string): 'document' | 'other' {
  return DOCUMENT_TYPES.some((pattern) => pattern.test(mediaType)) ? 'document' : 'other';
}

/** The record's title: the file's name, whitespace collapsed, within the record's limit. */
export function titleOf(name: string): string {
  const title = [...name]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (title === '') return 'Untitled file';
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
}

export interface AddFileInput {
  readonly name: string;
  readonly statedType: string;
  readonly bytes: Uint8Array;
  readonly classification: string;
  readonly note: string;
}

/**
 * Checks the web can make before sending anything, each with the code the API would use for the
 * same refusal where it has one. Passing them is not permission: the API repeats every check.
 */
export function addFileProblem(
  input: Pick<AddFileInput, 'bytes' | 'classification'>,
  ceiling: string,
): { readonly code: string; readonly message: string } | undefined {
  if (input.bytes.byteLength === 0) {
    return { code: 'empty_file', message: 'the file is empty' };
  }
  if (input.bytes.byteLength > MAX_ADD_FILE_BYTES) {
    return { code: 'file_too_large', message: 'the file is larger than 10 MB' };
  }
  if (!classificationsUpTo(ceiling).includes(input.classification)) {
    return {
      code: 'classification_not_granted',
      message: 'the classification is above what this session may create',
    };
  }
  return undefined;
}

/** The `POST /ingest` body for one added file, spelled as the route spells it. */
export function addRequestBody(input: AddFileInput): Record<string, unknown> {
  if (input.note.length > 2000) throw new CaptureInputRefused('The note is over 2000 characters.');
  const mediaType = mediaTypeOf(input.name, input.statedType);
  return {
    title: titleOf(input.name),
    artifactKind: artifactKindOf(mediaType),
    classification: input.classification,
    mediaType,
    contentBase64: Buffer.from(input.bytes).toString('base64'),
    // No key is sent: the API forms one from the person, the bytes' digest and the title, so the
    // same file added again by the same person replays the first act rather than repeating it.
    ...(input.note.trim() === '' ? {} : { reason: input.note.trim() }),
  };
}

export async function addFile(
  input: AddFileInput,
  caller: Caller,
): Promise<{ artifactId: string; replayed: boolean }> {
  const response = await fetch(`${apiBaseUrl()}/ingest`, {
    method: 'POST',
    headers: callerHeaders(caller),
    body: JSON.stringify(addRequestBody(input)),
    cache: 'no-store',
  });
  return decodeSuccessfulResponse(await parseResponse(response), parseIngestOutcome);
}
