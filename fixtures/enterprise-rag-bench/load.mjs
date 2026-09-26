#!/usr/bin/env node
// Load the EnterpriseRAG-Bench fixture (Redwood Inference, Inc.) into a running fixture stack.
//
//   pnpm fixture enterprise-rag-bench [--sample | --full] [--jobs n]
//
//   (default)  the extracted selection: every document a question expects plus a seeded sample,
//              ~50 000 documents (extract.py; manifest.jsonl under KF_ERB_CORPUS)
//   --sample   the committed sample (fixtures/enterprise-rag-bench/sample), ~100 documents
//   --full     every document (extract.py --full first; manifest-full.jsonl) — a scale run
//
// Through the real paths only (fixtures/lib/loader.mjs): kf bootstrap-organization and
// kf grant-authority on the owner credential; every document POST /ingest-ed by the IT systems
// administrator as herself; every need-to-know grant a grant_access act. A second run replays.

import { loadDocumentCorpus, parseLoadArgs } from '../lib/loader.mjs';
import { fixture } from './fixture.mjs';

const opts = parseLoadArgs(
  process.argv.slice(2),
  'usage: pnpm fixture enterprise-rag-bench [--sample | --full] [--resume] [--corpus <dir>] [--jobs <n>]',
  { defaultJobs: 6 },
);
const f = await fixture({
  sample: opts.sample,
  full: opts.full,
  ...(opts.corpus === undefined ? {} : { data: opts.corpus }),
});
try {
  await loadDocumentCorpus(f, {
    ...opts,
    mode: opts.sample ? 'sample' : opts.full ? 'full' : 'selection',
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
