#!/usr/bin/env node
// Load the TheAgentCompany fixture (The Agent Company, Inc.) into a running fixture stack.
//
//   pnpm fixture theagentcompany [--sample] [--jobs n]
//
//   (default)  the whole drive (extract.mjs first; manifest.json under KF_TAC_CORPUS)
//   --sample   the committed sample (fixtures/theagentcompany/sample), ~30 files
//
// Through the real paths only (fixtures/lib/loader.mjs); the CTO migrates the drive as herself.

import { loadDocumentCorpus, parseLoadArgs } from '../lib/loader.mjs';
import { fixture } from './fixture.mjs';

const opts = parseLoadArgs(
  process.argv.slice(2),
  'usage: pnpm fixture theagentcompany [--sample] [--corpus <dir>] [--jobs <n>]',
  { defaultJobs: 4 },
);
if (opts.full)
  throw new Error('theagentcompany has no --full: the default load is the whole drive');
const f = await fixture({
  sample: opts.sample,
  ...(opts.corpus === undefined ? {} : { data: opts.corpus }),
});
try {
  await loadDocumentCorpus(f, { ...opts, mode: opts.sample ? 'sample' : 'drive' });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
