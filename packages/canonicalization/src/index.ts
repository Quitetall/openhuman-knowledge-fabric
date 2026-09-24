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

/**
 * Locale-independent UTF-16 code-unit ordering used by RFC 8785.
 *
 * `localeCompare` depends on host ICU data and locale. Arrays that feed hashes or signatures
 * must instead use same ordinal relation as ECMAScript's default string sort.
 */
export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(message: string, path: string): never {
  throw new CanonicalizationError(message, path);
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('unpaired UTF-16 high surrogate is forbidden by I-JSON', path);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail('unpaired UTF-16 low surrogate is forbidden by I-JSON', path);
    }
  }
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
      assertUnicodeScalarString(value, path);
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
    assertUnicodeScalarString(key, path === '' ? key : `${path}.${key}`);
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

/** A digest format tag: `kf-<name>-v<n>`, lowercase, the version a positive integer. */
const FORMAT_TAG = /^kf-[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/;

export function isFormatTag(value: unknown): value is string {
  return typeof value === 'string' && FORMAT_TAG.test(value);
}

/**
 * Lowercase hex SHA-256 of `fields` under a named format tag (KF-SAS-RQ-016).
 *
 * The tag goes inside the preimage as a `format` property of the canonicalized object, which is
 * the house form every tagged digest already used: `taggedDigest('kf-x-v1', { a })` is
 * byte-identical to `digest({ format: 'kf-x-v1', a })`. Two things are refused rather than
 * guessed at. A `fields` object that already carries `format` would either overwrite the tag or
 * be overwritten by it, so it is an error whichever way round. And `fields` must be a plain
 * object: a bare list or scalar has nowhere for the tag to sit, so the caller names it first
 * (`{ objects: list }`) — the name then becomes part of what the tag versions.
 */
export function taggedDigest(tag: string, fields: Readonly<Record<string, unknown>>): string {
  if (!isFormatTag(tag)) {
    throw new CanonicalizationError(
      `format tag ${JSON.stringify(tag)} is not of the form kf-<name>-v<n>`,
      'format',
    );
  }
  if (
    fields === null ||
    typeof fields !== 'object' ||
    Array.isArray(fields) ||
    Object.getPrototypeOf(fields) !== Object.prototype
  ) {
    throw new CanonicalizationError('tagged fields must be a plain object', '');
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'format')) {
    throw new CanonicalizationError('tagged fields may not carry their own format', 'format');
  }
  return digest({ ...fields, format: tag });
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

/** Exact semantic fields committed by one Knowledge Fabric audit-chain link. */
export interface AuditChainEntry {
  readonly action_id: string;
  readonly action_type: string;
  readonly actor_id: string;
  readonly acting_role_id: string;
  readonly object_ids: readonly string[];
  readonly effective_at: string;
  readonly before_digest: string | null;
  readonly after_digest: string | null;
}

/**
 * The formats an audit-chain link digest has been computed under, oldest first.
 *
 * `kf-audit-link-v1` is the original preimage: the eight fields with NO format tag, which is
 * the gap SAS §100.27 recorded against KF-SAS-RQ-016. The name exists only so a recorded link
 * can say which preimage it used; it never appears inside a digest. `kf-audit-link-v2` puts the
 * tag in the preimage the way every other tagged digest here does — a `format` property of the
 * canonicalized object. Links already recorded under v1 stay v1 (the chain is append-only and
 * checkpoint-signed, so they cannot be re-hashed), and every link appended since the cutover is
 * v2. Order matters: a chain may move from v1 to v2 once and never back.
 */
export const AUDIT_LINK_FORMATS = ['kf-audit-link-v1', 'kf-audit-link-v2'] as const;
export type AuditLinkFormat = (typeof AUDIT_LINK_FORMATS)[number];

/** The format every newly appended link is computed under. */
export const CURRENT_AUDIT_LINK_FORMAT: AuditLinkFormat = 'kf-audit-link-v2';

export function isAuditLinkFormat(value: unknown): value is AuditLinkFormat {
  return typeof value === 'string' && (AUDIT_LINK_FORMATS as readonly string[]).includes(value);
}

/**
 * Whether a link recorded under `next` may follow one recorded under `previous` (undefined at
 * genesis). Formats never regress: a v1 link after a v2 one is a link computed by something
 * that predates the cutover, or one forged to avoid the tag, and either way it is refused.
 */
export function auditLinkFormatMayFollow(
  previous: AuditLinkFormat | undefined,
  next: AuditLinkFormat,
): boolean {
  if (previous === undefined) return true;
  return AUDIT_LINK_FORMATS.indexOf(next) >= AUDIT_LINK_FORMATS.indexOf(previous);
}

/**
 * Rebuild one audit-chain link without letting producers and verifiers drift apart.
 *
 * The format is explicit and has no default: a writer names `CURRENT_AUDIT_LINK_FORMAT`, and a
 * verifier names the format the link RECORDED, so neither can silently compute the other's.
 * Object identifiers are a set at this boundary. Sorting here preserves the original contract
 * even when `core.action.target_ids` retained caller order.
 */
export function auditChainDigest(
  previous: string,
  entry: AuditChainEntry,
  format: AuditLinkFormat,
): string {
  if (!isAuditLinkFormat(format)) {
    throw new CanonicalizationError(`unknown audit link format ${String(format)}`, 'format');
  }
  return chainDigest(previous, {
    action_id: entry.action_id,
    action_type: entry.action_type,
    actor_id: entry.actor_id,
    acting_role_id: entry.acting_role_id,
    object_ids: [...entry.object_ids].sort(),
    effective_at: entry.effective_at,
    before_digest: entry.before_digest,
    after_digest: entry.after_digest,
    ...(format === 'kf-audit-link-v1' ? {} : { format }),
  });
}
