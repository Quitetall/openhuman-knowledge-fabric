/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) and content digests.
 *
 * Every hash that appears in a snapshot, release manifest, audit event or preservation
 * export is computed here. Two implementations that disagree about a record's bytes would
 * produce two different digests for the same fact, which would make the audit chain
 * unverifiable — so this is deliberately the only place canonical bytes are defined.
 *
 * JCS was specified around ECMAScript semantics, so several requirements fall out of the
 * language rather than needing to be reimplemented:
 *   - property ordering is UTF-16 code-unit order, which is exactly `Array#sort` on strings;
 *   - number formatting is ECMAScript `Number::toString`, which is what `JSON.stringify`
 *     emits for finite numbers;
 *   - string escaping (shortest form, `\b \t \n \f \r`, `\u00xx` for other control
 *     characters) matches `JSON.stringify` since well-formed stringify landed in ES2019.
 *
 * What does NOT fall out, and is enforced here:
 *   - `NaN` and `±Infinity` are errors. `JSON.stringify` would silently emit `null`.
 *   - `undefined` inside an array is an error. `JSON.stringify` would silently emit `null`,
 *     changing the value being hashed.
 *   - `undefined` as an object property value is dropped, matching `JSON.stringify`, because
 *     optional fields are ubiquitous and absence is the intended meaning.
 *   - `bigint`, `symbol` and functions are errors rather than coerced.
 *
 * @see https://www.rfc-editor.org/rfc/rfc8785
 */

import { createHash } from 'node:crypto';

/** A value that can be canonicalized. Mirrors the JSON data model exactly. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export class CanonicalizationError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(path === '' ? message : `${message} (at ${path})`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

function fail(message: string, path: string): never {
  throw new CanonicalizationError(message, path);
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number':
      if (!Number.isFinite(value)) {
        fail(`non-finite number ${String(value)} has no canonical form`, path);
      }
      // Finite numbers: JSON.stringify emits ECMAScript Number::toString, which is what
      // RFC 8785 §3.2.2.3 requires. This also renders -0 as "0", as the RFC requires.
      return JSON.stringify(value);

    case 'string':
      return JSON.stringify(value);

    case 'bigint':
      fail('bigint has no JSON representation; convert to string or number first', path);
      break;

    case 'undefined':
      fail('undefined has no canonical form', path);
      break;

    case 'function':
    case 'symbol':
      fail(`${typeof value} has no canonical form`, path);
      break;

    case 'object':
      break;
  }

  if (Array.isArray(value)) {
    const parts = value.map((item, i) => {
      const childPath = `${path}[${i}]`;
      // JSON.stringify turns a hole or undefined into `null`, silently changing what is
      // hashed. Refuse instead.
      if (item === undefined) fail('undefined array element has no canonical form', childPath);
      return serialize(item, childPath);
    });
    return `[${parts.join(',')}]`;
  }

  const obj = value as Record<string, unknown>;

  // toJSON is honoured so Date and similar types canonicalize the way JSON.stringify would.
  const toJson = (obj as { toJSON?: unknown }).toJSON;
  if (typeof toJson === 'function') {
    return serialize((toJson as () => unknown).call(obj), path);
  }

  // UTF-16 code-unit order (RFC 8785 §3.2.3) is the default string sort in ECMAScript.
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = obj[key];
    if (child === undefined) continue; // absent, per JSON.stringify semantics
    parts.push(`${JSON.stringify(key)}:${serialize(child, path === '' ? key : `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Canonicalize a value to an RFC 8785 JCS string. */
export function canonicalize(value: unknown): string {
  return serialize(value, '');
}

/** Canonical UTF-8 bytes of a value. This is what gets hashed and what gets written. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

/** Lowercase hex SHA-256 of a value's canonical bytes. */
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

/** Lowercase hex SHA-256 of raw bytes — for artifact content, which is never canonicalized. */
export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hash-chain step for the audit log: each entry commits to its predecessor.
 *
 * `previous` is the hex digest of the prior entry, or 64 zeros for the genesis entry.
 * Altering any historical entry changes every digest after it, so a retroactive edit is
 * detectable by recomputation alone.
 */
export const GENESIS_DIGEST = '0'.repeat(64);

export function chainDigest(previous: string, entry: unknown): string {
  if (!/^[0-9a-f]{64}$/.test(previous)) {
    throw new CanonicalizationError(`previous digest is not a 64-character hex string`, 'previous');
  }
  return createHash('sha256').update(previous, 'hex').update(canonicalBytes(entry)).digest('hex');
}
