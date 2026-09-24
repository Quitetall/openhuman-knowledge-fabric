import { describe, expect, it } from 'vitest';
import { recordVerification, UNVERIFIED_LABEL } from '@kf/domain';
import type { ProjectionDefinition } from '@kf/ontology-compiler';
import { bindParameters, project, ProjectionRefused } from './engine.js';
import { renderProjection } from './render.js';
import type { ProjectionCorpus, ProjectionGraph, ProjectionMember } from './types.js';

/**
 * The engine's two invariants — ⊆ master and coverage — hold by construction, so each is also
 * asserted here against inputs built to violate them, and the determinism that gives
 * `projectionDigest` its meaning is checked by re-running the same input.
 */

const member = (objectId: string, overrides: Partial<ProjectionMember> = {}): ProjectionMember => ({
  objectId,
  objectType: 'decision_record',
  organizationId: 'org-a',
  classification: 'internal',
  contentDigest: objectId.padStart(64, '0').slice(-64),
  itemState: 'included',
  verification: recordVerification(undefined),
  ...overrides,
});

const definition: ProjectionDefinition = {
  id: 'master_sections',
  title: 'Master record sections',
  version: 1,
  anchor: 'person',
  parameters: [],
  traverse: { relations: 'person_anchors', maxDepth: 8 },
  sections: [
    { id: 'withdrawn', title: 'Withdrawn', select: 'withdrawn' },
    { id: 'your_record', title: 'Your record', select: 'reached' },
    { id: 'org_view', title: 'Organization view', select: 'unreached' },
  ],
  remainder: { id: 'raw_corpus', title: 'Raw corpus' },
  sort: ['object_type', 'title', 'object_id'],
  budgets: { maxMembers: 1000 },
};

const graph: ProjectionGraph = {
  edges: [{ sourceId: 'person', targetId: 'a', relationType: 'produces' }],
  policies: [
    {
      relationType: 'produces',
      personAnchor: true,
      propagationClass: 'composition_down',
      anchorDepth: 8,
    },
    {
      relationType: 'affects',
      personAnchor: false,
      propagationClass: 'lateral_none',
      anchorDepth: 0,
    },
  ],
};

const corpus: ProjectionCorpus = {
  personId: 'person',
  organizationId: 'org-a',
  corpusDigest: 'c'.repeat(64),
  members: [
    member('b', { title: 'Unrelated' }),
    member('a', { title: 'Mine' }),
    member('w', {
      itemState: 'withdrawn',
      withdrawnAt: '2026-08-26T00:00:00.000Z',
      withdrawalReason: 'gone',
    }),
  ],
};

describe('project', () => {
  it('sections a corpus by reachability, in declared order, with the remainder last', () => {
    const result = project({ definition, parameters: {}, corpus, graph });
    expect(result.sections.map((s) => s.id)).toEqual([
      'withdrawn',
      'your_record',
      'org_view',
      'raw_corpus',
    ]);
    expect(result.sections[1]!.members.map((m) => m.objectId)).toEqual(['a']);
    expect(result.sections[2]!.members.map((m) => m.objectId)).toEqual(['b']);
    expect(result.sections[0]!.members.map((m) => m.objectId)).toEqual(['w']);
    expect(result.sections[3]!.members).toEqual([]);
    expect(result.measurements.memberCount).toBe(3);
    expect(result.measurements.reachedCount).toBe(1);
  });

  it('is deterministic: the same input yields the same digest and bytes, whatever the input order', () => {
    const shuffled: ProjectionCorpus = { ...corpus, members: [...corpus.members].reverse() };
    const first = project({ definition, parameters: {}, corpus, graph });
    const second = project({ definition, parameters: {}, corpus: shuffled, graph });
    expect(second.projectionDigest).toBe(first.projectionDigest);
    expect(renderProjection(second, 'json').contentDigest).toBe(
      renderProjection(first, 'json').contentDigest,
    );
  });

  it('changes digest when a member moves section, and not when nothing does', () => {
    const before = project({ definition, parameters: {}, corpus, graph });
    const moved = project({
      definition,
      parameters: {},
      corpus,
      graph: { ...graph, edges: [] },
    });
    expect(moved.sections[1]!.members).toEqual([]);
    expect(moved.projectionDigest).not.toBe(before.projectionDigest);
    expect(project({ definition, parameters: {}, corpus, graph }).projectionDigest).toBe(
      before.projectionDigest,
    );
  });

  it('puts what no section claims into the remainder rather than dropping it', () => {
    const narrow: ProjectionDefinition = {
      ...definition,
      sections: [{ id: 'only_a', title: 'Only a', select: 'reached' }],
    };
    const result = project({ definition: narrow, parameters: {}, corpus, graph });
    expect(result.sections.map((s) => s.id)).toEqual(['only_a', 'raw_corpus']);
    expect(result.sections[1]!.members.map((m) => m.objectId).sort()).toEqual(['b', 'w']);
    const placed = result.sections.reduce((n, s) => n + s.members.length, 0);
    expect(placed).toBe(corpus.members.length);
  });

  it('counts what the definition filter excludes rather than dropping it silently', () => {
    const narrowed: ProjectionDefinition = {
      ...definition,
      filter: { itemStates: ['included'] },
    };
    const result = project({ definition: narrowed, parameters: {}, corpus, graph });
    expect(result.measurements.corpusMemberCount).toBe(3);
    expect(result.measurements.memberCount).toBe(2);
    expect(result.measurements.excludedByFilter).toBe(1);
    const placed = result.sections.reduce((n, s) => n + s.members.length, 0);
    expect(placed + result.measurements.excludedByFilter).toBe(corpus.members.length);
  });

  it('refuses a member from another organization — a projection cannot stitch corpora', () => {
    const foreign: ProjectionCorpus = {
      ...corpus,
      members: [...corpus.members, member('x', { organizationId: 'org-b' })],
    };
    expect(() => project({ definition, parameters: {}, corpus: foreign, graph })).toThrow(
      ProjectionRefused,
    );
  });

  it('refuses over budget instead of truncating', () => {
    const tiny: ProjectionDefinition = { ...definition, budgets: { maxMembers: 2 } };
    expect(() => project({ definition: tiny, parameters: {}, corpus, graph })).toThrow(
      /Refusing rather than truncating/,
    );
  });

  it('treats an explicit relation list as a whitelist of what may seed relevance', () => {
    const explicit: ProjectionDefinition = {
      ...definition,
      traverse: { relations: ['affects'], maxDepth: 8 },
    };
    const result = project({ definition: explicit, parameters: {}, corpus, graph });
    // `produces` is a person anchor in the graph, but the definition did not name it.
    expect(result.sections[1]!.members).toEqual([]);
    expect(result.sections[2]!.members.map((m) => m.objectId).sort()).toEqual(['a', 'b']);
  });

  it('applies a section filter after its select, narrowing never widening', () => {
    const filtered: ProjectionDefinition = {
      ...definition,
      sections: [
        {
          id: 'restricted_only',
          title: 'x',
          select: 'all',
          filter: { classificationMax: 'public' },
        },
      ],
    };
    const result = project({ definition: filtered, parameters: {}, corpus, graph });
    expect(result.sections[0]!.members).toEqual([]);
    expect(result.sections[1]!.members).toHaveLength(3);
  });
});

describe('object-anchored readings', () => {
  const objectView: ProjectionDefinition = {
    id: 'object_view',
    title: 'Object view',
    version: 1,
    anchor: 'object',
    parameters: [{ name: 'object_id', type: 'uuid', required: true }],
    traverse: { relations: 'all', maxDepth: 1 },
    filter: { reachability: 'reached' },
    sections: [
      { id: 'subject', title: 'This record', select: 'anchor' },
      { id: 'relationships', title: 'Relationships', select: 'reached' },
    ],
    remainder: { id: 'other', title: 'Other' },
    sort: ['object_type', 'title', 'object_id'],
    budgets: { maxMembers: 5000 },
  };
  const A = '019ff405-2eca-7e77-96cb-00990ac6f24a';
  const B = '019ff405-2eca-7e77-96cb-00990ac6f24b';
  const C = '019ff405-2eca-7e77-96cb-00990ac6f24c';
  const D = '019ff405-2eca-7e77-96cb-00990ac6f24d';
  const neighbourhoodCorpus: ProjectionCorpus = {
    ...corpus,
    members: [member(A), member(B), member(C), member(D)],
  };
  // B -> A (backlink for A), A -> C (forward), C -> D (two hops away), and a lateral edge type.
  const neighbourhoodGraph: ProjectionGraph = {
    edges: [
      { sourceId: B, targetId: A, relationType: 'affects' },
      { sourceId: A, targetId: C, relationType: 'produces' },
      { sourceId: C, targetId: D, relationType: 'produces' },
    ],
    policies: graph.policies,
  };

  it('keeps the anchor and what touches it, in both directions, and nothing further', () => {
    const result = project({
      definition: objectView,
      parameters: { object_id: A },
      corpus: neighbourhoodCorpus,
      graph: neighbourhoodGraph,
    });
    expect(result.sections.map((s) => s.id)).toEqual(['subject', 'relationships', 'other']);
    expect(result.sections[0]!.members.map((m) => m.objectId)).toEqual([A]);
    // The backlink B and the forward link C; the lateral relation counts, policy notwithstanding.
    expect(result.sections[1]!.members.map((m) => m.objectId).sort()).toEqual([B, C]);
    expect(result.sections[2]!.members).toEqual([]);
    // D is two hops away: excluded by the reachability scope, and counted, not dropped.
    expect(result.measurements.excludedByFilter).toBe(1);
    expect(result.edges?.map((e) => e.relationType).sort()).toEqual(['affects', 'produces']);
  });

  it('refuses an anchor outside the reader corpus', () => {
    expect(() =>
      project({
        definition: objectView,
        parameters: { object_id: '019ff405-2eca-7e77-96cb-00990ac6f24e' },
        corpus: neighbourhoodCorpus,
        graph: neighbourhoodGraph,
      }),
    ).toThrow(/not in this reader's corpus/);
  });

  it('puts the crossed edges into the digest, so a new relation between existing members is a new reading', () => {
    // A -> B alongside the existing B -> A: membership is identical, only the edge set grows.
    // If edges were not in the digest this would be indistinguishable from the previous reading.
    const before = project({
      definition: objectView,
      parameters: { object_id: A },
      corpus: neighbourhoodCorpus,
      graph: neighbourhoodGraph,
    });
    const after = project({
      definition: objectView,
      parameters: { object_id: A },
      corpus: neighbourhoodCorpus,
      graph: {
        ...neighbourhoodGraph,
        edges: [
          ...neighbourhoodGraph.edges,
          { sourceId: A, targetId: B, relationType: 'produces' },
        ],
      },
    });
    expect(after.sections[1]!.members.map((m) => m.objectId).sort()).toEqual(
      before.sections[1]!.members.map((m) => m.objectId).sort(),
    );
    expect(after.edges?.length).toBe((before.edges?.length ?? 0) + 1);
    expect(after.projectionDigest).not.toBe(before.projectionDigest);
  });

  it('a new backlink is a new reading', () => {
    const before = project({
      definition: objectView,
      parameters: { object_id: A },
      corpus: neighbourhoodCorpus,
      graph: neighbourhoodGraph,
    });
    const after = project({
      definition: objectView,
      parameters: { object_id: A },
      corpus: neighbourhoodCorpus,
      graph: {
        ...neighbourhoodGraph,
        edges: [...neighbourhoodGraph.edges, { sourceId: D, targetId: A, relationType: 'affects' }],
      },
    });
    expect(after.sections[1]!.members.map((m) => m.objectId).sort()).toEqual([B, C, D]);
    expect(after.projectionDigest).not.toBe(before.projectionDigest);
  });
});

describe('bindParameters', () => {
  const withParam: ProjectionDefinition = {
    ...definition,
    id: 'agent_context',
    parameters: [{ name: 'token_budget', type: 'integer', required: true, minimum: 256 }],
  };

  it('refuses a missing required parameter', () => {
    expect(() => bindParameters(withParam, {})).toThrow(/requires parameter 'token_budget'/);
  });

  it('refuses an unknown parameter rather than ignoring it', () => {
    expect(() => bindParameters(withParam, { token_budget: 512, colour: 'red' })).toThrow(
      /declares no parameter 'colour'/,
    );
  });

  it('refuses an integer that is not safely representable', () => {
    expect(() => bindParameters(withParam, { token_budget: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      /safe integer/,
    );
  });

  it('refuses a value outside the declared range', () => {
    expect(() => bindParameters(withParam, { token_budget: 8 })).toThrow(/below minimum 256/);
    expect(bindParameters(withParam, { token_budget: 512 })).toEqual({ token_budget: 512 });
  });

  it('carries bound parameters into the digest', () => {
    const a = project({ definition: withParam, parameters: { token_budget: 512 }, corpus, graph });
    const b = project({ definition: withParam, parameters: { token_budget: 1024 }, corpus, graph });
    expect(a.projectionDigest).not.toBe(b.projectionDigest);
  });
});

describe('renderProjection', () => {
  it('renders every member of every section and escapes member-controlled text', () => {
    const hostile: ProjectionCorpus = {
      ...corpus,
      members: [member('h', { title: 'Own <script>alert(1)</script> *doc*' })],
    };
    const result = project({ definition, parameters: {}, corpus: hostile, graph });
    const html = renderProjection(result, 'html').bytes.toString('utf8');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    const markdown = renderProjection(result, 'markdown').bytes.toString('utf8');
    expect(markdown).toContain('\\*doc\\*');
    expect(markdown).toContain('## Raw corpus');
  });
});

describe('rendered links', () => {
  const links = {
    objectView: (m: ProjectionMember) => `https://kf.internal/objects/${m.objectId}`,
    source: (m: ProjectionMember) =>
      m.objectId === 'a' ? `https://api.kf.internal/documents/${m.objectId}/source` : undefined,
  };

  it('emit an Object View link for every member and a source link only where one exists', () => {
    const result = project({ definition, parameters: {}, corpus, graph });
    const html = renderProjection(result, 'html', { links }).bytes.toString('utf8');
    expect(html).toContain('<a href="https://kf.internal/objects/a">Mine</a>');
    expect(html).toContain('<a href="https://kf.internal/objects/b">Unrelated</a>');
    expect(html).toContain('<a href="https://api.kf.internal/documents/a/source">source</a>');
    expect(html).not.toContain('documents/b/source');
    const markdown = renderProjection(result, 'markdown', { links }).bytes.toString('utf8');
    expect(markdown).toContain('[Mine](https://kf.internal/objects/a)');
    expect(markdown).toContain('[source](https://api.kf.internal/documents/a/source)');
  });

  it('are a rendering concern: the projection digest is the same with and without them', () => {
    const result = project({ definition, parameters: {}, corpus, graph });
    expect(renderProjection(result, 'json', { links }).contentDigest).toBe(
      renderProjection(result, 'json').contentDigest,
    );
    expect(result.projectionDigest).toBe(
      project({ definition, parameters: {}, corpus, graph }).projectionDigest,
    );
  });

  it('are absent when no links are given, so a renderer never guesses a host', () => {
    const result = project({ definition, parameters: {}, corpus, graph });
    // Section anchors remain; no member points anywhere.
    expect(renderProjection(result, 'html').bytes.toString('utf8')).not.toContain('<a href="http');
  });

  it('escape a hostile link target rather than emit it as markup', () => {
    const result = project({ definition, parameters: {}, corpus, graph });
    const hostile = { objectView: () => 'https://x/"><script>alert(1)</script>' };
    const html = renderProjection(result, 'html', { links: hostile }).bytes.toString('utf8');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('verification (KF-SAS-RQ-229, RQ-231)', () => {
  const checked = recordVerification({
    basis: 'reviewed_individually',
    verifiedAt: '2026-09-20T00:00:00.000Z',
    verifiedBy: 'reviewer',
  });
  const mixed: ProjectionCorpus = {
    ...corpus,
    members: [member('a', { title: 'Mine', verification: checked }), member('b', { title: 'Raw' })],
  };
  const all = (result: ReturnType<typeof project>) => result.sections.flatMap((s) => s.members);

  it('carries verified:false and the label for an unverified member, and counts it', () => {
    const result = project({ definition, parameters: {}, corpus: mixed, graph });
    const b = all(result).find((m) => m.objectId === 'b')!;
    expect(b.verification).toEqual({ verified: false, label: UNVERIFIED_LABEL });
    expect(result.measurements.unverifiedCount).toBe(1);
    expect(result.format).toBe('kf-projection-result-v2');
  });

  it('carries the basis, time and verifier for a verified member', () => {
    const result = project({ definition, parameters: {}, corpus: mixed, graph });
    const a = all(result).find((m) => m.objectId === 'a')!;
    expect(a.verification).toEqual({
      verified: true,
      basis: 'reviewed_individually',
      verifiedAt: '2026-09-20T00:00:00.000Z',
      verifiedBy: 'reviewer',
      label: 'verified reviewed individually by reviewer at 2026-09-20T00:00:00.000Z',
    });
  });

  it('labels every member in every rendered form, with the master record’s class in HTML', () => {
    const result = project({ definition, parameters: {}, corpus: mixed, graph });
    const json = renderProjection(result, 'json').bytes.toString('utf8');
    expect(json).toContain(`"label":"${UNVERIFIED_LABEL}"`);
    const markdown = renderProjection(result, 'markdown', { maxInlineMembers: 0 });
    const md = markdown.bytes.toString('utf8');
    expect(md).toContain(`  - ${UNVERIFIED_LABEL}`);
    expect(md).toContain('verified reviewed individually by reviewer');
    expect(md).toContain('- Unverified members: `1`');
    const html = renderProjection(result, 'html', { maxInlineMembers: 0 }).bytes.toString('utf8');
    expect(html).toContain(`<div class="v unverified">${UNVERIFIED_LABEL}</div>`);
    expect(html).toContain('<div class="v">verified reviewed individually by reviewer');
    expect(html.match(/class="v unverified"/g)).toHaveLength(1);
  });

  it('refuses a member with no verification, rather than show it unlabelled', () => {
    const { verification: _dropped, ...bare } = member('x');
    const unlabelled = { ...corpus, members: [bare as unknown as ProjectionMember] };
    expect(() => project({ definition, parameters: {}, corpus: unlabelled, graph })).toThrow(
      expect.objectContaining({ reason: 'unlabelled_member' }),
    );
  });

  it('refuses an unverified member dressed in a verified label', () => {
    const forged = {
      ...corpus,
      members: [member('x', { verification: { verified: false, label: checked.label } as never })],
    };
    expect(() => project({ definition, parameters: {}, corpus: forged, graph })).toThrow(
      ProjectionRefused,
    );
  });

  it('moves the digest when only a verification changes: the reader was told something else', () => {
    const before = project({ definition, parameters: {}, corpus: mixed, graph });
    const verifiedB = {
      ...mixed,
      members: mixed.members.map((m) =>
        m.objectId === 'b'
          ? {
              ...m,
              verification: recordVerification({
                basis: 'promoted_in_bulk',
                verifiedAt: '2026-09-21T00:00:00.000Z',
                verifiedBy: 'reviewer',
              }),
            }
          : m,
      ),
    };
    const after = project({ definition, parameters: {}, corpus: verifiedB, graph });
    expect(after.projectionDigest).not.toBe(before.projectionDigest);
    expect(after.source.corpusDigest).toBe(before.source.corpusDigest);
  });

  it('pins the v2 digest of a fixed input, so a format change cannot pass silently', () => {
    // Deliberately a golden. If this moves, the digest preimage changed: that is a new format
    // tag (KF-SAS-RQ-158), not an updated constant. Recomputed independently of this code when
    // pinned: SHA-256 over the sorted-key, no-whitespace JSON of {format, definition,
    // parameters, source, sections: [{id, members: [[id, contentDigest, itemState,
    // ['verified', basis, verifiedAt, verifiedBy] | ['unverified', label]]]}]}.
    expect(project({ definition, parameters: {}, corpus: mixed, graph }).projectionDigest).toBe(
      '913dde56069eded18f311bfded20c46cd99e4008435e009325bc2d3cba6710af',
    );
  });
});
