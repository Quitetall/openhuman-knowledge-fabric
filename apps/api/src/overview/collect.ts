/**
 * The overview's facts, read from committed files and nothing else.
 *
 * Every number on the generated page comes from a file in this repository. That is the whole
 * design: the README's status block went two signatures stale within days because a human had to
 * remember to edit it, and `docs/path-to-daily-use.md` says in its own text that its counts were
 * measured on one date and will move. A page assembled by hand has the same failure mode and no
 * gate can catch it.
 *
 * So this module parses the specification rather than restating it. When the specification gains
 * a requirement, a phase or a gap, the page gains it too, with no edit here.
 *
 * It deliberately does NOT reach the database or the host. A projection that reads live state
 * cannot be regenerated from a clone and compared, which is the property that makes drift
 * detectable at all.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RequirementGroup {
  readonly title: string;
  readonly total: number;
  /** Requirement ids in this group that some Warrant declares it implements. */
  readonly claimed: number;
}

export interface Phase {
  readonly number: number;
  readonly title: string;
  /** True when a Warrant names this phase in a `[[roadmap]]` ref. */
  readonly hasExitWarrant: boolean;
}

export interface OverviewFacts {
  readonly revision: string;
  readonly digest: string;
  readonly acceptedAt: string;
  readonly acceptedBy: string;
  /**
   * A digest over the files this page is a projection OF — the specification and every Warrant
   * manifest — and not over the page or the commit containing it.
   *
   * The commit was the obvious identity and is the wrong one: committing the page moves HEAD, so
   * a page carrying its own commit is stale the moment it lands, and the drift check fails on
   * every commit forever. §77 records the same shape one level up — a manifest cannot contain
   * its own digest, so verifying it is a separate act.
   */
  readonly sourceDigest: string;
  readonly requirementTotal: number;
  readonly requirementClaimed: number;
  readonly groups: readonly RequirementGroup[];
  readonly phases: readonly Phase[];
  readonly gaps: readonly { readonly id: string; readonly text: string }[];
  readonly warrants: readonly { readonly alias: string; readonly title: string }[];
}

/** The accepted revision, or the newest proposed one when none is accepted. */
function revisionFacts(root: string): {
  revision: string;
  digest: string;
  acceptedAt: string;
  acceptedBy: string;
} {
  const dir = join(root, 'docs', 'sas', 'revisions');
  if (!existsSync(dir)) return { revision: 'none', digest: '', acceptedAt: '', acceptedBy: '' };
  let best = { revision: 'none', digest: '', acceptedAt: '', acceptedBy: '' };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.toml')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    if (!/^state\s*=\s*"accepted"/m.test(text)) continue;
    best = {
      revision: /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? name.replace('.toml', ''),
      digest: /^sha256\s*=\s*"([0-9a-f]{64})"/m.exec(text)?.[1] ?? '',
      acceptedAt: (/^effective_time\s*=\s*"([^"T]+)/m.exec(text)?.[1] ?? '').trim(),
      acceptedBy: /^accepted_by\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? '',
    };
  }
  return best;
}

/** Requirement ids every Warrant declares, so the page can say claimed rather than satisfied. */
function claimedRequirements(root: string): ReadonlySet<string> {
  const dir = join(root, 'docs', 'warrants');
  const claimed = new Set<string>();
  if (!existsSync(dir)) return claimed;
  for (const alias of readdirSync(dir)) {
    const manifest = join(dir, alias, 'manifest.toml');
    if (!existsSync(manifest)) continue;
    for (const m of readFileSync(manifest, 'utf8').matchAll(/sas:\/\/([A-Z]+-SAS-RQ-\d+)/g)) {
      claimed.add(m[1]!);
    }
  }
  return claimed;
}

function warrantList(root: string): { alias: string; title: string }[] {
  const dir = join(root, 'docs', 'warrants');
  if (!existsSync(dir)) return [];
  const out: { alias: string; title: string }[] = [];
  for (const alias of readdirSync(dir).sort()) {
    const manifest = join(dir, alias, 'manifest.toml');
    if (!existsSync(manifest)) continue;
    const title = /^title\s*=\s*"([^"]+)"/m.exec(readFileSync(manifest, 'utf8'))?.[1] ?? alias;
    out.push({ alias, title });
  }
  return out;
}

/** Phase numbers some Warrant names through a roadmap ref. */
function phasesWithExit(root: string): ReadonlySet<number> {
  const dir = join(root, 'docs', 'warrants');
  const named = new Set<number>();
  if (!existsSync(dir)) return named;
  for (const alias of readdirSync(dir)) {
    const manifest = join(dir, alias, 'manifest.toml');
    if (!existsSync(manifest)) continue;
    for (const m of readFileSync(manifest, 'utf8').matchAll(/roadmap:\/\/[A-Z]+-PHASE-(\d+)/g)) {
      named.add(Number(m[1]));
    }
  }
  return named;
}

export function collectOverview(root: string): OverviewFacts {
  const sas = readFileSync(
    join(root, 'docs', 'sas', 'KF_Software_Architecture_Specification.md'),
    'utf8',
  );
  const claimed = claimedRequirements(root);
  const withExit = phasesWithExit(root);

  // §106 is the requirements index: `### Group` headings, then `| ID | text |` rows.
  //
  // Fail closed on every parse below. A renamed heading, a stray `#`, an en dash where a hyphen
  // was — any of those makes a regex match nothing, and the page would then render `0 / 0`
  // requirements and no gaps: a plausible empty state nobody investigates. This tool exists to
  // catch the specification drifting; silently reporting zero when it cannot read the
  // specification is the exact failure it was built to prevent.
  const index = sas.split('## 106.')[1] ?? '';
  if (index === '') {
    throw new Error(
      'the specification has no `## 106.` requirements index. Either the heading was renamed ' +
        'or the file is not the specification; either way this page cannot be generated.',
    );
  }
  const groups: RequirementGroup[] = [];
  let current: { title: string; ids: string[] } | undefined;
  for (const line of index.split('\n')) {
    const heading = /^### (.+)$/.exec(line);
    if (heading !== null) {
      if (current !== undefined) {
        groups.push({
          title: current.title,
          total: current.ids.length,
          claimed: current.ids.filter((id) => claimed.has(id)).length,
        });
      }
      current = { title: heading[1]!.trim(), ids: [] };
      continue;
    }
    const row = /^\|\s*(KF-SAS-RQ-\d+)\s*\|/.exec(line);
    if (row !== null && current !== undefined) current.ids.push(row[1]!);
  }
  if (current !== undefined) {
    groups.push({
      title: current.title,
      total: current.ids.length,
      claimed: current.ids.filter((id) => claimed.has(id)).length,
    });
  }

  const phases: Phase[] = [];
  for (const m of sas.matchAll(/^### Phase (\d+) — (.+)$/gm)) {
    const number = Number(m[1]);
    phases.push({ number, title: m[2]!.trim(), hasExitWarrant: withExit.has(number) });
  }
  if (phases.length === 0) {
    throw new Error(
      'no `### Phase N — Title` headings found in §98. The em dash in that heading is load ' +
        'bearing and a hyphen will not match.',
    );
  }

  const gaps: { id: string; text: string }[] = [];
  for (const m of sas.matchAll(/^\*\*(100\.\d+) ([^*]+?)\*\*/gm)) {
    gaps.push({ id: m[1]!, text: m[2]!.trim().replace(/\s+/g, ' ') });
  }
  if (gaps.length === 0) {
    throw new Error(
      'no `**100.N …**` entries found in §100. A specification with no recorded gaps is not a ' +
        'clean one, it is one this parser could not read.',
    );
  }

  const { revision, digest, acceptedAt, acceptedBy } = revisionFacts(root);
  if (groups.length === 0) {
    throw new Error('§106 parsed no requirement groups; the index shape changed.');
  }

  // Inputs in a fixed order, each length-prefixed so two files cannot be confused for one.
  const hash = createHash('sha256').update('kf-overview-v1');
  hash.update(sas);
  for (const alias of existsSync(join(root, 'docs', 'warrants'))
    ? readdirSync(join(root, 'docs', 'warrants')).sort()
    : []) {
    const manifest = join(root, 'docs', 'warrants', alias, 'manifest.toml');
    if (!existsSync(manifest)) continue;
    hash.update(`\u0000${alias}\u0000`);
    hash.update(readFileSync(manifest));
  }
  const total = groups.reduce((n, g) => n + g.total, 0);

  return {
    revision,
    digest,
    acceptedAt,
    acceptedBy,
    sourceDigest: hash.digest('hex'),
    requirementTotal: total,
    requirementClaimed: groups.reduce((n, g) => n + g.claimed, 0),
    groups,
    phases,
    gaps,
    warrants: warrantList(root),
  };
}
