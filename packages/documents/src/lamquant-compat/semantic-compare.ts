import type {
  LamQuantNamedDigest,
  LamQuantSemanticDimension,
  LamQuantSemanticEvidence,
  LamQuantSemanticMismatch,
  LamQuantSemanticProjection,
} from './contracts.js';

export function compareSemanticProjection(
  source: LamQuantSemanticProjection,
  generated: LamQuantSemanticProjection,
): LamQuantSemanticEvidence {
  const mismatches: LamQuantSemanticMismatch[] = [
    ...compareList('atom_membership', source.atomMembership, generated.atomMembership),
    ...compareDigests(source.parentOutputs, generated.parentOutputs),
    ...compareList('topics', source.topics, generated.topics),
    ...compareList('topics', source.topicMembership, generated.topicMembership),
    ...compareList('ledger_bindings', source.ledgerBindings, generated.ledgerBindings),
    ...compareList('deprecation', source.deprecations, generated.deprecations),
    ...compareList('adr_inventory', source.adrInventory, generated.adrInventory),
    ...compareList('adr_views', source.adrViews, generated.adrViews),
    ...compareList('traceability', source.traceability, generated.traceability),
    ...compareBookOrder(source.bookOrder, generated.bookOrder),
  ];
  return { matched: mismatches.length === 0, source, generated, mismatches };
}

function compareList(
  dimension: LamQuantSemanticDimension,
  expected: readonly string[],
  actual: readonly string[],
): readonly LamQuantSemanticMismatch[] {
  const mismatches: LamQuantSemanticMismatch[] = [];
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    if (expected[index] === actual[index]) continue;
    mismatches.push({
      dimension,
      message: `${dimension} evidence differs at index ${String(index)}`,
      ...(expected[index] === undefined ? {} : { expected: expected[index] }),
      ...(actual[index] === undefined ? {} : { actual: actual[index] }),
    });
  }
  return mismatches;
}

function compareDigests(
  expected: readonly LamQuantNamedDigest[],
  actual: readonly LamQuantNamedDigest[],
): readonly LamQuantSemanticMismatch[] {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry.sha256]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry.sha256]));
  const missingOrChanged = expected.flatMap((entry): LamQuantSemanticMismatch[] => {
    const actualDigest = actualByPath.get(entry.path);
    if (actualDigest === undefined) {
      return [
        { dimension: 'parent_output', path: entry.path, message: 'generated parent is missing' },
      ];
    }
    if (actualDigest !== entry.sha256) {
      return [
        {
          dimension: 'parent_output',
          path: entry.path,
          message: 'generated parent body differs from independent KF projection',
          expected: entry.sha256,
          actual: actualDigest,
        },
      ];
    }
    return [];
  });
  const unexpected = actual.flatMap((entry): LamQuantSemanticMismatch[] =>
    expectedByPath.has(entry.path)
      ? []
      : [
          {
            dimension: 'parent_output',
            path: entry.path,
            message: 'generated output contains an unexpected composed parent',
            actual: entry.sha256,
          },
        ],
  );
  return [...missingOrChanged, ...unexpected];
}

function compareBookOrder(
  expected: readonly string[],
  actual: readonly string[],
): readonly LamQuantSemanticMismatch[] {
  const expectedDeduped = [...new Set(expected)];
  return expectedDeduped.join('\n') === actual.join('\n')
    ? []
    : [
        {
          dimension: 'book_order',
          message: 'generated book order differs from full source order',
          expected: expectedDeduped.join('\n'),
          actual: actual.join('\n'),
        },
      ];
}
