/**
 * Every relation declares which object types may sit at each end (SAS §100.2, KF-SAS-RQ-070).
 *
 * The typing narrows R01, which declared no endpoints at all, so the r01-golden preservation
 * comparison strips it — and this file is what that stripping is conditional on:
 *
 *   1. no R01 edge carried endpoint typing, so none is being REDEFINED, only declared;
 *   2. R01's own example graph, every edge of it, satisfies the typing — the narrowing refuses
 *      nothing the approved pack's example relies on;
 *   3. every relation declares both ends, in the ontology and in the registry seed the database
 *      enforces from (`core.relation_endpoint_declared`, 20260925030300).
 *
 * The database half — an undeclared pair refused, a declared one admitted — is planted against a
 * real database in `tests/database/relation-endpoints.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOntology } from '@kf/ontology-compiler';

const ROOT = join(import.meta.dirname, '..', '..');
const GOLDEN = join(ROOT, 'tests', 'conformance', 'r01-golden');
const ontology = loadOntology(join(ROOT, 'ontology'));
const byId = new Map(ontology.relationTypes.map((r) => [r.id, r]));

describe('relation endpoint typing', () => {
  it('declares both ends of every relation', () => {
    const untyped = ontology.relationTypes
      .filter((r) => (r.sourceTypes?.length ?? 0) === 0 || (r.targetTypes?.length ?? 0) === 0)
      .map((r) => r.id);
    expect(untyped).toEqual([]);
  });

  it('redefines no R01 edge: R01 typed none', () => {
    const vocabulary = JSON.parse(
      readFileSync(join(GOLDEN, 'knowledge-fabric.vocabulary.json'), 'utf8'),
    ) as { edge_types: Record<string, Record<string, unknown>> };
    const typedInR01 = Object.entries(vocabulary.edge_types)
      .filter(([, edge]) => 'source_types' in edge || 'target_types' in edge)
      .map(([id]) => id);
    expect(Object.keys(vocabulary.edge_types).length).toBeGreaterThan(30);
    expect(typedInR01).toEqual([]);
  });

  it("admits every edge of R01's own example graph", () => {
    const graph = JSON.parse(
      readFileSync(join(GOLDEN, 'example-atlas-enclosure-project.json'), 'utf8'),
    ) as {
      nodes: { node_id: string; node_type: string }[];
      edges: { edge_id: string; edge_type: string; source: string; target: string }[];
    };
    const typeOf = new Map(graph.nodes.map((n) => [n.node_id, n.node_type]));
    expect(graph.edges.length).toBeGreaterThan(10);
    const refused = graph.edges.filter((edge) => {
      const relation = byId.get(edge.edge_type);
      return (
        relation === undefined ||
        !relation.sourceTypes!.includes(typeOf.get(edge.source)!) ||
        !relation.targetTypes!.includes(typeOf.get(edge.target)!)
      );
    });
    expect(
      refused.map(
        (e) => `${e.edge_id}: ${typeOf.get(e.source)} -${e.edge_type}-> ${typeOf.get(e.target)}`,
      ),
    ).toEqual([]);
  });

  it('seeds every declared end into the registry the database enforces from', () => {
    const seed = readFileSync(
      join(ROOT, 'generated', 'sql-registry', '001-ontology-seed.sql'),
      'utf8',
    );
    for (const relation of ontology.relationTypes) {
      for (const [end, types] of [
        ['source', relation.sourceTypes ?? []],
        ['target', relation.targetTypes ?? []],
      ] as const) {
        for (const type of types) {
          expect(seed, `${relation.id} ${end} ${type} is not seeded`).toContain(
            `('${relation.id}', '${end}', '${type}')`,
          );
        }
      }
    }
  });
});
