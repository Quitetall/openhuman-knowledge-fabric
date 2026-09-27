// A corpus of files (DRBench, TheAgentCompany) as the loader sees it: each file ingested as
// itself, and — where KF cannot parse it — followed by the text extracted from it, which names
// the original through `derived_from` (extract-files.mjs wrote both into the manifest).

import path from 'node:path';

/**
 * KF's object title limit (core.object: 1 to 240 characters). The ingest route refuses a longer
 * title with 400 `invalid_ingest` rather than shortening it, so a longer title is cut here, where
 * the loader knows what it is cutting, keeping `suffix` whole.
 */
export const TITLE_MAX = 240;
export function fitTitle(title, suffix = '') {
  const room = TITLE_MAX - suffix.length;
  const head = title.trim();
  return (head.length <= room ? head : `${head.slice(0, room - 1).trimEnd()}…`) + suffix;
}

/**
 * `row` is a manifest file entry; `root` the directory its `path` is relative to; `dataDir`
 * the directory its `text.file` is relative to. `describe` gives the corpus's own wording.
 */
export function loadableFile(row, { root, dataDir, classification, readers, describe }) {
  const d = describe(row);
  const loadable = {
    key: row.key,
    title: fitTitle(d.title),
    classification,
    artifactKind: d.artifactKind,
    mediaType: row.mediaType,
    file: path.join(root, row.path),
    sha256: row.sha256,
    readers,
    reason: d.reason,
    grantReason: d.grantReason,
  };
  if (row.text !== null && row.text !== undefined) {
    loadable.derived = {
      title: fitTitle(d.title, ' — extracted text'),
      mediaType: 'text/markdown',
      file: path.join(dataDir, row.text.file),
      sha256: row.text.sha256,
      revisionLabel: `extracted:${row.text.method}`.slice(0, 128),
      reason: `Text extracted from ${row.path} by fixtures/lib/extract-text.mjs (${row.text.method}); the original remains the record`,
    };
  }
  return loadable;
}
