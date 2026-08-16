import { digest, type JsonValue } from '@kf/canonicalization';
import type {
  BindingSource,
  BindingValueType,
  TypedBinding,
  TypedBindingInput,
} from './core-types.js';
import { classification, exactKeys, fail, nonEmpty } from './primitives.js';

function bindingSource(input: BindingSource): BindingSource {
  if (input.kind === 'object_revision') {
    exactKeys(input, ['kind', 'objectId', 'objectRevision'], 'object-revision binding source');
    if (!Number.isSafeInteger(input.objectRevision) || input.objectRevision < 1) {
      fail('invalid_object_revision', 'binding objectRevision must be a positive safe integer');
    }
    return Object.freeze({
      kind: input.kind,
      objectId: nonEmpty(input.objectId, 'binding.source.objectId'),
      objectRevision: input.objectRevision,
    });
  }
  if (input.kind === 'snapshot') {
    exactKeys(input, ['kind', 'objectId', 'snapshotId'], 'snapshot binding source');
    return Object.freeze({
      kind: input.kind,
      objectId: nonEmpty(input.objectId, 'binding.source.objectId'),
      snapshotId: nonEmpty(input.snapshotId, 'binding.source.snapshotId'),
    });
  }
  return fail('unknown_binding_source', 'binding source kind is not supported');
}

function immutableJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(immutableJson)) as unknown as JsonValue;
  }
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) copy[key] = immutableJson(child);
    return Object.freeze(copy);
  }
  return value;
}

function valueType(value: JsonValue): BindingValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value as 'string' | 'number' | 'boolean' | 'object';
}

function bindingTypeMatches(value: JsonValue, expected: BindingValueType): boolean {
  const actual = valueType(value);
  return actual === expected || (actual === 'integer' && expected === 'number');
}

/** Resolve one typed fact at an exact object revision or snapshot. */
export function createTypedBinding(input: TypedBindingInput): TypedBinding {
  if (!bindingTypeMatches(input.value, input.expectedType)) {
    fail(
      'binding_type_mismatch',
      `binding expected ${input.expectedType}, received ${valueType(input.value)}`,
    );
  }
  const value = immutableJson(input.value);
  const valueDigest = digest(value);
  const claim: TypedBindingInput & { readonly valueDigest: string } = {
    id: nonEmpty(input.id, 'binding.id'),
    source: bindingSource(input.source),
    sourceClassification: classification(
      input.sourceClassification,
      'binding.sourceClassification',
    ),
    selector: nonEmpty(input.selector, 'binding.selector'),
    expectedType: input.expectedType,
    renderer: nonEmpty(input.renderer, 'binding.renderer'),
    value,
    valueDigest,
  };
  return Object.freeze({ ...claim, bindingDigest: digest(claim) });
}
