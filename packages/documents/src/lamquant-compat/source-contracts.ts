import { createHash } from 'node:crypto';
import { dirname, join, normalize, sep } from 'node:path';
import { compareCanonicalText } from '@kf/canonicalization';
import { type LamQuantCompatibilityFileSystem } from './contracts.js';
import { reject } from './compose-profile.js';
import { parseFrontmatter, stringList, stringValue } from './frontmatter.js';

export interface AtomRecord {
  readonly path: string;
  readonly title: string;
  readonly topics: readonly string[];
  readonly body: string;
  readonly sha256: string;
  readonly deprecated: boolean;
  readonly deprecatedOn: string | undefined;
  readonly supersedes: readonly string[];
  readonly supersededBy: readonly string[];
  readonly pureRemoval: boolean;
  readonly links: Readonly<Record<'code' | 'adr' | 'hazard' | 'test', readonly string[]>>;
}

export interface AdrRecord {
  readonly path: string;
  readonly number: string;
  readonly summary: string;
  readonly status: string;
  readonly topics: readonly string[];
  readonly relations: string;
  readonly gate: 'declared' | 'debt' | 'none';
}

export async function readAtom(
  root: string,
  path: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<AtomRecord> {
  const bytes = await readBytes(root, path, fileSystem);
  const text = bytes.toString('utf8');
  const parsed = parseFrontmatter(text);
  if (stringValue(parsed.data.kind) !== 'atom')
    reject(`${path} is referenced as an atom but lacks kind: atom`);
  const deprecated = stringValue(parsed.data.status) === 'deprecated';
  if (deprecated !== path.includes('/deprecated/')) {
    reject(`${path}: status:deprecated must agree with a docs/atoms/<sub>/deprecated/ path`);
  }
  const deprecatedOn = stringValue(parsed.data.deprecated_on);
  const supersededBy = stringList(parsed.data.superseded_by);
  const pureRemoval = stringValue(parsed.data.pure_removal) === 'true';
  if (deprecated && deprecatedOn === undefined)
    reject(`${path}: deprecated atom lacks deprecated_on`);
  if (deprecated && supersededBy.length === 0 && !pureRemoval)
    reject(`${path}: deprecated atom lacks superseded_by or pure_removal:true`);
  return {
    path,
    title: stringValue(parsed.data.title) ?? path,
    topics: stringList(parsed.data.topics),
    body: parsed.body,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    deprecated,
    deprecatedOn,
    supersedes: stringList(parsed.data.supersedes),
    supersededBy,
    pureRemoval,
    links: parseLinks(text),
  };
}

export async function readTopics(
  root: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<ReadonlySet<string>> {
  const topics = new Set<string>();
  let inTopic = false;
  let sawSlug = false;
  for (const raw of (await readText(root, 'docs/topics.toml', fileSystem)).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === '[[topic]]') {
      if (inTopic && !sawSlug) reject('docs/topics.toml has a [[topic]] block without slug');
      inTopic = true;
      sawSlug = false;
      continue;
    }
    const match = /^(slug|desc)\s*=\s*(['"])(.*?)\2$/.exec(line);
    if (!inTopic || match === null) reject(`unsupported docs/topics.toml line '${line}'`);
    if (match[1] === 'slug') {
      if (sawSlug) reject('docs/topics.toml repeats slug in one [[topic]] block');
      if (topics.has(match[3]!)) reject(`docs/topics.toml repeats topic slug '${match[3]}'`);
      topics.add(match[3]!);
      sawSlug = true;
    }
  }
  if (!inTopic || !sawSlug || topics.size === 0)
    reject('docs/topics.toml declares no [[topic]] slugs');
  return topics;
}

export async function readLedger(
  root: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  let inSection2 = false;
  let valueColumn = -1;
  for (const line of (await readText(root, 'docs/TRUTH_LEDGER.md', fileSystem)).split('\n')) {
    if (/^## §2(?:\s|$)/.test(line)) {
      inSection2 = true;
      continue;
    }
    if (inSection2 && line.startsWith('## ')) break;
    if (!inSection2 || !line.trimStart().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.replaceAll('**', '').trim());
    if (cells.includes('Value')) {
      valueColumn = cells.indexOf('Value');
    } else if (valueColumn >= 0 && /^\d+\.\d+$/.test(cells[0] ?? '') && cells[valueColumn]) {
      out.set(cells[0]!, cells[valueColumn]!);
    }
  }
  return out;
}

export async function collectAdrs(
  root: string,
  topics: ReadonlySet<string>,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<{ readonly inventory: readonly string[]; readonly topicMembership: readonly string[] }> {
  const files = await listExisting(root, 'docs/decisions', fileSystem);
  const debt = await readClosureDebt(root, fileSystem);
  const inventory: string[] = [];
  const topicMembership: string[] = [];
  for (const file of files.filter((path) => /^\d{4}-.*\.md$/.test(path))) {
    const adr = await readAdr(root, `docs/decisions/${file}`, topics, debt, fileSystem);
    inventory.push(
      semanticRecord(
        adr.number,
        adr.path,
        adr.summary,
        adr.status,
        adr.gate,
        adr.relations,
        [...adr.topics].sort(compareCanonicalText),
      ),
    );
    topicMembership.push(
      ...adr.topics.map((topic) => semanticRecord(topic, 'adr', adr.number, adr.summary, adr.path)),
    );
  }
  return { inventory: sorted(inventory), topicMembership };
}

export function normalizeDocLink(from: string, target: string): string {
  const clean = target.split('#')[0]!;
  const resolved = normalize(join(dirname(from), clean))
    .split(sep)
    .join('/');
  return resolved.startsWith('docs/') ? resolved : `docs/${resolved}`;
}

export async function readText(
  root: string,
  path: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<string> {
  if ((await fileSystem.kind(join(root, path))) !== 'file')
    reject(`required LamQuant input '${path}' is missing`);
  return (await fileSystem.readFile(join(root, path))).toString('utf8');
}

export async function readBytes(
  root: string,
  path: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<Buffer> {
  if ((await fileSystem.kind(join(root, path))) !== 'file')
    reject(`required LamQuant input '${path}' is missing`);
  return fileSystem.readFile(join(root, path));
}

async function readAdr(
  root: string,
  path: string,
  topics: ReadonlySet<string>,
  debt: ReadonlySet<string>,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<AdrRecord> {
  const text = await readText(root, path, fileSystem);
  const parsed = parseFrontmatter(text);
  const number = /^docs\/decisions\/(\d{4})-/.exec(path)?.[1];
  if (number === undefined) reject(`ADR filename '${path}' must start with four digits`);
  const adrTopics = stringList(parsed.data.topics);
  validateTopics(adrTopics, path, topics);
  const status = stringValue(parsed.data.status) ?? 'unknown';
  const summary = /#\s+ADR\s+\d{4}\s*[:\-—–]\s*(.+)/.exec(parsed.body)?.[1]?.trim() ?? path;
  const gate = gateState(number, status, text, debt);
  return {
    path,
    number,
    summary,
    status,
    topics: adrTopics,
    gate,
    relations: relationString(parsed.data),
  };
}

function gateState(
  number: string,
  status: string,
  text: string,
  debt: ReadonlySet<string>,
): AdrRecord['gate'] {
  const active = status === 'accepted' || status === 'in-progress';
  const declared =
    /gate_cmd\s*:/i.test(text) && /(?:python3?|cargo|bash|sh|make|just|pnpm|npm|\.)\s+/i.test(text);
  if (declared) return 'declared';
  if (active && !debt.has(number))
    reject(`active ADR ${number} lacks runnable gate and closure debt ratchet`);
  return active ? 'debt' : 'none';
}

function relationString(data: Readonly<Record<string, string | readonly string[]>>): string {
  return ['supersedes', 'superseded_by', 'amends', 'amended_by', 'extends']
    .flatMap((key) => stringList(data[key]).map((value) => `${key}:${value}`))
    .join(',');
}

async function readClosureDebt(
  root: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<ReadonlySet<string>> {
  const text = await readText(root, 'tools/adr_closure_debt.toml', fileSystem);
  const match = /missing_gate\s*=\s*\[([\s\S]*?)\]/m.exec(text);
  return new Set(
    match === null ? [] : [...match[1]!.matchAll(/"(\d{4})"/g)].map((item) => item[1]!),
  );
}

function parseLinks(markdown: string): AtomRecord['links'] {
  const links = { code: [], adr: [], hazard: [], test: [] } as Record<
    'code' | 'adr' | 'hazard' | 'test',
    string[]
  >;
  const fm = markdown.startsWith('---\n')
    ? markdown.slice(4, markdown.indexOf('\n---', 4)).split('\n')
    : [];
  let inLinks = false;
  for (const line of fm) {
    if (/^\S/.test(line)) inLinks = line.trim() === 'links:';
    const match = /^\s+(code|adr|hazard|test):\s*\[(.*)\]\s*$/.exec(line);
    if (inLinks && match !== null)
      links[match[1] as keyof typeof links].push(...listItems(match[2]!));
  }
  return links;
}

function listItems(value: string): readonly string[] {
  return value
    .split(',')
    .map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter(Boolean);
}

export function validateTopics(
  values: readonly string[],
  path: string,
  topics: ReadonlySet<string>,
): void {
  for (const topic of values)
    if (!topics.has(topic)) reject(`unknown topic '${topic}' in '${path}'`);
}

async function listExisting(
  root: string,
  path: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<readonly string[]> {
  return (await fileSystem.kind(join(root, path))) === 'directory'
    ? fileSystem.listFiles(join(root, path))
    : [];
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort(compareCanonicalText);
}

function semanticRecord(...fields: readonly unknown[]): string {
  return JSON.stringify(fields);
}
