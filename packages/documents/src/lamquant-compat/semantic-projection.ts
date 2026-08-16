import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { compareCanonicalText } from '@kf/canonicalization';
import {
  type LamQuantCompatibilityFileSystem,
  type LamQuantNamedDigest,
  type LamQuantSemanticProjection,
} from './contracts.js';
import { parseComposeProfile, reject, type ComposeParent } from './compose-profile.js';
import { normalizeMarkdown } from './normalize-markdown.js';
import {
  collectAdrs,
  normalizeDocLink,
  readAtom,
  readLedger,
  readText,
  readTopics,
  validateTopics,
  type AtomRecord,
} from './source-contracts.js';

export async function buildSourceSemanticProjection(
  root: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<LamQuantSemanticProjection> {
  const compose = parseComposeProfile(await readText(root, 'docs/compose.toml', fileSystem));
  const topics = await readTopics(root, fileSystem);
  const ledger = await readLedger(root, fileSystem);
  const atoms = await readAtoms(root, compose, fileSystem);
  const atomMembership = uniqueAtomMembership(compose, atoms);
  const parentOutputs = await composeParents(root, compose, atoms, ledger, topics);
  const atomTopicMembership = collectAtomTopics(compose, atoms, topics);
  const adrs = await collectAdrs(root, topics, fileSystem);
  return {
    atomMembership,
    parentOutputs,
    topics: [...topics].sort(compareCanonicalText),
    topicMembership: sorted([
      ...collectParentTopics(compose, atoms),
      ...atomTopicMembership,
      ...adrs.topicMembership,
    ]),
    ledgerBindings: await collectLedgerBindings(root, compose, atoms, ledger, fileSystem),
    deprecations: collectDeprecations(compose, atoms),
    adrInventory: adrs.inventory,
    adrViews: ['docs/ADR_OVERVIEW.md', 'docs/topics/adr-index.md', 'docs/topics/adr-digest.md'],
    traceability: await collectTraceability(root, fileSystem),
    bookOrder: await readMasterOrder(root, fileSystem),
  };
}

async function composeParents(
  root: string,
  parents: readonly ComposeParent[],
  atoms: ReadonlyMap<string, AtomRecord>,
  ledger: ReadonlyMap<string, string>,
  topics: ReadonlySet<string>,
): Promise<readonly LamQuantNamedDigest[]> {
  const outputs: LamQuantNamedDigest[] = [];
  for (const parent of parents) {
    const bodies: string[] = [];
    const parentTopics = new Set(parent.topics);
    for (const path of parent.atoms) {
      const atom = mustAtom(atoms, path);
      validateTopics(atom.topics, path, topics);
      if (atom.deprecated) continue;
      for (const topic of atom.topics) parentTopics.add(topic);
      bodies.push(
        resolveLedger(
          atom.body.replace(/\n*$/, '') + supersedesLinks(root, parent.file, atom, atoms),
          ledger,
          path,
        ),
      );
    }
    validateTopics([...parentTopics], parent.file, topics);
    outputs.push({
      path: parent.file,
      sha256: digest(normalizeMarkdown(`# ${parent.title}\n\n${bodies.join('\n\n')}`)),
    });
  }
  return outputs.sort((left, right) => compareCanonicalText(left.path, right.path));
}

function uniqueAtomMembership(
  parents: readonly ComposeParent[],
  atoms: ReadonlyMap<string, AtomRecord>,
): readonly string[] {
  const owners = new Map<string, string>();
  const entries: string[] = [];
  for (const parent of parents) {
    let activeIndex = 0;
    parent.atoms.forEach((atom) => {
      const existing = owners.get(atom);
      if (existing !== undefined)
        reject(`atom '${atom}' is owned by both '${existing}' and '${parent.file}'`);
      owners.set(atom, parent.file);
      const atomRecord = mustAtom(atoms, atom);
      if (!atomRecord.deprecated) entries.push(record(parent.file, activeIndex++, atom));
    });
  }
  return sorted(entries);
}

function collectAtomTopics(
  parents: readonly ComposeParent[],
  atoms: ReadonlyMap<string, AtomRecord>,
  topics: ReadonlySet<string>,
): readonly string[] {
  const memberships: string[] = [];
  const parentByAtom = new Map(
    parents.flatMap((parent) => parent.atoms.map((atom) => [atom, parent])),
  );
  for (const path of new Set(parents.flatMap((parent) => parent.atoms))) {
    const atom = mustAtom(atoms, path);
    const parent = parentByAtom.get(path);
    if (parent === undefined || atom.deprecated) continue;
    validateTopics(atom.topics, path, topics);
    memberships.push(
      ...atom.topics.map((topic) => record(topic, 'atom', atom.title, parent.file, path)),
    );
  }
  return memberships;
}

function collectParentTopics(
  parents: readonly ComposeParent[],
  atoms: ReadonlyMap<string, AtomRecord>,
): readonly string[] {
  return parents.flatMap((parent) => {
    const topics = new Set(parent.topics);
    for (const path of parent.atoms) {
      const atom = mustAtom(atoms, path);
      if (!atom.deprecated) for (const topic of atom.topics) topics.add(topic);
    }
    return [...topics].map((topic) => record(topic, 'doc', parent.title, parent.file));
  });
}

async function collectLedgerBindings(
  root: string,
  parents: readonly ComposeParent[],
  atoms: ReadonlyMap<string, AtomRecord>,
  ledger: ReadonlyMap<string, string>,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<readonly string[]> {
  const bindings: string[] = [];
  for (const path of new Set(parents.flatMap((parent) => parent.atoms))) {
    if (mustAtom(atoms, path).deprecated) continue;
    const text = await readText(root, path, fileSystem);
    for (const match of text.matchAll(/\{\{ledger:([^}]+)}}/g)) {
      const id = match[1]!.trim();
      if (!ledger.has(id)) reject(`ledger binding '${id}' in '${path}' has no TRUTH_LEDGER entry`);
      bindings.push(record(path, id));
    }
  }
  return sorted(bindings);
}

function collectDeprecations(
  parents: readonly ComposeParent[],
  atoms: ReadonlyMap<string, AtomRecord>,
): readonly string[] {
  const owner = atomOwners(parents);
  return sorted(
    [...atoms.values()]
      .filter((atom) => atom.deprecated)
      .map((atom) => {
        const owned = owner.get(atom.path);
        if (owned === undefined) reject(`deprecated atom '${atom.path}' is not compose-owned`);
        return record(
          atom.path,
          atom.sha256,
          owned.parent,
          owned.index,
          atom.deprecatedOn ?? '',
          atom.supersededBy,
        );
      }),
  );
}

async function collectTraceability(
  root: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<readonly string[]> {
  const entries: string[] = [];
  const compose = parseComposeProfile(await readText(root, 'docs/compose.toml', fileSystem));
  const atoms = await readAtoms(root, compose, fileSystem);
  for (const parent of compose) {
    for (const path of parent.atoms) {
      const atom = mustAtom(atoms, path);
      if (atom.deprecated) continue;
      const hasLinks = Object.values(atom.links).some((values) => values.length > 0);
      if (hasLinks) {
        entries.push(
          record(
            traceTitle(atom.title),
            parent.node,
            atom.links.code.join(', ') || '—',
            atom.links.adr.join(', ') || '—',
            atom.links.hazard.join(', ') || '—',
            atom.links.test.join(', ') || '—',
          ),
        );
      }
    }
  }
  return sorted(entries);
}

function resolveLedger(
  markdown: string,
  ledger: ReadonlyMap<string, string>,
  path: string,
): string {
  return markdown.replace(/\{\{ledger:([^}]+)}}/g, (_, rawId: string) => {
    const id = rawId.trim();
    const value = ledger.get(id);
    if (value === undefined)
      reject(`ledger binding '${id}' in '${path}' has no TRUTH_LEDGER entry`);
    return value;
  });
}

async function readMasterOrder(
  root: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<readonly string[]> {
  const excluded = new Set(['atoms', 'topics', 'graph', '_dist']);
  const all = (await fileSystem.listFiles(join(root, 'docs')))
    .filter((path) => path.endsWith('.md') && !path.split('/').some((part) => excluded.has(part)))
    .map((path) => `docs/${path}`)
    .sort(compareCanonicalText);
  const order = ['docs/MASTER.md'];
  const seen = new Set(order);
  for (const path of markdownLinks(
    await readText(root, 'docs/MASTER.md', fileSystem),
    'docs/MASTER.md',
  )) {
    if (!all.includes(path) || seen.has(path)) continue;
    seen.add(path);
    order.push(path);
  }
  for (const path of all) {
    if (seen.has(path)) continue;
    seen.add(path);
    order.push(path);
  }
  return order;
}

function markdownLinks(markdown: string, from: string): readonly string[] {
  return [...markdown.matchAll(/\[[^\]]*]\(([^)]+)\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !/^[a-z]+:|^#/.test(target))
    .map((target) => normalizeDocLink(from, target));
}

async function readAtoms(
  root: string,
  parents: readonly ComposeParent[],
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<ReadonlyMap<string, AtomRecord>> {
  const atoms = new Map<string, AtomRecord>();
  const allAtoms = await listAtomPaths(root, fileSystem);
  const declared = new Set(parents.flatMap((parent) => parent.atoms));
  for (const path of allAtoms) {
    if (!declared.has(path)) reject(`atom '${path}' is not declared by docs/compose.toml`);
    atoms.set(path, await readAtom(root, path, fileSystem));
  }
  for (const path of declared)
    if (!atoms.has(path)) atoms.set(path, await readAtom(root, path, fileSystem));
  validateSupersession(atoms);
  return atoms;
}

function supersedesLinks(
  root: string,
  parentFile: string,
  atom: AtomRecord,
  atoms: ReadonlyMap<string, AtomRecord>,
): string {
  const links: string[] = [];
  for (const target of atom.supersedes) {
    const targetAtom = atoms.get(target);
    if (targetAtom === undefined || !targetAtom.deprecated) {
      reject(`${atom.path}: supersedes target ${target} is not a deprecated atom`);
    }
    const rel = relative(join(root, parentFile, '..'), join(root, target))
      .split('/')
      .join('/');
    links.push(`[${targetAtom.title}](${rel})`);
  }
  return links.length === 0
    ? ''
    : `\n\n> _Supersedes (deprecated, sequestered): ${links.join('; ')}._`;
}

function mustAtom(atoms: ReadonlyMap<string, AtomRecord>, path: string): AtomRecord {
  const atom = atoms.get(path);
  if (atom === undefined) reject(`missing parsed atom ${path}`);
  return atom;
}

async function listAtomPaths(
  root: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<readonly string[]> {
  return (await fileSystem.listFiles(join(root, 'docs/atoms')))
    .filter((path) => path.endsWith('.md'))
    .map((path) => `docs/atoms/${path}`)
    .sort(compareCanonicalText);
}

function atomOwners(
  parents: readonly ComposeParent[],
): ReadonlyMap<string, { parent: string; index: number }> {
  const out = new Map<string, { parent: string; index: number }>();
  for (const parent of parents)
    parent.atoms.forEach((atom, index) => out.set(atom, { parent: parent.file, index }));
  return out;
}

function validateSupersession(atoms: ReadonlyMap<string, AtomRecord>): void {
  for (const atom of atoms.values()) {
    for (const target of atom.supersedes) {
      const targetAtom = mustAtom(atoms, target);
      if (!targetAtom.deprecated)
        reject(`${atom.path}: supersedes target ${target} is not deprecated`);
      if (!targetAtom.supersededBy.includes(atom.path)) {
        reject(`${target}: superseded_by does not reciprocate ${atom.path}`);
      }
    }
    if (atom.deprecated && !atom.pureRemoval) {
      for (const owner of atom.supersededBy) {
        if (!mustAtom(atoms, owner).supersedes.includes(atom.path)) {
          reject(`${atom.path}: superseded_by target ${owner} does not supersede it`);
        }
      }
    }
  }
}

function traceTitle(title: string): string {
  return title.replace(/^STATUS\s*[:—-]\s*/i, '');
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort(compareCanonicalText);
}

function record(...fields: readonly unknown[]): string {
  return JSON.stringify(fields);
}
