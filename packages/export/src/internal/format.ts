import type { PgTextParserOverride } from '@kf/database';

export const MANIFEST_PATH = 'manifest.json';
export const MANIFEST_SIGNATURE_FORMAT = 'kf-preservation-manifest-signature-v1';
export const SHA256 = /^[0-9a-f]{64}$/;
export const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const CHECKPOINT_PUBLIC_KEY_EXPORT_PATH =
  /^trust\/checkpoint\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.pub$/;
export const PRIVATE_KEY_PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
export const DECIMAL_SEQUENCE = /^(?:0|[1-9][0-9]*)$/;
/**
 * A PostgreSQL snapshot token, in the exact shape `pg_export_snapshot()` emits.
 *
 * Uppercase hex, measured rather than assumed: PostgreSQL 18 returns
 * `0000001A-0000000D-1`. This pattern read `[0-9A-Fa-f]` while `cli/arguments.ts` kept its own
 * private `[0-9A-F]` — two definitions of one validator that had already drifted, so a
 * lowercase token was accepted through the library and refused through the command line. This
 * is now the only definition and the CLI imports it.
 *
 * It matters more than a shape check usually would, because `SET TRANSACTION SNAPSHOT` has no
 * bind-parameter form: `exporter.ts` interpolates this value into SQL, and closed-form
 * validation is the entire reason that is safe. A validator with two definitions has no
 * closed form, only two approximations of one.
 */
export const STRICT_SNAPSHOT_TOKEN = /^[0-9A-F]{8}-[0-9A-F]{8}-[0-9]+$/;
export const UTC_TIMESTAMPTZ =
  /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?\+00(?::?00)?$/;
export const ISO_UTC_TIMESTAMPTZ = /^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const LOSSLESS_TAG_KEYS = ['$kf_type', 'text'] as const;

export type LosslessPostgresType = 'postgres.json' | 'postgres.jsonb' | 'postgres.timestamptz';

export interface LosslessPostgresValue {
  readonly $kf_type: LosslessPostgresType;
  readonly text: string;
}

export function losslessValue(type: LosslessPostgresType, text: string): LosslessPostgresValue {
  return { $kf_type: type, text };
}

export function utcIsoTimestamptz(text: string): string {
  const match = UTC_TIMESTAMPTZ.exec(text);
  if (match === null) {
    throw new Error(`cannot preserve non-finite or non-UTC timestamptz ${JSON.stringify(text)}`);
  }
  return `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(6, '0')}Z`;
}

export const PRESERVATION_TEXT_PARSERS: readonly PgTextParserOverride[] = [
  { oid: 20, parse: (text) => text },
  { oid: 114, parse: (text) => losslessValue('postgres.json', text) },
  {
    oid: 1184,
    parse: (text) => losslessValue('postgres.timestamptz', utcIsoTimestamptz(text)),
  },
  { oid: 1700, parse: (text) => text },
  { oid: 3802, parse: (text) => losslessValue('postgres.jsonb', text) },
];

/**
 * PostgreSQL's wire protocol caps bind parameters at 65535 per statement. Batched inserts on
 * import are sized to stay under it — exceeding it fails at the protocol layer with an error
 * that says nothing about which restore step overran.
 */
export const MAX_BIND_PARAMETERS = 60000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function safeExportPath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\')) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function canonicalBase64(value: string): boolean {
  return (
    value.length % 4 === 0 &&
    CANONICAL_BASE64.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}
