import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  addFileProblem,
  addRequestBody,
  artifactKindOf,
  MAX_ADD_FILE_BYTES,
  mediaTypeOf,
  titleOf,
} from '../../lib/api/add';
import { AddResults } from './add-results';
import { plainReason, type AddOutcome } from './result';

const ARTIFACT = '019ff405-2ec7-736e-898a-1f5687a80a48';

describe('/add lists what happened to each file', () => {
  const outcomes: AddOutcome[] = [
    { status: 'added', name: 'bench-notes.txt', artifactId: ARTIFACT, replayed: false },
    {
      status: 'refused',
      name: 'deploy-key.txt',
      code: 'content_refused',
      reason: plainReason('content_refused', 'private key (line 1)'),
    },
  ];
  const html = renderToStaticMarkup(createElement(AddResults, { outcomes }));

  it('links an added file to its record', () => {
    expect(html).toContain('data-add-status="added"');
    expect(html).toContain('bench-notes.txt');
    expect(html).toContain(`href="/objects/${ARTIFACT}"`);
  });

  it('gives a refused file its reason in plain words and keeps the code', () => {
    expect(html).toContain('data-add-status="refused"');
    expect(html).toContain('data-refusal="content_refused"');
    expect(html).toContain('deploy-key.txt</strong> was not added.');
    expect(html).toContain('such as a password, a private key, or bank or tax details');
    expect(html).toContain('(content_refused)');
    expect(html).toContain('1 added, 1 not added');
  });

  it('renders nothing before anything was sent', () => {
    expect(renderToStaticMarkup(createElement(AddResults, { outcomes: [] }))).toBe('');
  });
});

describe('an added file is one ingest of the file alone', () => {
  const bytes = new TextEncoder().encode('torque 4.2 Nm');

  it('asks for no document number, class or owning role, and leaves the replay key to the API', () => {
    const body = addRequestBody({
      name: 'bench notes.txt',
      statedType: '',
      bytes,
      classification: 'internal',
      note: '  from the AV-3000 bench ',
    });
    expect(Object.keys(body).sort()).toEqual(
      ['artifactKind', 'classification', 'contentBase64', 'mediaType', 'reason', 'title'].sort(),
    );
    expect(body['title']).toBe('bench notes.txt');
    expect(body['mediaType']).toBe('text/plain');
    expect(body['artifactKind']).toBe('document');
    expect(body['reason']).toBe('from the AV-3000 bench');
    expect(Buffer.from(String(body['contentBase64']), 'base64').toString()).toBe('torque 4.2 Nm');
  });

  it('refuses before sending what the API would refuse anyway, with the API’s code', () => {
    expect(addFileProblem({ bytes, classification: 'confidential' }, 'internal')?.code).toBe(
      'classification_not_granted',
    );
    expect(
      addFileProblem({ bytes: new Uint8Array(), classification: 'public' }, 'internal')?.code,
    ).toBe('empty_file');
    expect(
      addFileProblem(
        { bytes: new Uint8Array(MAX_ADD_FILE_BYTES + 1), classification: 'public' },
        'internal',
      )?.code,
    ).toBe('file_too_large');
    expect(addFileProblem({ bytes, classification: 'internal' }, 'internal')).toBeUndefined();
  });

  it('names and types a file from what it is', () => {
    expect(titleOf('  a\u0000b\tc.pdf ')).toBe('a b c.pdf');
    expect(titleOf('x'.repeat(300))).toHaveLength(240);
    expect(titleOf('   ')).toBe('Untitled file');
    expect(mediaTypeOf('scan.PDF', '')).toBe('application/pdf');
    expect(mediaTypeOf('photo.jpg', 'image/jpeg')).toBe('image/jpeg');
    expect(mediaTypeOf('blob', '')).toBe('application/octet-stream');
    expect(artifactKindOf('image/jpeg')).toBe('other');
    expect(artifactKindOf('text/markdown')).toBe('document');
  });
});
