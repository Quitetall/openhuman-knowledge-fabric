export type SemanticChange =
  | { readonly kind: 'added'; readonly path: string; readonly after: unknown }
  | { readonly kind: 'removed'; readonly path: string; readonly before: unknown }
  | {
      readonly kind: 'changed';
      readonly path: string;
      readonly before: unknown;
      readonly after: unknown;
    };

export interface SemanticDiff {
  readonly changes: readonly SemanticChange[];
  readonly truncated: boolean;
}

const MAX_CHANGES = 250;
const MAX_VISITED_VALUES = 10_000;
const MAX_DEPTH = 64;
const MAX_STRING_LENGTH = 4_096;

function pointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    return { omitted: 'large_string', length: value.length };
  }
  if (Array.isArray(value))
    return { omitted: 'composite_value', kind: 'array', length: value.length };
  if (isRecord(value)) {
    return { omitted: 'composite_value', kind: 'object', keyCount: Object.keys(value).length };
  }
  return value;
}

/** Produce a deterministic, bounded leaf-level JSON-pointer diff for retained semantic graphs. */
export function diffSemanticGraphs(before: unknown, after: unknown): SemanticDiff {
  const changes: SemanticChange[] = [];
  let visited = 0;
  let truncated = false;

  const add = (change: SemanticChange): void => {
    if (changes.length >= MAX_CHANGES) {
      truncated = true;
      return;
    }
    changes.push(change);
  };

  const missing = (kind: 'added' | 'removed', item: unknown, path: string, depth: number): void => {
    visited += 1;
    if (visited > MAX_VISITED_VALUES || depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    if (Array.isArray(item) && item.length > 0) {
      for (let index = 0; index < item.length && !truncated; index += 1) {
        missing(kind, item[index], `${path}/${index}`, depth + 1);
      }
      return;
    }
    if (isRecord(item) && Object.keys(item).length > 0) {
      for (const key of Object.keys(item).sort()) {
        if (truncated) break;
        missing(kind, item[key], `${path}/${pointerPart(key)}`, depth + 1);
      }
      return;
    }
    if (kind === 'added') add({ kind, path, after: boundedValue(item) });
    else add({ kind, path, before: boundedValue(item) });
  };

  const visit = (left: unknown, right: unknown, path: string, depth: number): void => {
    visited += 1;
    if (visited > MAX_VISITED_VALUES || depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    if (Object.is(left, right)) return;

    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length && !truncated; index += 1) {
        const childPath = `${path}/${index}`;
        if (index >= left.length) missing('added', right[index], childPath, depth + 1);
        else if (index >= right.length) {
          missing('removed', left[index], childPath, depth + 1);
        } else visit(left[index], right[index], childPath, depth + 1);
      }
      return;
    }

    if (isRecord(left) && isRecord(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) {
        if (truncated) break;
        const childPath = `${path}/${pointerPart(key)}`;
        if (!(key in left)) missing('added', right[key], childPath, depth + 1);
        else if (!(key in right)) {
          missing('removed', left[key], childPath, depth + 1);
        } else visit(left[key], right[key], childPath, depth + 1);
      }
      return;
    }

    add({
      kind: 'changed',
      path: path === '' ? '/' : path,
      before: boundedValue(left),
      after: boundedValue(right),
    });
  };

  visit(before, after, '', 0);
  return { changes, truncated };
}
