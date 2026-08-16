import { compareCanonicalText, digest } from '@kf/canonicalization';
import type {
  AuthoredFragmentRevision,
  CompilationBasis,
  CompilationBasisInput,
  CompilerInput,
  CompositionRevision,
  TypedBinding,
} from './types.js';
import { createTypedBinding } from './bindings.js';
import { createCompositionRevision } from './composition.js';
import { compilerIdentity } from './identity.js';
import { createAuthoredFragmentRevision } from './source-holder.js';
import { fail, maximumClassification, nonEmpty, sha256 } from './primitives.js';

function verifiedFragment(input: AuthoredFragmentRevision): AuthoredFragmentRevision {
  const verified = createAuthoredFragmentRevision(input);
  if (verified.revisionDigest !== input.revisionDigest) {
    fail('fragment_digest_mismatch', `fragment revision ${input.id} has an invalid digest`);
  }
  return verified;
}

function verifiedComposition(input: CompositionRevision): CompositionRevision {
  const verified = createCompositionRevision(input);
  if (verified.revisionDigest !== input.revisionDigest) {
    fail('composition_digest_mismatch', `composition revision ${input.id} has an invalid digest`);
  }
  return verified;
}

function verifiedBinding(input: TypedBinding): TypedBinding {
  const verified = createTypedBinding(input);
  if (
    verified.valueDigest !== input.valueDigest ||
    verified.bindingDigest !== input.bindingDigest
  ) {
    fail('binding_digest_mismatch', `typed binding ${input.id} has an invalid digest`);
  }
  return verified;
}

function uniqueById<T extends { readonly id: string }>(
  values: readonly T[],
  kind: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) fail('duplicate_input', `duplicate ${kind} id: ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

function requireOneRevisionPerSubject(
  values: readonly {
    readonly id: string;
    readonly fragmentId?: string;
    readonly compositionId?: string;
  }[],
  field: 'fragmentId' | 'compositionId',
): void {
  const seen = new Map<string, string>();
  for (const value of values) {
    const subject = value[field];
    if (subject === undefined) continue;
    const prior = seen.get(subject);
    if (prior !== undefined) {
      fail(
        'multiple_subject_revisions',
        `basis contains both ${prior} and ${value.id} for ${field} ${subject}`,
      );
    }
    seen.set(subject, value.id);
  }
}

function validateClosedCompositionGraph(
  rootId: string,
  compositions: ReadonlyMap<string, CompositionRevision>,
  fragments: ReadonlyMap<string, AuthoredFragmentRevision>,
  bindings: ReadonlyMap<string, TypedBinding>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const usedFragments = new Set<string>();
  const usedBindings = new Set<string>();

  const visit = (id: string): void => {
    if (visiting.has(id)) fail('composition_cycle', `composition cycle reaches ${id}`);
    if (visited.has(id)) return;
    const revision = compositions.get(id);
    if (revision === undefined) {
      fail('missing_composition', `composition revision ${id} is not present in the basis`);
    }
    visiting.add(id);
    for (const input of revision.inputs) {
      if (input.role === 'composition') {
        visit(input.compositionRevisionId);
      } else if (input.role === 'fragment') {
        if (!fragments.has(input.fragmentRevisionId)) {
          fail(
            'missing_fragment',
            `fragment revision ${input.fragmentRevisionId} is not present in the basis`,
          );
        }
        usedFragments.add(input.fragmentRevisionId);
      } else if (input.role === 'binding') {
        if (!bindings.has(input.bindingId)) {
          fail('missing_binding', `typed binding ${input.bindingId} is not present in the basis`);
        }
        usedBindings.add(input.bindingId);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };

  visit(rootId);
  const unreachableCompositions = [...compositions.keys()].filter((id) => !visited.has(id));
  const unreachableFragments = [...fragments.keys()].filter((id) => !usedFragments.has(id));
  const unreachableBindings = [...bindings.keys()].filter((id) => !usedBindings.has(id));
  const unreachable = [...unreachableCompositions, ...unreachableFragments, ...unreachableBindings];
  if (unreachable.length > 0) {
    fail('unreachable_basis_input', `basis contains unreachable inputs: ${unreachable.join(', ')}`);
  }
}

/**
 * Close and canonicalize the complete transitive input identity for one compiler invocation.
 */
export function createCompilationBasis(input: CompilationBasisInput): CompilationBasis {
  if (input.protocol !== 'kf-document-v1') {
    fail('unsupported_protocol', `unsupported compilation protocol: ${String(input.protocol)}`);
  }
  const fragmentRevisions = input.fragmentRevisions
    .map(verifiedFragment)
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  const compositionRevisions = input.compositionRevisions
    .map(verifiedComposition)
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  const bindings = input.bindings
    .map(verifiedBinding)
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  requireOneRevisionPerSubject(fragmentRevisions, 'fragmentId');
  requireOneRevisionPerSubject(compositionRevisions, 'compositionId');

  const fragmentById = uniqueById(fragmentRevisions, 'fragment revision');
  const compositionById = uniqueById(compositionRevisions, 'composition revision');
  const bindingById = uniqueById(bindings, 'typed binding');
  const rootCompositionRevisionId = nonEmpty(
    input.rootCompositionRevisionId,
    'rootCompositionRevisionId',
  );
  validateClosedCompositionGraph(
    rootCompositionRevisionId,
    compositionById,
    fragmentById,
    bindingById,
  );

  const targetProfiles = input.targetProfiles
    .map((profile) =>
      Object.freeze({
        target: nonEmpty(profile.target, 'targetProfile.target'),
        profileDigest: sha256(profile.profileDigest, 'targetProfile.profileDigest'),
      }),
    )
    .sort((left, right) => compareCanonicalText(left.target, right.target));
  const targets = new Set<string>();
  for (const profile of targetProfiles) {
    if (targets.has(profile.target)) {
      fail('duplicate_target', `duplicate compilation target: ${profile.target}`);
    }
    targets.add(profile.target);
  }
  if (targetProfiles.length === 0) fail('missing_target', 'basis must declare at least one target');

  const effectiveClassification = maximumClassification([
    ...fragmentRevisions.map((fragment) => fragment.classification),
    ...compositionRevisions.map((composition) => composition.classification),
    ...bindings.map((binding) => binding.sourceClassification),
    ...compositionRevisions.flatMap((composition) =>
      composition.inputs.flatMap((compositionInput) =>
        compositionInput.role === 'resource' || compositionInput.role === 'generated_view'
          ? [compositionInput.classification]
          : [],
      ),
    ),
  ]);

  const claim: Omit<CompilationBasis, 'basisDigest'> = {
    protocol: input.protocol,
    rootCompositionRevisionId,
    fragmentRevisions: Object.freeze(fragmentRevisions),
    compositionRevisions: Object.freeze(compositionRevisions),
    bindings: Object.freeze(bindings),
    targetProfiles: Object.freeze(targetProfiles),
    ontologyDigest: sha256(input.ontologyDigest, 'ontologyDigest'),
    policyDigest: sha256(input.policyDigest, 'policyDigest'),
    compiler: compilerIdentity(input.compiler),
    effectiveClassification,
  };
  return Object.freeze({ ...claim, basisDigest: digest(claim) });
}

export function expectedCompilerInputs(basis: CompilationBasis): Map<string, string> {
  const expected = new Map<string, string>();
  const add = (kind: CompilerInput['kind'], id: string, contentDigest: string): void => {
    const key = `${kind}:${id}`;
    const prior = expected.get(key);
    if (prior !== undefined && prior !== contentDigest) {
      fail('conflicting_input_digest', `${key} is pinned to two content digests`);
    }
    expected.set(key, contentDigest);
  };
  for (const fragment of basis.fragmentRevisions) {
    add('fragment', fragment.id, fragment.holder.contentDigest);
  }
  for (const composition of basis.compositionRevisions) {
    for (const input of composition.inputs) {
      if (input.role === 'resource') {
        add('resource', input.resourceVersionId, input.contentDigest);
      } else if (input.role === 'generated_view') {
        add('compiled_view', input.compiledViewId, input.contentDigest);
      }
    }
  }
  return expected;
}
