import { canonicalize } from '@kf/canonicalization';
import type { PublicationManifest } from './types.js';

export const SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface ValidationState {
  readonly findings: string[];
  structurallyValid: boolean;
}

export function requireText(value: string, name: string): void {
  if (value.trim() === '') throw new Error(`${name} must not be empty`);
}

export function safePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

export function canonicalManifestBytes(manifest: PublicationManifest): Buffer {
  return Buffer.from(canonicalize(manifest), 'utf8');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function closedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  findings: string[],
): void {
  const unexpected = Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
  if (unexpected.length > 0) findings.push(`${path}: unexpected fields: ${unexpected.join(', ')}`);
}

export function canonicalInstant(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function canonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

export function requiredText(
  state: ValidationState,
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const candidate = record[key];
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    state.findings.push(`${path} must be a non-empty string`);
    state.structurallyValid = false;
    return undefined;
  }
  return candidate;
}
