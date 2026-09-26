#!/usr/bin/env node
// One entry point for every fixture corpus:
//
//   pnpm fixture <corpus> [--sample] [...]     load one corpus into the running fixture stack
//   pnpm fixture all [--sample]                every corpus, each as its own organization
//   pnpm fixture list                          the corpora, and whether their data is here
//
// Each corpus's loader is fixtures/<corpus>/load.mjs; this runs it as a child process with the
// same arguments and environment (KF_STACK_*: which stack). `pnpm fixture:veracier` still runs
// the Véracier loader directly.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The corpora, in load order, and what a full (non-sample) load needs on this machine. */
export const CORPORA = {
  veracier: {
    title: 'Véracier Industries S.A. (EDiTh, Apache-2.0)',
    // Véracier's sample is not committed: its PDFs and their text live under the corpus.
    sampleNeeds: () => process.env.KF_VERACIER_CORPUS ?? '/mnt/4tb/data/veracier',
    fullNeeds: () => process.env.KF_VERACIER_CORPUS ?? '/mnt/4tb/data/veracier',
  },
  'enterprise-rag-bench': {
    title: 'Redwood Inference, Inc. (EnterpriseRAG-Bench, MIT)',
    fullNeeds: () =>
      path.join(
        process.env.KF_ERB_CORPUS ?? '/mnt/4tb/data/enterprise-rag-bench',
        'manifest.jsonl',
      ),
  },
  drbench: {
    title: 'DRBench companies (ServiceNow DRBench, Apache-2.0)',
    fullNeeds: () =>
      path.join(process.env.KF_DRBENCH_CORPUS ?? '/mnt/4tb/data/drbench', 'manifest.json'),
  },
  theagentcompany: {
    title: 'TheAgentCompany (MIT)',
    fullNeeds: () =>
      path.join(process.env.KF_TAC_CORPUS ?? '/mnt/4tb/data/theagentcompany', 'manifest.json'),
  },
};

function run(corpus, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, corpus, 'load.mjs'), ...args], {
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main() {
  const [target, ...args] = process.argv.slice(2);
  const sample = args.includes('--sample');
  if (target === undefined || target === '--help' || target === '-h') {
    process.stdout.write(
      `usage: pnpm fixture <${Object.keys(CORPORA).join('|')}|all|list> [--sample] [...]\n`,
    );
    process.exitCode = target === undefined ? 2 : 0;
    return;
  }
  if (target === 'list') {
    for (const [name, c] of Object.entries(CORPORA)) {
      const needs = (sample ? c.sampleNeeds : c.fullNeeds)?.();
      const ok = needs === undefined || existsSync(needs);
      process.stdout.write(`${name.padEnd(22)} ${c.title}${ok ? '' : `  (missing: ${needs})`}\n`);
    }
    return;
  }
  const targets = target === 'all' ? Object.keys(CORPORA) : [target];
  for (const name of targets) {
    const corpus = CORPORA[name];
    if (corpus === undefined) throw new Error(`unknown corpus ${name}`);
    const needs = (sample ? corpus.sampleNeeds : corpus.fullNeeds)?.();
    if (needs !== undefined && !existsSync(needs)) {
      if (target !== 'all') throw new Error(`${name}: ${needs} is not on this machine`);
      process.stdout.write(`== ${name}: skipped (${needs} is not on this machine)\n`);
      continue;
    }
    process.stdout.write(`\n######## ${name}\n`);
    const code = await run(name, args);
    if (code !== 0) {
      process.exitCode = code;
      process.stderr.write(`${name}: loader exited ${code}\n`);
      return;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
