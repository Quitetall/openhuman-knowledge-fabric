#!/usr/bin/env node
/**
 * ADR 0024's latency bars, measured (KF-SAS-RQ-201, SAS §8A, §100.18).
 *
 * "Fast" cannot fail, so ADR 0024 states bars as numbers. A bar nobody measures is prose (§103.3),
 * and until this script nothing measured any of them. It measures three of the five, at the API,
 * against a running stack:
 *
 *   act       "The act itself, dispatched and committed — under 500 ms at the API".
 *             Timed: POST /capture/observation, which answers only after `record_observation`
 *             has committed. One gesture, one act.
 *   search    "Finding prior work by text — first useful result under 2 seconds".
 *             Timed: GET /search?q=<a term the stack has indexed>, and a sample counts only if it
 *             returned the record looked for. How long the worker took to index a fresh capture
 *             is reported beside it, unjudged: ADR 0024 bars the query, not the indexer.
 *   view      "Reading an object view — under 1 second".
 *             Timed: GET /objects/:id for an observation, after one POST /objects/:id/refresh
 *             has brought the reader's master record current (that compile is an act, reported
 *             but not judged against this bar).
 *
 * Not measured here, and said so in every report: "recording an observation, from intent to
 * durable — under 5 seconds, including the human part" (it includes a person), and "attaching
 * evidence to an existing record — under 10 seconds for a file already on disk".
 *
 * JUDGEMENT. After one unmeasured warm-up request per bar, each bar takes `samples` timings and is
 * judged on the 95th percentile by nearest rank; the worst sample is reported beside it. A bar is
 * exceeded when p95 >= the bar, or when a sample failed outright (a non-2xx, a search that found
 * nothing). The exit code is 1 when any bar is exceeded.
 *
 * PROVENANCE. A report names the host class. Numbers from a developer's machine or from the
 * in-process test harness are WORKSTATION numbers and say so; the official figures come from a
 * commissioned host (KF_LATENCY_HOST_CLASS=commissioned), and nothing here can make a workstation
 * run into one.
 *
 * Usage (against a running stack; development identity shown):
 *
 *   KF_API_ORIGIN=http://127.0.0.1:4000 KF_DEV_ACTOR=<uuid> KF_DEV_ORGANIZATION=<uuid> \
 *     [KF_DEV_ACTING_ROLE=<uuid>] node scripts/latency-bars.mjs [--samples 20] [--write]
 *
 * or with a bearer token: KF_API_TOKEN_FILE=<owner-only file> KF_API_ORGANIZATION=<uuid>.
 * `--write` prepends a dated section to generated/latency-bars.md.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** ADR 0024's table, exactly: interaction, bar, and where it is taken. */
export const BARS = Object.freeze([
  Object.freeze({
    id: 'act',
    interaction: 'The act itself, dispatched and committed',
    adr: 'under 500 ms at the API',
    limitMs: 500,
  }),
  Object.freeze({
    id: 'search',
    interaction: 'Finding prior work by text',
    adr: 'first useful result under 2 seconds',
    limitMs: 2000,
  }),
  Object.freeze({
    id: 'view',
    interaction: 'Reading an object view',
    adr: 'under 1 second',
    limitMs: 1000,
  }),
]);

export const NOT_MEASURED = Object.freeze([
  'Recording an observation, from intent to durable — under 5 seconds, including the human part (includes a person)',
  'Attaching evidence to an existing record — under 10 seconds for a file already on disk',
]);

export const GENERATED_FILE = 'generated/latency-bars.md';

/** Nearest-rank percentile of already-sorted numbers. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** The verdict on one bar's samples. A failed sample exceeds the bar whatever the others did. */
export function judge(bar, timings, failures = []) {
  const sorted = [...timings].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted.length === 0 ? Number.NaN : sorted[sorted.length - 1];
  const exceeded = failures.length > 0 || sorted.length === 0 || !(p95 < bar.limitMs);
  return { ...bar, samples: sorted.length, p50, p95, max, failures, exceeded };
}

/**
 * Measure the three bars against `origin`.
 *
 * `fetchImpl` is injectable so a test can put a delay in the path and watch a bar fail; the real
 * run uses the global fetch. `clock` is `performance.now` unless a test supplies one.
 */
export async function measureLatencyBars({
  origin,
  headers,
  samples = 20,
  fetchImpl = globalThis.fetch,
  clock = () => performance.now(),
  indexTimeoutMs = 30_000,
}) {
  const base = origin.replace(/\/+$/u, '');
  const run = randomUUID().slice(0, 8);
  // Reads need the assignment the reader acts under. The capture route formed one for the first
  // note and said which; every read after it uses that, unless the caller named one.
  let readHeaders = headers;
  const call = async (method, path, body) => {
    const started = clock();
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        ...readHeaders,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const elapsed = clock() - started;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, elapsed };
  };

  // act — every sample is a fresh gesture, so every one dispatches and commits a real act.
  const capture = (i) =>
    call('POST', '/capture/observation', {
      body: `latency probe ${run} ${String(i)}: kfbar${run}x${String(i)}`,
      tags: ['latency-bars'],
    });
  const warm = await capture('warm');
  if (warm.status !== 201) {
    throw new Error(
      `the stack refused the warm-up capture (${String(warm.status)} ${JSON.stringify(warm.json)}); ` +
        'nothing can be measured',
    );
  }
  if (readHeaders['x-kf-acting-role'] === undefined && typeof warm.json.actingRoleId === 'string') {
    readHeaders = { ...headers, 'x-kf-acting-role': warm.json.actingRoleId };
  }
  const actTimings = [];
  const actFailures = [];
  let observationId = warm.json.observationId;
  for (let i = 0; i < samples; i += 1) {
    const r = await capture(i);
    if (r.status === 201) {
      actTimings.push(r.elapsed);
      observationId = r.json.observationId;
    } else actFailures.push(`capture ${String(i)} answered ${String(r.status)}`);
  }

  // search — wait for the warm-up note to be indexed, then time queries that must find it.
  const term = `kfbar${run}xwarm`;
  const found = (r) =>
    r.status === 200 &&
    Array.isArray(r.json?.hits) &&
    r.json.hits.some((hit) => hit.objectId === warm.json.observationId);
  const waitStarted = clock();
  let indexed = false;
  while (clock() - waitStarted < indexTimeoutMs) {
    if (found(await call('GET', `/search?q=${encodeURIComponent(term)}`))) {
      indexed = true;
      break;
    }
    await sleep(100);
  }
  const indexedAfterMs = indexed ? clock() - waitStarted : undefined;
  const searchTimings = [];
  const searchFailures = [];
  if (!indexed) {
    searchFailures.push(
      `the captured note was not searchable within ${String(indexTimeoutMs)} ms (is the worker running?)`,
    );
  } else {
    for (let i = 0; i < samples; i += 1) {
      const r = await call('GET', `/search?q=${encodeURIComponent(term)}`);
      if (found(r)) searchTimings.push(r.elapsed);
      else
        searchFailures.push(`search ${String(i)} answered ${String(r.status)} without the record`);
    }
  }

  // view — one refresh to bring the master record current, then timed reads.
  const refresh = await call('POST', `/objects/${observationId}/refresh`);
  const viewTimings = [];
  const viewFailures = [];
  if (refresh.status !== 200) {
    viewFailures.push(`the object view could not be refreshed (${String(refresh.status)})`);
  } else {
    for (let i = 0; i < samples; i += 1) {
      const r = await call('GET', `/objects/${observationId}`);
      if (r.status === 200) viewTimings.push(r.elapsed);
      else viewFailures.push(`view ${String(i)} answered ${String(r.status)}`);
    }
  }

  const [actBar, searchBar, viewBar] = BARS;
  const bars = [
    judge(actBar, actTimings, actFailures),
    judge(searchBar, searchTimings, searchFailures),
    judge(viewBar, viewTimings, viewFailures),
  ];
  return {
    bars,
    exceeded: bars.filter((b) => b.exceeded).map((b) => b.id),
    informational: {
      warmCaptureMs: warm.elapsed,
      captureToSearchableMs: indexedAfterMs,
      objectViewRefreshMs: refresh.elapsed,
    },
  };
}

const ms = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} ms` : '—');

/** One dated section. `provenance` states the host class, the commit, and the target. */
export function renderSection(report, provenance) {
  const label =
    provenance.hostClass === 'commissioned'
      ? '**Commissioned host.** These are official figures for the host named below.'
      : '**Workstation numbers — not the official figures.** Measured on a development machine; ' +
        'the official figures come from a commissioned host (`KF_LATENCY_HOST_CLASS=commissioned`).';
  const rows = report.bars.map(
    (b) =>
      `| ${b.interaction} | ${b.adr} | ${String(b.samples)} | ${ms(b.p50)} | ${ms(b.p95)} | ${ms(b.max)} | ${
        b.exceeded ? `**EXCEEDED**${b.failures.length > 0 ? ` — ${b.failures[0]}` : ''}` : 'within'
      } |`,
  );
  return [
    `## ${provenance.measuredAt} — ${provenance.hostClass}`,
    '',
    label,
    '',
    `- host: ${provenance.host}`,
    `- target: ${provenance.target}`,
    `- commit: \`${provenance.commit}\``,
    `- judged on p95 by nearest rank, after one warm-up request per bar`,
    '',
    '| Interaction (ADR 0024) | Bar | Samples | p50 | p95 | Worst | Verdict |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    'Reported, not judged: first capture (warm-up) ' +
      `${ms(report.informational.warmCaptureMs)}; capture to searchable ` +
      `${ms(report.informational.captureToSearchableMs)}; master-record refresh before the ` +
      `object view ${ms(report.informational.objectViewRefreshMs)}.`,
    '',
    `Not measured by this harness: ${NOT_MEASURED.join('; ')}.`,
    '',
  ].join('\n');
}

const HEADER = `<!-- GENERATED by scripts/latency-bars.mjs --write — newest run first; do not hand-edit. -->

# Latency bars (ADR 0024, KF-SAS-RQ-201)

Runtime measurements, not source counts (§103.3): each section is one run of
\`scripts/latency-bars.mjs\` against one stack, dated, with the host class and commit it measured.
A **workstation** section is evidence the harness works and a rough figure; it is not the official
measurement, which comes from a commissioned host.

`;

/** Prepend a section to the generated file, keeping earlier runs beneath it. */
export function prependSection(existing, section) {
  const previous =
    existing === undefined ? '' : existing.slice(existing.indexOf('\n## ') + 1 || existing.length);
  return `${HEADER}${section}${previous === '' ? '' : `\n${previous}`}`;
}

function commitOf(root) {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function writeReport(root, report, provenance) {
  const path = join(root, GENERATED_FILE);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  writeFileSync(path, prependSection(existing, renderSection(report, provenance)));
  return path;
}

export function defaultProvenance(root, target, env = process.env) {
  return {
    measuredAt: new Date().toISOString(),
    hostClass: env['KF_LATENCY_HOST_CLASS'] === 'commissioned' ? 'commissioned' : 'workstation',
    host: env['KF_LATENCY_HOST_LABEL'] ?? hostname(),
    target,
    commit: commitOf(root),
  };
}

function identityHeaders(env) {
  const tokenFile = env['KF_API_TOKEN_FILE'];
  if (tokenFile !== undefined && tokenFile !== '') {
    if ((statSync(tokenFile).mode & 0o077) !== 0) {
      throw new Error(`${tokenFile} is readable by other users; chmod 600 it`);
    }
    return {
      authorization: `Bearer ${readFileSync(tokenFile, 'utf8').trim()}`,
      'x-kf-organization': env['KF_API_ORGANIZATION'] ?? '',
      ...(env['KF_API_ACTING_ROLE'] ? { 'x-kf-acting-role': env['KF_API_ACTING_ROLE'] } : {}),
    };
  }
  if (!env['KF_DEV_ACTOR'] || !env['KF_DEV_ORGANIZATION']) {
    throw new Error(
      'no identity: set KF_API_TOKEN_FILE + KF_API_ORGANIZATION, or KF_DEV_ACTOR + KF_DEV_ORGANIZATION',
    );
  }
  return {
    'x-kf-actor': env['KF_DEV_ACTOR'],
    'x-kf-organization': env['KF_DEV_ORGANIZATION'],
    ...(env['KF_DEV_ACTING_ROLE'] ? { 'x-kf-acting-role': env['KF_DEV_ACTING_ROLE'] } : {}),
  };
}

async function main(argv) {
  const samplesAt = argv.indexOf('--samples');
  const samples = samplesAt === -1 ? 20 : Number(argv[samplesAt + 1]);
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('--samples needs a count');
  const origin = process.env['KF_API_ORIGIN'];
  if (!origin) throw new Error('set KF_API_ORIGIN to the API under test');
  const report = await measureLatencyBars({
    origin,
    headers: identityHeaders(process.env),
    samples,
  });
  const root = process.cwd();
  const provenance = defaultProvenance(root, origin);
  process.stdout.write(renderSection(report, provenance));
  if (argv.includes('--write')) {
    process.stdout.write(`wrote ${writeReport(root, report, provenance)}\n`);
  }
  if (report.exceeded.length > 0) {
    process.stderr.write(`latency bars exceeded: ${report.exceeded.join(', ')}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
