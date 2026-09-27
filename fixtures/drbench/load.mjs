#!/usr/bin/env node
// Load the DRBench fixture — Lee's Market, MediConn Solutions and Elexion Automotive, each its
// own KF organization — into a running fixture stack.
//
//   pnpm fixture drbench [--sample] [--jobs n]
//
//   (default)  every task's files (extract.mjs first; manifest.json under KF_DRBENCH_CORPUS)
//   --sample   the committed sample (fixtures/drbench/sample): the files of three tasks
//
// Through the real paths only (fixtures/lib/loader.mjs); each company's most senior person
// ingests its files and records its grants. One personas file for the three:
// ~/.config/kf/drbench-personas.txt.

import { loadDocumentCorpus, parseLoadArgs } from '../lib/loader.mjs';
import { DEFAULT_DATA, SAMPLE_DIR, companiesIn, fixtureOf } from './fixture.mjs';

const opts = parseLoadArgs(
  process.argv.slice(2),
  'usage: pnpm fixture drbench [--sample] [--corpus <dir>] [--jobs <n>]',
  { defaultJobs: 4 },
);
if (opts.full) throw new Error('drbench has no --full: the default load is every task');
const dir = opts.sample ? SAMPLE_DIR : (opts.corpus ?? DEFAULT_DATA);
try {
  for (const company of await companiesIn(dir)) {
    await loadDocumentCorpus(fixtureOf(company, dir), {
      ...opts,
      mode: opts.sample ? 'sample' : 'every task',
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
