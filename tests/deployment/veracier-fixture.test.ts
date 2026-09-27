/**
 * The Véracier fixture (fixtures/veracier): what its committed overlay promises, and — against a
 * running fixture stack — that its sample loads through the real paths, reloads as a no-op, and
 * shows access control to the people it names.
 *
 * Always run (committed data only): the overlay is internally consistent. Every document has a
 * classification from the rule table the README reproduces; no person is granted a document above
 * their clearance, and no grant is recorded where the role's organization-wide ceiling already
 * reaches; every record names a real actor, real evidence and real references; the sample covers
 * every entity, top-level folder kind, format and classification.
 *
 * Run when the corpus is present (/mnt/4tb/data/veracier or KF_VERACIER_CORPUS): regenerating the
 * overlay from the corpus reproduces the committed files byte for byte (`--check`).
 *
 * Run when KF_VERACIER_LIVE=1 and the stack is up (fixtures/veracier/stack/stack.sh up): the
 * sample load, a second load that must record nothing new, and the same search as the CEO and as
 * the Casablanca plant supervisor. Skipped otherwise, and the skip says why: CI has neither the
 * corpus nor a Keycloak, and a test that pretended to exercise them would be worse than none.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CLASSIFICATION_RULES, ENTITIES } from '../../fixtures/veracier/overlay-source.mjs';
import { classify, headingOf } from '../../fixtures/veracier/generate-overlay.mjs';
import { keywordQuery } from '../../fixtures/veracier/search-baseline.mjs';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const HERE = join(ROOT, 'fixtures', 'veracier');
const OVERLAY = join(HERE, 'overlay');
const read = <T>(name: string): T => JSON.parse(readFileSync(join(OVERLAY, name), 'utf8')) as T;

interface Person {
  key: string;
  name: string;
  entity: string;
  role: string;
  clearance: string;
  ceiling: string;
  scope: 'group' | 'entity';
  persona?: string;
  asker?: string;
}
interface Doc {
  doc_id: string;
  entity: string;
  path: string;
  title: string;
  classification: string;
  classification_rule: string;
  language: string;
  format: string;
  readers: string[];
  questions: string[];
}
interface RecordSpec {
  ref: string;
  type: string;
  actor: string;
  entity: string;
  classification: string;
  evidence?: string[];
  readers: string[];
}

const RANK: Readonly<Record<string, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};
const ROLES = new Set([
  'project_owner',
  'technical_authority',
  'design_authority',
  'work_order_manager',
  'performer',
  'reviewer',
  'finance_approver',
  'quality_authority',
  'configuration_authority',
  'system_administrator',
]);

const people = read<Person[]>('people.json');
const documents = read<Doc[]>('documents.json');
const { records } = read<{ records: RecordSpec[] }>('records.json');
const sample = new Set(read<{ doc_ids: string[] }>('sample.json').doc_ids);
const byKey = new Map(people.map((p) => [p.key, p]));

describe('the Véracier overlay', () => {
  it('names a company of people in the ontology’s roles, each with one clearance and ceiling', () => {
    expect(people.length).toBeGreaterThanOrEqual(40);
    expect(new Set(people.map((p) => p.key)).size).toBe(people.length);
    for (const p of people) {
      expect(ROLES.has(p.role), `${p.key} role ${p.role}`).toBe(true);
      expect(RANK[p.clearance], p.key).toBeDefined();
      expect(RANK[p.ceiling]! <= RANK[p.clearance]!, `${p.key} ceiling above clearance`).toBe(true);
      // A subsidiary's people read the group only as far as it publishes; the rest is granted.
      if (p.scope === 'entity') expect(p.ceiling, p.key).toBe('public');
    }
    // The personas the documentation names exist.
    for (const persona of [
      'ceo',
      'cfo',
      'ciso',
      'quality',
      'aero-engineer',
      'casablanca-supervisor',
      'sales',
      'records',
    ]) {
      expect(
        people.some((p) => p.persona === persona),
        persona,
      ).toBe(true);
    }
  });

  it('classifies every document by the rule table, and grants none above a clearance', () => {
    expect(documents).toHaveLength(1004);
    for (const d of documents) {
      expect(classify(d.entity, d.path).classification, d.doc_id).toBe(d.classification);
      for (const reader of d.readers) {
        const person = byKey.get(reader);
        expect(person, `${d.doc_id} reader ${reader}`).toBeDefined();
        expect(RANK[d.classification]! <= RANK[person!.clearance]!, `${d.doc_id} → ${reader}`).toBe(
          true,
        );
        // A grant where the role already reaches would be a second, unexplained authority.
        expect(RANK[d.classification]! > RANK[person!.ceiling]!, `${d.doc_id} → ${reader}`).toBe(
          true,
        );
      }
    }
    // The access-control demonstration the README describes holds in the data.
    const supervisor = people.find((p) => p.persona === 'casablanca-supervisor')!;
    const restrictedDefence = documents.filter(
      (d) => d.entity === 'veracier_defense' && d.classification === 'restricted',
    );
    expect(restrictedDefence.length).toBeGreaterThan(0);
    expect(restrictedDefence.some((d) => d.readers.includes(supervisor.key))).toBe(false);
    const board = documents.filter((d) => d.path.startsWith('gouvernance/'));
    expect(board.length).toBeGreaterThan(0);
    for (const d of board) expect(d.readers, d.doc_id).toEqual([]);
  });

  it('has a rule for every folder, and the catch-all last', () => {
    expect(CLASSIFICATION_RULES.at(-1)).toMatchObject({ match: '', classification: 'internal' });
    for (const d of documents) {
      expect(
        d.classification_rule === '(default)' ||
          d.path.includes(d.classification_rule.split(':').pop()!),
      ).toBe(true);
    }
  });

  it('gives every record a real actor, real evidence and a team no wider than their clearance', () => {
    const docIds = new Set(documents.map((d) => d.doc_id));
    expect(new Set(records.map((r) => r.ref)).size).toBe(records.length);
    for (const r of records) {
      expect(byKey.has(r.actor), `${r.ref} actor`).toBe(true);
      expect(ENTITIES[r.entity as keyof typeof ENTITIES], `${r.ref} entity`).toBeDefined();
      for (const e of r.evidence ?? []) expect(docIds.has(e), `${r.ref} evidence ${e}`).toBe(true);
      for (const reader of r.readers) {
        expect(RANK[r.classification]! <= RANK[byKey.get(reader)!.clearance]!, `${r.ref}`).toBe(
          true,
        );
      }
    }
    const kinds = new Set(records.map((r) => r.type));
    for (const kind of [
      'create_initiative',
      'create_work_package',
      'record_engagement',
      'define_requirement',
      'register_test',
      'identify_risk',
      'raise_nonconformity',
      'open_capa',
      'submit_document_for_review',
      'propose_decision',
      'register_product_system',
      'define_baseline',
      'record_observation',
    ]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });

  it('samples every entity, folder kind, format and classification, and every record’s evidence', () => {
    const chosen = documents.filter((d) => sample.has(d.doc_id));
    expect(chosen.length).toBeGreaterThanOrEqual(60);
    expect(chosen.length).toBeLessThanOrEqual(90);
    const cover = (f: (d: Doc) => string) => new Set(chosen.map(f));
    const all = (f: (d: Doc) => string) => new Set(documents.map(f));
    for (const f of [
      (d: Doc) => d.entity,
      (d: Doc) => d.path.split('/')[0]!.replace(/_\d+$/, '_uc'),
      (d: Doc) => d.format,
      (d: Doc) => d.classification,
    ]) {
      expect([...all(f)].filter((v) => !cover(f).has(v))).toEqual([]);
    }
    for (const r of records)
      for (const e of r.evidence ?? []) expect(sample.has(e), `${r.ref} ${e}`).toBe(true);
  });

  it('derives titles from a document’s own heading, and keyword queries without stopwords', () => {
    expect(
      headingOf(
        '  Veracier Aero S.A.S.   RCS Toulouse 523 198 472\nV   8 Rue des Ailes\n' +
          '      RAPPORT DE NON-CONFORMITE (RNC)\n Texte courant.\n',
      ),
    ).toBe('RAPPORT DE NON-CONFORMITE (RNC)');
    expect(headingOf('no heading here at all\n')).toBeUndefined();
    expect(keywordQuery('Quels contrats arrivent à échéance dans les 6 prochains mois?')).toBe(
      'contrats or arrivent or echeance or prochains or mois',
    );
  });
});

const corpus = process.env['KF_VERACIER_CORPUS'] ?? '/mnt/4tb/data/veracier';
const haveCorpus =
  existsSync(join(corpus, 'MASTER_INDEX.csv')) && existsSync(join(corpus, 'text', 'manifest.json'));

describe.skipIf(!haveCorpus)('the overlay regenerated from the corpus (needs the corpus)', () => {
  it('reproduces the committed files byte for byte', { timeout: 120_000 }, async () => {
    const { stdout } = await run(
      process.execPath,
      [join(HERE, 'generate-overlay.mjs'), '--corpus', corpus, '--check'],
      { cwd: ROOT },
    );
    expect(stdout).toContain('"documents":1004');
  });
});

const live = process.env['KF_VERACIER_LIVE'] === '1';

describe.skipIf(!live)(
  'the sample, loaded into a running fixture stack (KF_VERACIER_LIVE=1)',
  () => {
    it(
      'loads through the real paths, and a second load records nothing new',
      { timeout: 1_800_000 },
      async () => {
        const first = await run(process.execPath, [join(HERE, 'load.mjs'), '--sample'], {
          cwd: ROOT,
          maxBuffer: 16 * 1024 * 1024,
        });
        expect(first.stdout).toContain('== summary');
        expect(first.stdout).not.toMatch(/REFUSED/);
        const second = await run(process.execPath, [join(HERE, 'load.mjs'), '--sample'], {
          cwd: ROOT,
          maxBuffer: 16 * 1024 * 1024,
        });
        expect(second.stdout).toContain('nothing new: this database already held the fixture');
      },
    );

    it(
      'shows the CEO more than the Casablanca supervisor for the same search, and says what it withheld',
      { timeout: 120_000 },
      async () => {
        const { PersonaSession } = await import('../../fixtures/veracier/lib/kf.mjs');
        const state =
          process.env['KF_VERACIER_STATE'] ?? join(homedir(), '.local', 'state', 'kf-veracier');
        const ids = JSON.parse(readFileSync(join(state, 'veracier-ids.json'), 'utf8')) as {
          organizationId: string;
          people: Record<string, { assignmentId: string }>;
        };
        const personas =
          process.env['KF_VERACIER_PERSONAS'] ??
          join(homedir(), '.config', 'kf', 'veracier-personas.txt');
        const passwords = new Map(
          readFileSync(personas, 'utf8')
            .split('\n')
            .filter((line) => line !== '' && !line.startsWith('#'))
            .map((line) => line.split('\t').slice(0, 2) as [string, string]),
        );
        const search = async (persona: string) => {
          const person = people.find((p) => p.persona === persona)!;
          const session = new PersonaSession({
            oidc: {
              issuer: 'http://localhost:18080/realms/knowledge-fabric',
              clientId: 'knowledge-fabric-web',
              redirectUri: 'http://localhost:3100/auth/callback',
            },
            apiOrigin: 'http://127.0.0.1:4100',
            person,
            password: passwords.get(person.key),
            organizationId: ids.organizationId,
            assignmentId: ids.people[person.key]!.assignmentId,
          });
          return (await session.request('GET', '/search?q=qualite&limit=200')).body as {
            lexical: { total: number };
            withheldCount: number;
          };
        };
        const ceo = await search('ceo');
        const supervisor = await search('casablanca-supervisor');
        expect(ceo.lexical.total).toBeGreaterThan(supervisor.lexical.total);
        expect(ceo.withheldCount).toBe(0);
        expect(supervisor.withheldCount).toBeGreaterThan(0);
      },
    );
  },
);
