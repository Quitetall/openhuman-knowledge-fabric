import { describe, expect, it } from 'vitest';
import {
  assertPermissionDigest,
  buildWithheldLedger,
  comparePermissionSet,
  compileMasterRecord,
  relevanceClosure,
  type PermissionMember,
} from './master-record.js';
import {
  renderMasterRecord,
  renderMasterRecordHtml,
  renderMasterRecordMarkdown,
} from './master-record-renderer.js';

const member = (objectId: string, organizationId = 'org-a'): PermissionMember => ({
  objectId,
  objectType: 'document',
  organizationId,
  classification: 'internal',
  contentDigest: objectId.padStart(64, '0').slice(-64),
});

describe('master-record permission invariant', () => {
  it('reports over-disclosure and under-disclosure separately', () => {
    const permitted = [member('a'), member('b')];
    const compiled = [member('a'), member('c')];
    const result = comparePermissionSet(permitted, compiled);
    expect(result.equal).toBe(false);
    expect(result.overDisclosure.map((row) => row.objectId)).toEqual(['c']);
    expect(result.underDisclosure.map((row) => row.objectId)).toEqual(['b']);
  });

  it('accepts a positive control regardless of input order', () => {
    const result = comparePermissionSet([member('b'), member('a')], [member('a'), member('b')]);
    expect(result).toMatchObject({ equal: true, overDisclosure: [], underDisclosure: [] });
  });

  it('refuses stale manifests', () => {
    const compiled = compileMasterRecord({
      personId: 'person-a',
      organizationId: 'org-a',
      permitted: [member('a')],
      relevantIds: new Set(['person-a', 'a']),
      compiledAt: '2026-08-26T00:00:00.000Z',
    });
    expect(() => assertPermissionDigest(compiled.manifest, [member('b')])).toThrow(/stale/);
  });
});

describe('relevance closure', () => {
  it('uses person-anchor policy only for first hop, then follows composition descendants', () => {
    const ids = relevanceClosure(
      'person',
      [
        { sourceId: 'person', targetId: 'project', relationType: 'assigned_to' },
        { sourceId: 'project', targetId: 'part', relationType: 'contains' },
      ],
      [
        {
          relationType: 'assigned_to',
          personAnchor: true,
          propagationClass: 'composition_down',
          anchorDepth: 8,
        },
        {
          relationType: 'contains',
          personAnchor: false,
          propagationClass: 'composition_down',
          anchorDepth: 8,
        },
      ],
    );
    expect([...ids].sort()).toEqual(['part', 'person', 'project']);
  });

  it('terminates on a provenance cycle', () => {
    const ids = relevanceClosure(
      'person',
      [
        { sourceId: 'person', targetId: 'a', relationType: 'derived_from' },
        { sourceId: 'a', targetId: 'b', relationType: 'derived_from' },
        { sourceId: 'b', targetId: 'a', relationType: 'derived_from' },
      ],
      [
        {
          relationType: 'derived_from',
          personAnchor: true,
          propagationClass: 'provenance_backward',
          anchorDepth: 8,
        },
      ],
    );
    expect([...ids].sort()).toEqual(['a', 'b', 'person']);
  });

  it('walks full composition subtree after the bounded person anchor', () => {
    const edges = [
      { sourceId: 'person', targetId: 'root', relationType: 'assigned_to' },
      ...Array.from({ length: 12 }, (_, index) => ({
        sourceId: index === 0 ? 'root' : `part-${index - 1}`,
        targetId: `part-${index}`,
        relationType: 'contains',
      })),
    ];
    const ids = relevanceClosure('person', edges, [
      {
        relationType: 'assigned_to',
        personAnchor: true,
        propagationClass: 'composition_down',
        anchorDepth: 1,
      },
      {
        relationType: 'contains',
        personAnchor: false,
        propagationClass: 'composition_down',
        anchorDepth: 1,
      },
    ]);
    expect(ids.has('part-11')).toBe(true);
  });

  it('walks provenance from a derived anchor to its source', () => {
    const ids = relevanceClosure(
      'person',
      [
        { sourceId: 'person', targetId: 'derived', relationType: 'derived_from' },
        { sourceId: 'derived', targetId: 'source', relationType: 'derived_from' },
      ],
      [
        {
          relationType: 'derived_from',
          personAnchor: true,
          propagationClass: 'provenance_backward',
          anchorDepth: 8,
        },
      ],
    );
    expect([...ids].sort()).toEqual(['derived', 'person', 'source']);
  });

  it('refuses an edge whose relation policy is missing', () => {
    expect(() =>
      relevanceClosure(
        'person',
        [{ sourceId: 'person', targetId: 'record', relationType: 'unregistered' }],
        [],
      ),
    ).toThrow(/missing relevance policy/);
  });
});

describe('withheld reporting policy', () => {
  it('enumerates legal holds but exposes third-party material as counts only', () => {
    const ledger = buildWithheldLedger(
      [
        {
          objectId: 'held-1',
          reasonClass: 'legal_hold',
          reason: 'litigation hold',
          authorizer: 'authority-1',
          withheldAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      ['third_party', 'third_party'],
    );
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]!.reason).toBe('litigation hold');
    expect(ledger.thirdPartyCounts).toEqual({ third_party: 2 });
    expect(JSON.stringify(ledger)).not.toContain('third-party-object');
  });
});

describe('organization boundary', () => {
  it('does not stitch a second organization into one record', () => {
    expect(() =>
      compileMasterRecord({
        personId: 'person-a',
        organizationId: 'org-a',
        permitted: [member('a'), member('b', 'org-b')],
        relevantIds: new Set(['a', 'b']),
      }),
    ).toThrow(/cannot stitch organizations/);
  });
});

describe('master-record renderings', () => {
  const compilation = compileMasterRecord({
    personId: 'person-a',
    organizationId: 'org-a',
    permitted: [
      { ...member('z'), title: 'Org <shared>' },
      { ...member('a'), title: 'Own *document*' },
    ],
    relevantIds: new Set(['person-a', 'a']),
    withdrawn: [member('withdrawn')],
    withheld: buildWithheldLedger(
      [
        {
          objectId: 'held-1',
          reasonClass: 'legal_hold',
          reason: 'litigation hold',
          authorizer: 'authority-1',
          withheldAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      ['supplier identity'],
    ),
    compiledAt: '2026-08-26T00:00:00.000Z',
  });

  it('renders all membership sections deterministically', () => {
    const markdown = renderMasterRecordMarkdown(compilation);
    expect(markdown).toContain('## Your record');
    expect(markdown).toContain('## Organization view');
    expect(markdown).toContain('## Withdrawn');
    expect(markdown).toContain('third\\_party');
    expect(markdown.indexOf('Own \\*document\\*')).toBeGreaterThan(-1);
  });

  it('escapes HTML and does not turn titles or reasons into markup', () => {
    const html = renderMasterRecordHtml(compilation);
    expect(html).toContain('Org &lt;shared&gt;');
    expect(html).not.toContain('<shared>');
    expect(html).toContain('Own *document*');
  });

  it('refuses a rendering that silently drops an included member', () => {
    expect(() => renderMasterRecordMarkdown({ ...compilation, relevant: [] })).toThrow(
      /sections do not cover every included member/,
    );
  });

  it('derives PDF and DOCX from the same Markdown source through bounded Pandoc', async () => {
    const [pdf, docx] = await Promise.all([
      renderMasterRecord(compilation, 'pdf'),
      renderMasterRecord(compilation, 'docx'),
    ]);
    expect(pdf.bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(docx.bytes.subarray(0, 2).toString('ascii')).toBe('PK');
    expect(pdf.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(docx.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
