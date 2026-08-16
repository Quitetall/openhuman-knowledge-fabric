import { LamQuantCompatibilityRejected } from './contracts.js';
import { normalizeRelativePath } from './relative-paths.js';

export interface ComposeParent {
  readonly file: string;
  readonly node: string;
  readonly title: string;
  readonly parent: string;
  readonly topics: readonly string[];
  readonly atoms: readonly string[];
}

export function parseComposeProfile(toml: string): readonly ComposeParent[] {
  const parents: ComposeParent[] = [];
  let current: Partial<ComposeParent> | undefined;
  let arrayKey: 'topics' | 'atoms' | undefined;
  let arrayValues: string[] = [];

  function finishArray(): void {
    if (current === undefined || arrayKey === undefined) return;
    current = { ...current, [arrayKey]: arrayValues };
    arrayKey = undefined;
    arrayValues = [];
  }
  function finishParent(): void {
    finishArray();
    if (current === undefined) return;
    const parent = assertParent(current);
    if (parents.some((item) => item.file === parent.file)) {
      reject(`compose.toml declares parent '${parent.file}' more than once`);
    }
    parents.push(parent);
  }

  for (const rawLine of toml.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (arrayKey !== undefined) {
      arrayValues.push(...quotedItems(line));
      if (line.includes(']')) finishArray();
      continue;
    }
    if (line === '[[parent]]') {
      finishParent();
      current = {};
      continue;
    }
    if (current === undefined) reject('compose.toml must use [[parent]] tables');
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (match === null) reject(`unsupported compose.toml line '${line}'`);
    const key = match[1]!;
    const value = match[2]!;
    if (
      key !== 'file' &&
      key !== 'node' &&
      key !== 'title' &&
      key !== 'parent' &&
      key !== 'topics' &&
      key !== 'atoms' &&
      key !== 'diataxis' &&
      key !== 'status' &&
      key !== 'owner'
    ) {
      reject(`unsupported compose.toml key '${key}'`);
    }
    if (key === 'topics' || key === 'atoms') {
      arrayValues = [...quotedItems(value)];
      if (value.includes(']')) {
        current = { ...current, [key]: arrayValues };
        arrayValues = [];
      } else {
        arrayKey = key;
      }
    } else if (key !== 'diataxis' && key !== 'status' && key !== 'owner') {
      current = { ...current, [key]: quotedString(value, key) };
    }
  }
  if (arrayKey !== undefined) reject(`compose.toml has unterminated ${arrayKey} array`);
  finishParent();
  if (parents.length === 0) reject('compose.toml declares no parents');
  return parents;
}

function assertParent(parent: Partial<ComposeParent>): ComposeParent {
  const file = normalizeRelativePath(required(parent.file, 'file'), 'compose parent file');
  const atoms = requiredList(parent.atoms, file, 'atoms').map((path) =>
    normalizeRelativePath(path, 'compose atom path'),
  );
  if (!file.startsWith('docs/') || atoms.some((path) => !path.startsWith('docs/atoms/'))) {
    reject(`compose parent '${file}' has paths outside LamQuant docs contract`);
  }
  return {
    file,
    node: required(parent.node, 'node'),
    title: required(parent.title, 'title'),
    parent: required(parent.parent, 'parent'),
    topics: requiredList(parent.topics, file, 'topics'),
    atoms,
  };
}

function quotedItems(value: string): readonly string[] {
  return [...value.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2] ?? '');
}

function quotedString(value: string, key: string): string {
  const items = quotedItems(value);
  if (items.length !== 1) reject(`compose.toml key '${key}' must be a quoted string`);
  return items[0]!;
}

function required(value: string | undefined, key: string): string {
  if (value === undefined || value === '') reject(`compose.toml parent is missing '${key}'`);
  return value;
}

function requiredList(
  value: readonly string[] | undefined,
  parent: string,
  key: string,
): readonly string[] {
  if (value === undefined || value.length === 0) {
    reject(`compose parent '${parent}' is missing '${key}' entries`);
  }
  return value;
}

export function reject(message: string): never {
  throw new LamQuantCompatibilityRejected('unsupported_source_contract', message);
}
