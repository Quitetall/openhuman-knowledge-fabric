import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseObjectView } from '../../../lib/api/object-views.js';
import { formatSize } from './artifact-panel.js';
import { ObjectViewContent } from './object-view-content.js';

const PDF = '01a0d661-9046-7739-a1a9-789267c99d1a';
const TEXT = '01a0d661-935b-70eb-a39c-27f09ed5ad0a';

function member(objectId: string, title: string, mediaType: string, label: string | null) {
  return {
    objectId,
    objectType: 'artifact',
    classification: 'internal',
    contentDigest: 'd'.repeat(64),
    itemState: 'included',
    title,
    content: {
      'content.artifact_version': [
        {
          sha256: 'ab'.repeat(32),
          media_type: mediaType,
          size_bytes: 5822,
          version_no: 1,
          revision_label: label,
        },
      ],
    },
  };
}

function view(subject: ReturnType<typeof member>, related: ReturnType<typeof member>) {
  return parseObjectView({
    result: {
      projectionDigest: 'p'.repeat(64),
      source: { corpusDigest: 'c'.repeat(64) },
      sections: [
        { id: 'subject', members: [subject] },
        { id: 'relationships', members: [related] },
      ],
      edges: [{ sourceId: TEXT, targetId: PDF, relationType: 'derived_from' }],
    },
    facets: {},
  });
}

const pdf = member(PDF, 'Suspension notice', 'application/pdf', null);
const text = member(
  TEXT,
  'Suspension notice — extracted text',
  'text/plain',
  'extracted:pdftotext',
);

describe('artifact file panel', () => {
  it('offers the PDF to open and download, and shows its extracted text as machine output', () => {
    const v = view(pdf, text);
    const html = renderToStaticMarkup(
      createElement(ObjectViewContent, {
        view: v,
        artifact: {
          file: {
            mediaType: 'application/pdf',
            sizeBytes: 5822,
            sha256: 'ab'.repeat(32),
            versionNo: 1,
            revisionLabel: null,
          },
          derivation: { extractedTextId: TEXT },
          text: {
            kind: 'shown',
            artifactId: TEXT,
            text: 'Objet : suspension <du contrat>',
            truncated: false,
            limitBytes: 204_800,
          },
        },
      }),
    );
    expect(html).toContain(`href="/documents/${PDF}/source?disposition=inline"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain(`href="/documents/${PDF}/source"`);
    expect(html).toContain('application/pdf');
    expect(html).toContain('5,822 bytes (5.7 KiB)');
    expect(html).toContain('abababababababab…');
    expect(html).toContain('as received');
    expect(html).toContain(`href="/objects/${TEXT}"`);
    expect(html).toContain('Suspension notice — extracted text');
    expect(html).toContain('extracted by machine');
    // Text is rendered as text, never as markup.
    expect(html).toContain('Objet : suspension &lt;du contrat&gt;');
  });

  it('links a text artifact back to the PDF it was extracted from', () => {
    const html = renderToStaticMarkup(
      createElement(ObjectViewContent, {
        view: view(text, pdf),
        artifact: {
          derivation: { extractedFromId: PDF },
          text: { kind: 'unavailable', artifactId: TEXT, reason: 'Access denied' },
        },
      }),
    );
    expect(html).toContain('Extracted from');
    expect(html).toContain(`href="/objects/${PDF}"`);
    expect(html).toContain('The text could not be shown: Access denied');
    expect(html).toContain('No retained file version is visible');
  });

  it('leaves the generic projection alone when there is no artifact data', () => {
    const html = renderToStaticMarkup(createElement(ObjectViewContent, { view: view(pdf, text) }));
    expect(html).not.toContain('data-artifact-panel');
    expect(html).toContain('Relationships');
  });

  it('states sizes exactly, with a readable unit above a kibibyte', () => {
    expect(formatSize(512)).toBe('512 bytes');
    expect(formatSize(204_800)).toBe('204,800 bytes (200.0 KiB)');
    expect(formatSize(3 * 1024 * 1024)).toBe('3,145,728 bytes (3.0 MiB)');
  });
});
