import { compareCanonicalText } from '@kf/canonicalization';
import type {
  CompilationBasis,
  CompilerIrProvenance,
  CompilerOmittedSubgraph,
  CompilerProjectionCapability,
  CompilerProvenanceSourceKind,
  CompilerUnresolvedReference,
} from './types.js';
import { exactKeys, fail, nonEmpty, sha256 } from './primitives.js';

export function verifiedIrProvenance(
  input: CompilerIrProvenance,
  representation: 'hir' | 'cir',
): CompilerIrProvenance {
  exactKeys(
    input,
    ['nodeId', 'sourceKind', 'sourceId', 'sourcePath', 'sourceDigest'],
    `${representation} provenance`,
  );
  if (
    input.sourceKind !== 'fragment' &&
    input.sourceKind !== 'composition' &&
    input.sourceKind !== 'resource' &&
    input.sourceKind !== 'binding' &&
    input.sourceKind !== 'compiled_view'
  ) {
    fail(
      'malformed_response',
      `${representation} provenance has an unknown source kind: ${String(input.sourceKind)}`,
    );
  }
  return Object.freeze({
    nodeId: nonEmpty(input.nodeId, `${representation}Provenance.nodeId`),
    sourceKind: input.sourceKind,
    sourceId: nonEmpty(input.sourceId, `${representation}Provenance.sourceId`),
    sourcePath:
      input.sourcePath === null
        ? null
        : nonEmpty(input.sourcePath, `${representation}Provenance.sourcePath`),
    sourceDigest: sha256(input.sourceDigest, `${representation}Provenance.sourceDigest`),
  });
}

export function verifiedProvenanceSet(
  inputs: readonly CompilerIrProvenance[],
  representation: 'hir' | 'cir',
  allowed: ReadonlyMap<string, string>,
  required: ReadonlyMap<string, string>,
): readonly CompilerIrProvenance[] {
  const seen = new Set<string>();
  const coveredSources = new Set<string>();
  const values = inputs.map((input) => {
    const value = verifiedIrProvenance(input, representation);
    const key = `${value.nodeId}\0${value.sourceKind}\0${value.sourceId}\0${value.sourcePath ?? ''}`;
    if (seen.has(key)) {
      fail('malformed_response', `${representation} provenance contains a duplicate source claim`);
    }
    seen.add(key);
    const sourceKey = `${value.sourceKind}:${value.sourceId}`;
    const expectedDigest = allowed.get(sourceKey);
    if (expectedDigest === undefined) {
      fail(
        'provenance_source_not_in_basis',
        `${representation} provenance source is not pinned by the Basis: ${sourceKey}`,
      );
    }
    if (value.sourceDigest !== expectedDigest) {
      fail(
        'provenance_digest_mismatch',
        `${representation} provenance source digest differs from the Basis: ${sourceKey}`,
      );
    }
    coveredSources.add(sourceKey);
    return value;
  });
  const missing = [...required.keys()].filter((sourceKey) => !coveredSources.has(sourceKey));
  if (missing.length > 0) {
    fail(
      'missing_provenance_coverage',
      `${representation} provenance omits Basis compiler inputs: ${missing.join(', ')}`,
    );
  }
  return Object.freeze(
    values.sort((left, right) =>
      compareCanonicalText(
        `${left.nodeId}\0${left.sourceKind}\0${left.sourceId}\0${left.sourcePath ?? ''}`,
        `${right.nodeId}\0${right.sourceKind}\0${right.sourceId}\0${right.sourcePath ?? ''}`,
      ),
    ),
  );
}

export function expectedProvenanceSources(basis: CompilationBasis): ReadonlyMap<string, string> {
  const expected = new Map<string, string>();
  const add = (kind: CompilerProvenanceSourceKind, id: string, contentDigest: string): void => {
    const key = `${kind}:${id}`;
    const prior = expected.get(key);
    if (prior !== undefined && prior !== contentDigest) {
      fail('conflicting_provenance_digest', `${key} is pinned to two provenance digests`);
    }
    expected.set(key, contentDigest);
  };
  for (const fragment of basis.fragmentRevisions) {
    add('fragment', fragment.id, fragment.holder.contentDigest);
  }
  for (const composition of basis.compositionRevisions) {
    add('composition', composition.id, composition.revisionDigest);
    for (const input of composition.inputs) {
      if (input.role === 'resource') {
        add('resource', input.resourceVersionId, input.contentDigest);
      } else if (input.role === 'generated_view') {
        add('compiled_view', input.compiledViewId, input.contentDigest);
      }
    }
  }
  for (const binding of basis.bindings) add('binding', binding.id, binding.bindingDigest);
  return expected;
}

export function verifiedUnresolvedReference(
  input: CompilerUnresolvedReference,
): CompilerUnresolvedReference {
  exactKeys(input, ['sourceNodeId', 'reference', 'reasonCode', 'message'], 'unresolved reference');
  return Object.freeze({
    sourceNodeId:
      input.sourceNodeId === null
        ? null
        : nonEmpty(input.sourceNodeId, 'unresolvedReference.sourceNodeId'),
    reference: nonEmpty(input.reference, 'unresolvedReference.reference'),
    reasonCode: nonEmpty(input.reasonCode, 'unresolvedReference.reasonCode'),
    message: nonEmpty(input.message, 'unresolvedReference.message'),
  });
}

export function verifiedOmittedSubgraph(input: CompilerOmittedSubgraph): CompilerOmittedSubgraph {
  exactKeys(input, ['rootNodeId', 'reasonCode', 'message'], 'omitted subgraph');
  return Object.freeze({
    rootNodeId: nonEmpty(input.rootNodeId, 'omittedSubgraph.rootNodeId'),
    reasonCode: nonEmpty(input.reasonCode, 'omittedSubgraph.reasonCode'),
    message: nonEmpty(input.message, 'omittedSubgraph.message'),
  });
}

export function verifiedProjectionCapabilities(
  inputs: readonly CompilerProjectionCapability[],
  basis: CompilationBasis,
): readonly CompilerProjectionCapability[] {
  const expected = new Set(basis.targetProfiles.map((profile) => profile.target));
  const seen = new Set<string>();
  const values = inputs.map((input) => {
    exactKeys(input, ['target', 'capabilities'], 'projection capability');
    const target = nonEmpty(input.target, 'projectionCapability.target');
    if (!expected.has(target)) {
      fail('malformed_response', `projection capabilities cite undeclared target: ${target}`);
    }
    if (seen.has(target)) {
      fail('malformed_response', `projection capabilities repeat target: ${target}`);
    }
    seen.add(target);
    const capabilities = input.capabilities.map((capability) =>
      nonEmpty(capability, `projectionCapability.${target}`),
    );
    if (new Set(capabilities).size !== capabilities.length) {
      fail('malformed_response', `projection capabilities repeat a capability for: ${target}`);
    }
    return Object.freeze({
      target,
      capabilities: Object.freeze(capabilities.sort(compareCanonicalText)),
    });
  });
  const missing = [...expected].filter((target) => !seen.has(target));
  if (missing.length > 0) {
    fail(
      'malformed_response',
      `projection capabilities are missing declared targets: ${missing.join(', ')}`,
    );
  }
  return Object.freeze(
    values.sort((left, right) => compareCanonicalText(left.target, right.target)),
  );
}
