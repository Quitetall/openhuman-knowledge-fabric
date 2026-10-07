#!/usr/bin/env node
/**
 * What a role preset costs at the size of an organization (ADR 0040, KF-WAR-0005 STAGE-001).
 *
 * The question ADR 0016's note answers: should a role's preset reach its holders by being
 * EXPANDED on every read (a fifth source of `org.effective_access_grant`, recomputed through role
 * inclusion), or by being MATERIALIZED (an act that writes one `org.access_grant` row per holder
 * per template whenever a preset changes)? Both are measured here, against a running fixture stack
 * holding the multi fixture's 50 000-document organization (EnterpriseRAG-Bench, Redwood
 * Inference), through the real paths: the role names by `kf define-role`, the assignment by
 * `kf grant-authority`, every template and every grant by a dispatched act over the API.
 *
 *   recompute    reader A holds `scope_measure_a`, which includes `scope_measure_b`, which includes
 *                `scope_measure_c`, whose preset reads K confidential documents (depth-3 path)
 *   materialize  reader B, the same profile, is granted the same K documents one grant_access each
 *
 * Reported: the write cost (per act, and so per preset change for H holders), the coverage query
 * for each reader (EXPLAIN ANALYZE on the owner connection, the view expanded exactly as a read
 * expands it), and the end-to-end GET /dashboard and GET /master-document for both readers and for
 * the organization's widest reader. Numbers are WORKSTATION numbers.
 *
 *   KF_STACK_* (the stack), KF_SCOPE_MEASURE_K (default 2000)  node scripts/scope-preset-cost.mjs
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mapLimit, ownerSession, PersonaSession } from '../fixtures/lib/kf.mjs';
import { readPasswords, REPO } from '../fixtures/lib/loader.mjs';
import { personasFile, stackSettings } from '../fixtures/lib/stack.mjs';

const K = Number(process.env.KF_SCOPE_MEASURE_K ?? 2000);
const SAMPLES = Number(process.env.KF_SCOPE_MEASURE_SAMPLES ?? 15);
const settings = stackSettings();
process.env.PGPASSWORD ??= 'dev-only-not-a-secret';
const out = (line = '') => process.stdout.write(`${line}\n`);

const ids = JSON.parse(
  await readFile(path.join(settings.state, 'enterprise-rag-bench-ids.json'), 'utf8'),
);
const people = JSON.parse(
  await readFile(path.join(REPO, 'fixtures/enterprise-rag-bench/overlay/people.json'), 'utf8'),
);
const passwords = await readPasswords(personasFile('enterprise-rag-bench'));
const org = ids.organizationId;
const owner = ownerSession(REPO, settings.ownerUrl);

const session = (person, assignmentId) =>
  new PersonaSession({
    oidc: settings.oidc,
    apiOrigin: settings.api,
    person,
    password: passwords.get(person.username),
    organizationId: org,
    assignmentId: assignmentId ?? ids.people[person.key].assignmentId,
  });

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};
const ms = (n) => `${n.toFixed(1)} ms`;

async function timed(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function latency(label, s, route) {
  await s.request('GET', route); // warm-up, unmeasured
  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) samples.push(await timed(() => s.request('GET', route)));
  out(
    `| ${label} | \`GET ${route.split('?')[0]}\` | ${ms(quantile(samples, 0.5))} | ` +
      `${ms(quantile(samples, 0.95))} | ${ms(Math.max(...samples))} |`,
  );
}

async function coverageMs(personId) {
  const plan = await owner.scoped(
    org,
    `explain (analyze, format json)
     select g.source, g.source_id, g.scope_object_id, g.classification_ceiling, g.reason, g.role_path
       from org.effective_access_grant g
      where g.organization_id = $2 and g.capability = 'read' and g.scope_object_id is not null
        and g.valid_from <= now() and (g.valid_to is null or g.valid_to > now())
        and ((g.principal_kind = 'person' and g.principal_id = $1)
          or (g.principal_kind = 'role_assignment' and exists (
                select 1 from org.role_assignment ra where ra.id = g.principal_id
                   and ra.subject_id = $1 and ra.valid_from <= now()
                   and (ra.valid_to is null or ra.valid_to > now()))))`,
    [personId, org],
  );
  const root = plan[0]['QUERY PLAN'][0];
  return { total: root['Execution Time'] + root['Planning Time'], rows: root.Plan['Actual Rows'] };
}

async function coverage(label, personId) {
  const runs = [];
  let rows = 0;
  for (let i = 0; i < 7; i += 1) {
    const r = await coverageMs(personId);
    runs.push(r.total);
    rows = r.rows;
  }
  out(`| ${label} | ${rows} | ${ms(quantile(runs, 0.5))} | ${ms(Math.max(...runs))} |`);
}

try {
  const objects = await owner.scoped(
    org,
    'select count(*)::int as n from core.object where organization_id = $1',
    [org],
  );
  const widest = people.find((p) => p.clearance === 'restricted' && p.ceiling === 'restricted');
  const narrow = people.filter((p) => p.clearance === 'confidential' && p.ceiling === 'internal');
  const [readerA, readerB] = narrow;
  const definer = session(widest);
  out(`# Role preset cost — ${new Date().toISOString()}`);
  out();
  out(`Organization ${ids.legalName}: ${objects[0].n} records. K = ${K} templates/grants.`);
  out(
    `Widest reader ${widest.key} (${widest.clearance}, organization-wide); A = ${readerA.key}, ` +
      `B = ${readerB.key} (cleared ${readerA.clearance}, organization-wide reading capped ${readerA.ceiling}).`,
  );
  out();

  // The K documents: confidential, so neither narrow reader reaches them organization-wide.
  const docs = (
    await owner.scoped(
      org,
      `select id from core.object where organization_id = $1 and object_type = 'artifact'
          and classification = 'confidential' order by id limit $2`,
      [org, K],
    )
  ).map((row) => row.id);

  // Recompute: three role names, a depth-3 inclusion chain, K templates on the last, A holds the first.
  for (const [id, text] of [
    ['scope_measure_a', 'Measurement role A: includes B (scripts/scope-preset-cost.mjs).'],
    ['scope_measure_b', 'Measurement role B: includes C (scripts/scope-preset-cost.mjs).'],
    ['scope_measure_c', 'Measurement role C: reads K documents (scripts/scope-preset-cost.mjs).'],
  ]) {
    await owner.kf(['define-role', '--id', id, '--description', text]);
  }
  await owner.kf([
    'grant-authority',
    '--person',
    ids.people[readerA.key].personId,
    '--organization',
    org,
    '--role',
    'scope_measure_a',
    '--clearance',
    readerA.clearance,
    '--role-ceiling',
    readerA.ceiling,
    '--granted-by',
    ids.people[widest.key].personId,
    '--reason',
    'scope preset cost measurement (scripts/scope-preset-cost.mjs)',
  ]);
  const act = (type, targetIds, payload, key) =>
    definer.act(type, {
      targetIds,
      idempotencyKey: key,
      reason: 'scope preset cost measurement (scripts/scope-preset-cost.mjs)',
      payload,
    });
  await act(
    'include_role',
    [org],
    { role_id: 'scope_measure_a', included_role_id: 'scope_measure_b' },
    'measure:include:a:b',
  );
  await act(
    'include_role',
    [org],
    { role_id: 'scope_measure_b', included_role_id: 'scope_measure_c' },
    'measure:include:b:c',
  );
  const presetActs = await timed(() =>
    mapLimit(docs, 6, (doc) =>
      act(
        'grant_role_scope',
        [org, doc],
        { role_id: 'scope_measure_c', capability: 'read' },
        `measure:preset:c:${doc}`,
      ),
    ),
  );
  // Materialize: the same K documents to B, one grant each.
  const personB = ids.people[readerB.key].personId;
  const grantActs = await timed(() =>
    mapLimit(docs, 6, async (doc) => {
      try {
        await act(
          'grant_access',
          [doc],
          { principal_kind: 'person', principal_id: personB, capability: 'read' },
          `measure:grant:b:${doc}`,
        );
      } catch (error) {
        if (!/already overlaps/.test(String(error.message))) throw error;
      }
    }),
  );
  out('## Write cost');
  out();
  out('| what | acts | wall time (6 in flight) | per act |');
  out('| --- | ---: | ---: | ---: |');
  out(
    `| K preset templates (once, for every holder) | ${K} | ${ms(presetActs)} | ${ms(presetActs / K)} |`,
  );
  out(`| K grants to ONE holder | ${K} | ${ms(grantActs)} | ${ms(grantActs / K)} |`);
  out();
  out(
    'Materializing multiplies the second row by the number of holders on every preset change; ' +
      'a recomputed preset change is one act whatever the number of holders.',
  );
  out();
  out('## Coverage read (the view, expanded as every read expands it)');
  out();
  out('| reader | rows | p50 of 7 | worst |');
  out('| --- | ---: | ---: | ---: |');
  await coverage('A — recompute (preset, depth 3)', ids.people[readerA.key].personId);
  await coverage('B — materialized (direct grants)', personB);
  await coverage('widest reader', ids.people[widest.key].personId);
  out();
  out(`## End to end at the API (${SAMPLES} samples after one warm-up)`);
  out();
  out('| reader | route | p50 | p95 | worst |');
  out('| --- | --- | ---: | ---: | ---: |');
  const a = session(readerA);
  const b = session(readerB);
  for (const [label, s] of [
    ['widest reader', definer],
    ['A — recompute', a],
    ['B — materialized', b],
  ]) {
    const compile = await timed(() =>
      s.request('POST', '/master-record/compile', {
        idempotencyKey: `measure-compile-${label}-${Date.now()}`,
      }),
    );
    out(
      `| ${label} | \`POST /master-record/compile\` (once; an act, not a read) | ${ms(compile)} | | |`,
    );
    await latency(label, s, '/dashboard');
    await latency(label, s, '/master-document');
  }
} finally {
  await owner.end();
}
