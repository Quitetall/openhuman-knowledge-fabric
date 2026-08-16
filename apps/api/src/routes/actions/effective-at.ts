const CANONICAL_EFFECTIVE_AT =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;

export function parseEffectiveAt(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CANONICAL_EFFECTIVE_AT.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return undefined;
  }
  return new Date(milliseconds);
}
