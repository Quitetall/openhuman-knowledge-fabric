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
  readonly commit: string;
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

export function collectOverview(root: string, commit: string): OverviewFacts {
  const sas = readFileSync(
    join(root, 'docs', 'sas', 'KF_Software_Architecture_Specification.md'),
    'utf8',
  );
  const claimed = claimedRequirements(root);
  const withExit = phasesWithExit(root);

  // §106 is the requirements index: `### Group` headings, then `| ID | text |` rows.
  const index = sas.split('## 106.')[1] ?? '';
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

  const gaps: { id: string; text: string }[] = [];
  for (const m of sas.matchAll(/^\*\*(100\.\d+) ([^*]+?)\*\*/gm)) {
    gaps.push({ id: m[1]!, text: m[2]!.trim().replace(/\s+/g, ' ') });
  }

  const { revision, digest, acceptedAt, acceptedBy } = revisionFacts(root);
  const total = groups.reduce((n, g) => n + g.total, 0);

  return {
    revision,
    digest,
    acceptedAt,
    acceptedBy,
    commit,
    requirementTotal: total,
    requirementClaimed: groups.reduce((n, g) => n + g.claimed, 0),
    groups,
    phases,
    gaps,
    warrants: warrantList(root),
  };
}
