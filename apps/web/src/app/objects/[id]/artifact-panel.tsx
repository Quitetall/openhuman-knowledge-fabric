/**
 * The file behind an artifact, on its Object View: what it is, how to open it, and — when the
 * corpus holds one — the text extracted from it.
 *
 * Every byte shown here came through the API's source route under the viewer's own context, the
 * same read a download is; the panel adds no access of its own. Extracted text is labelled as
 * machine output every time it appears, because a reader quoting it as the record would be
 * quoting pdftotext or OCR, not the document that was signed.
 */

import type { ArtifactDerivation, ArtifactFile, ObjectView } from '../../../lib/api';

export type ArtifactTextOutcome =
  | {
      readonly kind: 'shown';
      readonly artifactId: string;
      readonly text: string;
      readonly truncated: boolean;
      readonly limitBytes: number;
    }
  | { readonly kind: 'unavailable'; readonly artifactId: string; readonly reason: string };

export interface ArtifactPanelData {
  readonly file?: ArtifactFile;
  readonly derivation: ArtifactDerivation;
  readonly text?: ArtifactTextOutcome;
}

const INLINE_MEDIA_TYPES = new Set(['application/pdf', 'text/plain']);

/** Bytes as the exact count plus a readable size; the exact count is what a checksum covers. */
export function formatSize(bytes: number): string {
  const exact = `${bytes.toLocaleString('en-GB')} bytes`;
  if (bytes < 1024) return exact;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${exact} (${value.toFixed(1)} ${units[unit]})`;
}

function titleOf(view: ObjectView, id: string): string {
  const member = view.relationships.find((candidate) => candidate.objectId === id);
  return member?.title ?? id;
}

export function ArtifactPanel({
  view,
  data,
}: {
  readonly view: ObjectView;
  readonly data: ArtifactPanelData;
}) {
  const id = view.subject.objectId;
  const encoded = encodeURIComponent(id);
  const { file, derivation, text } = data;
  const mediaType = file?.mediaType.split(';', 1)[0]?.trim().toLowerCase();
  const extracted =
    derivation.extractedTextId !== undefined || derivation.extractedFromId !== undefined;
  const originalId =
    derivation.extractedFromId ?? (derivation.extractedTextId === undefined ? undefined : id);

  return (
    <section aria-labelledby="artifact-file-heading" data-artifact-panel={id}>
      <h2 id="artifact-file-heading" style={{ fontSize: '1rem', marginTop: '2rem' }}>
        File
      </h2>
      {file === undefined ? (
        <p style={{ color: '#666' }}>No retained file version is visible for this artifact.</p>
      ) : (
        <dl
          style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.25rem 1rem' }}
        >
          <dt style={{ color: '#666', fontSize: '0.85rem' }}>Media type</dt>
          <dd style={{ margin: 0 }}>
            <code>{file.mediaType}</code>
          </dd>
          <dt style={{ color: '#666', fontSize: '0.85rem' }}>Size</dt>
          <dd style={{ margin: 0 }}>{formatSize(file.sizeBytes)}</dd>
          <dt style={{ color: '#666', fontSize: '0.85rem' }}>SHA-256</dt>
          <dd style={{ margin: 0 }}>
            <code title={file.sha256}>{file.sha256.slice(0, 16)}…</code>
          </dd>
          <dt style={{ color: '#666', fontSize: '0.85rem' }}>Revision</dt>
          <dd style={{ margin: 0 }}>
            {file.revisionLabel === null ? 'as received' : <code>{file.revisionLabel}</code>} ·
            version {file.versionNo}
          </dd>
        </dl>
      )}
      <p style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', margin: '0.75rem 0 0' }}>
        {mediaType !== undefined && INLINE_MEDIA_TYPES.has(mediaType) ? (
          <a
            href={`/documents/${encoded}/source?disposition=inline`}
            target="_blank"
            rel="noopener noreferrer"
            data-artifact-link="open"
          >
            Open
          </a>
        ) : null}
        <a href={`/documents/${encoded}/source`} data-artifact-link="download">
          Download
        </a>
      </p>

      {derivation.extractedTextId === undefined ? null : (
        <p style={{ margin: '0.75rem 0 0' }} data-artifact-derivation="extracted-text">
          Extracted text:{' '}
          <a href={`/objects/${encodeURIComponent(derivation.extractedTextId)}`}>
            {titleOf(view, derivation.extractedTextId)}
          </a>
        </p>
      )}
      {derivation.extractedFromId === undefined ? null : (
        <p style={{ margin: '0.75rem 0 0' }} data-artifact-derivation="extracted-from">
          Extracted from:{' '}
          <a href={`/objects/${encodeURIComponent(derivation.extractedFromId)}`}>
            {titleOf(view, derivation.extractedFromId)}
          </a>
        </p>
      )}

      {text === undefined ? null : (
        <section aria-labelledby="artifact-text-heading" data-artifact-text={text.kind}>
          <h2 id="artifact-text-heading" style={{ fontSize: '1rem', marginTop: '2rem' }}>
            {extracted ? 'Extracted text' : 'Text'}
          </h2>
          {extracted && originalId !== undefined ? (
            <p role="note" className="kf-status kf-status-warning">
              This text was extracted by machine and may contain errors. The record is the original
              file,{' '}
              <a href={`/objects/${encodeURIComponent(originalId)}`}>
                {originalId === id ? 'this artifact' : titleOf(view, originalId)}
              </a>
              .
            </p>
          ) : null}
          {text.kind === 'unavailable' ? (
            <p role="status" className="kf-status kf-status-neutral">
              The text could not be shown: {text.reason}
            </p>
          ) : (
            <>
              {text.truncated ? (
                <p role="status" className="kf-status kf-status-neutral">
                  Showing the first {Math.round(text.limitBytes / 1024)} KiB. Open or download the
                  text for the rest.
                </p>
              ) : null}
              {text.text === '' ? (
                <p role="status" className="kf-status kf-status-neutral">
                  The text is empty.
                </p>
              ) : null}
              <pre
                hidden={text.text === ''}
                style={{
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  maxHeight: '40rem',
                  overflowY: 'auto',
                  padding: '0.75rem',
                  border: '1px solid #cbd5e1',
                  borderRadius: '0.5rem',
                  background: '#f8fafc',
                  fontSize: '0.85rem',
                }}
              >
                {text.text}
              </pre>
            </>
          )}
        </section>
      )}
    </section>
  );
}
