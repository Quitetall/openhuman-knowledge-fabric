import { getDocumentDownload } from './document-operations';
import type { Caller } from './client';
import type { ObjectView, ObjectViewMember } from './object-views';
import { nonNegativeInteger, record } from './validation';

/**
 * An artifact's retained file, as its Object View states it: the newest `artifact_version` row.
 * Read from the projection the API already authorized, never from the object store.
 */
export interface ArtifactFile {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly versionNo: number;
  /** How this version was made, e.g. `extracted:pdftotext`; null for a file as received. */
  readonly revisionLabel: string | null;
}

export function artifactFile(member: ObjectViewMember): ArtifactFile | undefined {
  if (member.objectType !== 'artifact') return undefined;
  const rows = member.content?.['content.artifact_version'];
  const versions = (Array.isArray(rows) ? rows : [rows])
    .map(record)
    .filter((row): row is Record<string, unknown> => row !== undefined)
    .filter(
      (row) =>
        typeof row['media_type'] === 'string' &&
        typeof row['sha256'] === 'string' &&
        nonNegativeInteger(row['size_bytes']) &&
        nonNegativeInteger(row['version_no']),
    )
    .map((row) => ({
      mediaType: String(row['media_type']),
      sizeBytes: Number(row['size_bytes']),
      sha256: String(row['sha256']),
      versionNo: Number(row['version_no']),
      revisionLabel: typeof row['revision_label'] === 'string' ? row['revision_label'] : null,
    }));
  if (versions.length === 0) return undefined;
  return versions.reduce((newest, version) =>
    version.versionNo > newest.versionNo ? version : newest,
  );
}

/**
 * The extraction pair around an artifact. Extracted text is its own artifact with a `derived_from`
 * edge to the file it came from (text → original), so the subject's text is the source of an
 * inbound edge and its original is the target of an outbound one.
 */
export interface ArtifactDerivation {
  readonly extractedTextId?: string;
  readonly extractedFromId?: string;
}

export function artifactDerivation(view: ObjectView): ArtifactDerivation {
  const id = view.subject.objectId;
  const derived = view.edges.filter((edge) => edge.relationType === 'derived_from');
  const extractedTextId = derived.find((edge) => edge.targetId === id)?.sourceId;
  const extractedFromId = derived.find((edge) => edge.sourceId === id)?.targetId;
  return {
    ...(extractedTextId === undefined ? {} : { extractedTextId }),
    ...(extractedFromId === undefined ? {} : { extractedFromId }),
  };
}

/** Enough to read any extraction in the corpus through; a longer one is cut and says so. */
export const ARTIFACT_TEXT_LIMIT_BYTES = 200 * 1024;

export interface ArtifactText {
  readonly text: string;
  readonly truncated: boolean;
}

export function isPlainText(mediaType: string | null): boolean {
  return mediaType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/plain';
}

/**
 * Read an artifact's text through the API's source route — the same authorized read a download
 * is — keeping at most `limit` bytes. Refuses anything the API does not label `text/plain`, so a
 * page never renders a binary as characters.
 */
export async function getArtifactText(
  id: string,
  caller: Caller,
  limit = ARTIFACT_TEXT_LIMIT_BYTES,
): Promise<ArtifactText> {
  const response = await getDocumentDownload(`/documents/${encodeURIComponent(id)}/source`, caller);
  if (!isPlainText(response.headers.get('content-type'))) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('artifact is not plain text');
  }
  const decoder = new TextDecoder('utf-8');
  if (response.body === null) return { text: '', truncated: false };
  const reader = response.body.getReader();
  let text = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    const room = limit - received;
    if (value.byteLength > room) {
      // Streamed decoding holds back a character split at the cut rather than inventing one.
      text += decoder.decode(value.subarray(0, room), { stream: true });
      await reader.cancel().catch(() => undefined);
      return { text, truncated: true };
    }
    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}
