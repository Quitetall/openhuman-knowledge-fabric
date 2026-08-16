import { digestOf } from '@kf/artifacts';
import { mediaTypeForDocumentFile } from '@kf/documents';
import type { DocumentImportBody, ParsedDocumentImport } from './contracts.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function required(body: DocumentImportBody, key: keyof DocumentImportBody): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${String(key)} is required`);
  }
  return value;
}

function decodeBase64(value: string): Buffer {
  if (value.length > Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4) {
    throw new TypeError('document exceeds 10 MiB limit');
  }
  if (value.length % 4 !== 0) throw new TypeError('contentBase64 is not valid base64');
  const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const contentLength = value.length - paddingBytes;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!valid) throw new TypeError('contentBase64 is not valid base64');
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value[index] !== '=') throw new TypeError('contentBase64 is not valid base64');
  }
  if (contentLength === 0 && paddingBytes > 0) {
    throw new TypeError('contentBase64 is not valid base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new TypeError('contentBase64 is not valid base64');
  }
  if (bytes.length === 0) throw new TypeError('document source is empty');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new TypeError('document exceeds 10 MiB limit');
  return bytes;
}

function importStableKey(organizationId: string, documentNumber: string): string {
  // Match PostgreSQL's controlled-document identity exactly. Normalizing only this key would
  // merge document numbers that the authoritative table correctly treats as distinct facts.
  const documentIdentity = digestOf(Buffer.from(documentNumber, 'utf8'));
  return `document-import:${organizationId}:${documentIdentity}`;
}

export function parseDocumentImport(
  body: DocumentImportBody,
  organizationId: string,
): ParsedDocumentImport {
  const title = required(body, 'title');
  const documentNumber = required(body, 'documentNumber');
  const revision = required(body, 'revision');
  const documentClass = required(body, 'documentClass');
  const owningRole = required(body, 'owningRole');
  const fileName = required(body, 'fileName');
  const declaredMediaType = required(body, 'mediaType');
  const mediaType = mediaTypeForDocumentFile(fileName, declaredMediaType);
  const idempotencyKey = required(body, 'idempotencyKey');
  if (idempotencyKey.length < 8 || idempotencyKey.length > 96) {
    throw new TypeError('idempotencyKey must contain 8 to 96 characters');
  }
  if (mediaType === undefined) {
    throw new TypeError(
      `file ${JSON.stringify(fileName)} with media type ${JSON.stringify(declaredMediaType)} is not parseable`,
    );
  }
  const bytes = decodeBase64(required(body, 'contentBase64'));
  const sha256 = digestOf(bytes);
  return {
    title,
    documentNumber,
    revision,
    documentClass,
    owningRole,
    fileName,
    mediaType,
    idempotencyKey,
    bytes,
    sha256,
    storageKey: `document-imports/${sha256}`,
    stableKey: importStableKey(organizationId, documentNumber),
  };
}
