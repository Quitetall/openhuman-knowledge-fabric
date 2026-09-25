/**
 * The fixture corpora beside Véracier (fixtures/enterprise-rag-bench, fixtures/drbench,
 * fixtures/theagentcompany) and what their committed overlays and samples promise:
 *
 *   - people: unique keys, roles from the ontology, a ceiling never above the clearance, the
 *     founder and the records office able to ingest anything (restricted/restricted); and across
 *     every corpus, one realm: no username or e-mail twice, no legal name twice
 *   - documents: every sample document classified by the rule table, and every need-to-know
 *     grant above the reader's ceiling and within their clearance (a grant where the role
 *     already reaches would be a second, unexplained authority; one above a clearance would be
 *     refused)
 *   - samples: covering what the tests and the isolation walk need
 *
 * Always run (committed data only). With the extracted corpora on this machine, the overlays
 * regenerate byte for byte (`generate-overlay.mjs --check`); skipped otherwise, and says why.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { Fixture, Person } from '../../fixtures/lib/fixture-types.mjs';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
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

async function fixtures(): Promise<Fixture[]> {
  const erb = await import('../../fixtures/enterprise-rag-bench/fixture.mjs');
  const tac = await import('../../fixtures/theagentcompany/fixture.mjs');
  const drb = await import('../../fixtures/drbench/fixture.mjs');
  return [
    await erb.fixture({ sample: true }),
    await tac.fixture({ sample: true }),
    ...(await drb.companiesIn(drb.SAMPLE_DIR)).map((c) => drb.fixtureOf(c, drb.SAMPLE_DIR)),
  ];
}

function checkPeople(f: Fixture): void {
  const keys = new Set(f.people.map((p) => p.key));
  expect(keys.size, `${f.corpus} keys`).toBe(f.people.length);
  for (const p of f.people) {
    expect(ROLES.has(p.role), `${f.corpus} ${p.key} role ${p.role}`).toBe(true);
    expect(RANK[p.ceiling]! <= RANK[p.clearance]!, `${f.corpus} ${p.key} ceiling`).toBe(true);
    expect(p.email.endsWith('.example'), `${f.corpus} ${p.key} email`).toBe(true);
  }
  for (const key of [f.founder, f.office]) {
    const p = f.people.find((x) => x.key === key)!;
    expect(p, `${f.corpus} ${key}`).toBeDefined();
    expect([p.clearance, p.ceiling], `${f.corpus} ${key} ingests anything`).toEqual([
      'restricted',
      'restricted',
    ]);
  }
}

function checkGrants(f: Fixture): void {
  const byKey = new Map<string, Person>(f.people.map((p) => [p.key, p]));
  for (const d of f.documents) {
    for (const reader of d.readers) {
      const p = byKey.get(reader);
      expect(p, `${f.corpus} ${d.key} reader ${reader}`).toBeDefined();
      expect(RANK[d.classification]! <= RANK[p!.clearance]!, `${d.key} → ${reader}`).toBe(true);
      expect(RANK[d.classification]! > RANK[p!.ceiling]!, `${d.key} → ${reader}`).toBe(true);
    }
    expect(d.reason.length).toBeLessThanOrEqual(2000);
    expect(d.title.length).toBeLessThanOrEqual(240);
    expect(existsSync(d.file), `${d.key} ${d.file}`).toBe(true);
    if (d.derived !== undefined) expect(existsSync(d.derived.file), d.derived.file).toBe(true);
  }
}

describe('the fixture corpora', () => {
  it('give every organization people the ontology knows, a founder and an office', async () => {
    for (const f of await fixtures()) checkPeople(f);
  });

  it('share one realm without collision: no username, e-mail or legal name twice', async () => {
    const all = await fixtures();
    const veracier = JSON.parse(
      readFileSync(join(ROOT, 'fixtures/veracier/overlay/people.json'), 'utf8'),
    ) as Person[];
    const people = [...all.flatMap((f) => f.people), ...veracier];
    // DRBench's people are per company; the same person can't be in two companies here.
    expect(new Set(people.map((p) => p.username)).size).toBe(people.length);
    expect(new Set(people.map((p) => p.email)).size).toBe(people.length);
    const names = [...all.map((f) => f.company.legal_name), 'Véracier Industries S.A.'];
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(all.map((f) => f.keyPrefix)).size).toBe(all.length);
  });

  it('grant only above a ceiling and within a clearance, and load files that exist', async () => {
    for (const f of await fixtures()) checkGrants(f);
  });

  it('EnterpriseRAG-Bench: its sample covers every source type and classification, and its questions’ documents', async () => {
    const { fixture } = await import('../../fixtures/enterprise-rag-bench/fixture.mjs');
    const { CLASSIFICATION_RULES, authorityOf, nameKey, mailParticipants } =
      await import('../../fixtures/enterprise-rag-bench/overlay-source.mjs');
    const f = await fixture({ sample: true });
    const stats = JSON.parse(
      readFileSync(join(ROOT, 'fixtures/enterprise-rag-bench/overlay/stats.json'), 'utf8'),
    ) as { by_source_type: Record<string, number>; by_classification: Record<string, number> };
    expect(new Set(f.raw.map((d) => d.source_type))).toEqual(
      new Set(Object.keys(stats.by_source_type)),
    );
    expect(new Set(f.raw.map((d) => d.classification))).toEqual(
      new Set(Object.keys(stats.by_classification)),
    );
    const questions = readFileSync(
      join(ROOT, 'fixtures/enterprise-rag-bench/sample/questions.jsonl'),
      'utf8',
    )
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { expected_doc_ids: string[]; question_type: string });
    expect(new Set(questions.map((q) => q.question_type)).size).toBe(10);
    const ids = new Set(f.raw.map((d) => d.doc_id));
    for (const q of questions)
      for (const id of q.expected_doc_ids) expect(ids.has(id), id).toBe(true);
    expect(CLASSIFICATION_RULES.at(-1)).toMatchObject({ match: '', classification: 'internal' });
    expect(f.people).toHaveLength(167);
    expect(authorityOf('People', 'HR Business Partner')).toMatchObject({
      clearance: 'restricted',
      ceiling: 'internal',
    });
    expect(authorityOf('Engineering', 'Chief Technology Officer')).toMatchObject({
      clearance: 'restricted',
      ceiling: 'restricted',
    });
    expect(nameKey("Dr. Grace O'Connor")).toBe('grace.oconnor');
    const byName = new Map(f.people.map((p) => [nameKey(p.name), p.key]));
    expect(
      mailParticipants(
        'From: Ava Chen <ava.chen@redwoodinference.com>\nTo: Someone Else <x@y.com>\n\nbody',
        byName,
      ),
    ).toEqual(['ava.chen']);
  });

  it('TheAgentCompany: its sample is the company’s own files, every classification, and the HR file KF refuses', async () => {
    const { fixture } = await import('../../fixtures/theagentcompany/fixture.mjs');
    const { SAMPLE_PATHS, classify, included } =
      await import('../../fixtures/theagentcompany/overlay-source.mjs');
    const f = await fixture({ sample: true });
    expect(f.raw.map((d) => d.path).sort()).toEqual([...SAMPLE_PATHS].sort());
    expect(new Set(f.documents.map((d) => d.classification))).toEqual(
      new Set(['public', 'internal', 'confidential', 'restricted']),
    );
    // Holds (fictional) social-security numbers: KF's content rules refuse it at ingest.
    expect(SAMPLE_PATHS).toContain('Documents/Admin/TAC_personell_data.csv');
    expect(classify('Documents/Human Resources Team/salary.txt').classification).toBe('restricted');
    expect(classify('Documents/Financials/Annual Reports/10Ks/apple-10k-2023.pdf')).toMatchObject({
      classification: 'public',
    });
    expect(included('Photos/Frog.jpg')).toBe(false);
    expect(included('Documents/Admin/gym.mp4')).toBe(false);
  });

  it('DRBench: three companies, three organizations, each sample task’s files, no password rendered', async () => {
    const drb = await import('../../fixtures/drbench/fixture.mjs');
    const { COMPANIES, SAMPLE_TASKS, classify } =
      await import('../../fixtures/drbench/overlay-source.mjs');
    const companies = await drb.companiesIn(drb.SAMPLE_DIR);
    expect(companies.map((c) => c.company.slug).sort()).toEqual(
      Object.values(COMPANIES)
        .map((c) => c.slug)
        .sort(),
    );
    const tasks = companies.flatMap((c) => c.tasks.map((t) => t.task)).sort();
    expect(tasks).toEqual([...SAMPLE_TASKS].sort());
    for (const c of companies) {
      const f = drb.fixtureOf(c, drb.SAMPLE_DIR);
      expect(f.corpus).toBe(`drbench-${c.company.slug}`);
      expect(f.personasCorpus).toBe('drbench');
      for (const d of f.documents) {
        if (d.mediaType === 'text/markdown' && d.file.includes('/text/'))
          expect(readFileSync(d.file, 'utf8')).not.toMatch(/_pwd\b|"password"/);
      }
    }
    expect(classify('employee-retention-analysis.pdf').classification).toBe('confidential');
    expect(classify('board-minutes-q3.docx').classification).toBe('restricted');
    expect(classify('store-layout-plan.pptx').classification).toBe('internal');
  });
});

const corpora = [
  [
    'enterprise-rag-bench',
    process.env['KF_ERB_CORPUS'] ?? '/mnt/4tb/data/enterprise-rag-bench',
    'selection.json',
  ],
  [
    'theagentcompany',
    process.env['KF_TAC_CORPUS'] ?? '/mnt/4tb/data/theagentcompany',
    'manifest.json',
  ],
  ['drbench', process.env['KF_DRBENCH_CORPUS'] ?? '/mnt/4tb/data/drbench', 'manifest.json'],
] as const;

for (const [name, corpus, marker] of corpora) {
  describe.skipIf(!existsSync(join(corpus, marker)))(
    `the ${name} overlay regenerated from the corpus (needs ${corpus})`,
    () => {
      it(
        'reproduces the committed overlay and sample byte for byte',
        { timeout: 300_000 },
        async () => {
          await run(
            process.execPath,
            [join(ROOT, 'fixtures', name, 'generate-overlay.mjs'), '--corpus', corpus, '--check'],
            { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
          );
        },
      );
    },
  );
}
