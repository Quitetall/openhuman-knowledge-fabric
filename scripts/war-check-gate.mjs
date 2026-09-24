#!/usr/bin/env node
/**
 * Decide a CI verdict from `war check --generated --json`.
 *
 *   war check --generated --json > report.json; echo $? > war-exit
 *   node scripts/war-check-gate.mjs report.json --war-exit "$(cat war-exit)"
 *
 * KF-SAS-RQ-017 says a difference between a committed generated artifact and a fresh build fails
 * the build, and KF-SAS-RQ-181 says every copy of the specification states the revision and
 * digest it reproduces. `war check --generated` checks both for the SAS projection and the
 * Warrant views — and until this gate, nothing ran it: NORMATIVE.md could drift from a fresh
 * compile and CI would stay green.
 *
 * Why not just use war's exit status: it is non-zero today for a finding that is not a defect of
 * this tree. The accepted revision 0.1.0-draft.7 has no signed acceptance response, and signing
 * is the owner's act (`war sign … --ssh-sign`), not something CI or an agent may do. A gate that
 * cannot pass until the owner signs gets disabled; a gate that ignores `authority.unsigned`
 * forgets the owner owes it. So an ERROR is tolerated only when `docs/sas/owner-pending.json`
 * names that exact rule AND that exact file, and only until the entry's `review_by` date.
 *
 * Refused regardless of the register — these are never an owner's pending act:
 *   - any `*.drift` or `sas-normative.*` finding that is not a pass (the point of the job);
 *   - an `unknown` severity, or one this script does not recognise;
 *   - a report with no `sas-normative.drift` pass for both NORMATIVE.md and NORMATIVE.json, or no
 *     `sas-normative.complete` pass — a check that compared nothing is not a pass (RQ-013);
 *   - a register entry that matches no finding at all: an excuse that outlives what it excused
 *     is how the next real finding gets waved through;
 *   - war's exit status disagreeing with its own report (non-zero with no error, or zero with one).
 *
 * Exit 0 pass, 1 fail, 2 usage or unreadable input.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEVERITIES = new Set(['pass', 'warn', 'error']);
const NEVER_EXCUSED = (rule) => rule.endsWith('.drift') || rule.startsWith('sas-normative.');

function usage(message) {
  process.stderr.write(`war-check-gate: ${message}\n`);
  process.stderr.write(
    'usage: war-check-gate.mjs <report.json> --war-exit <n> [--register <file>] [--today YYYY-MM-DD]\n',
  );
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    report: undefined,
    warExit: undefined,
    register: join(ROOT, 'docs', 'sas', 'owner-pending.json'),
    today: new Date().toISOString().slice(0, 10),
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) usage(`${argument} needs a value`);
      return next;
    };
    if (argument === '--war-exit') options.warExit = Number(value());
    else if (argument === '--register') options.register = value();
    else if (argument === '--today') options.today = value();
    else if (argument.startsWith('--')) usage(`unknown option ${argument}`);
    else if (options.report === undefined) options.report = argument;
    else usage(`unexpected argument ${argument}`);
  }
  if (options.report === undefined) usage('name the report file');
  if (!Number.isInteger(options.warExit)) usage('--war-exit <n> is required');
  if (!/^\d{4}-\d\d-\d\d$/.test(options.today)) usage('--today must be YYYY-MM-DD');
  return options;
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    usage(`cannot read ${what} ${path}: ${error.message}`);
  }
}

/** The failures, in words. Empty means the gate passes. Pure: no I/O, no clock. */
function evaluate(report, register, warExit, today) {
  const failures = [];
  if (report?.schema !== 'oh.war/report/v1' || report?.command !== 'check') {
    return ['the input is not an oh.war/report/v1 report from `war check`'];
  }
  const diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  const entries = Array.isArray(register?.entries) ? register.entries : [];
  if (register?.schema !== 'kf/sas-owner-pending/v1') {
    failures.push('the owner-pending register is not kf/sas-owner-pending/v1');
  }

  // The job exists for these; their absence means war checked something else, or nothing.
  const passes = (rule) =>
    diagnostics.filter((entry) => entry.rule === rule && entry.severity === 'pass');
  const drift = passes('sas-normative.drift').map((entry) => String(entry.message));
  for (const file of ['NORMATIVE.md', 'NORMATIVE.json']) {
    if (!drift.some((message) => message.startsWith(`${file} `))) {
      failures.push(`no passing sas-normative.drift for ${file}: the projection was not compared`);
    }
  }
  if (passes('sas-normative.complete').length === 0) {
    failures.push('no passing sas-normative.complete: section coverage was not checked');
  }

  const matches = (entry, diagnostic) =>
    entry.rule === diagnostic.rule && entry.file === diagnostic.file;
  let errors = 0;
  for (const diagnostic of diagnostics) {
    const where = `${diagnostic.severity} ${diagnostic.rule}${diagnostic.file ? ` (${diagnostic.file})` : ''}`;
    if (!SEVERITIES.has(diagnostic.severity)) {
      failures.push(`${where}: a severity this gate does not accept`);
      continue;
    }
    if (diagnostic.severity !== 'error') continue;
    errors++;
    if (NEVER_EXCUSED(String(diagnostic.rule))) {
      failures.push(`${where}: ${diagnostic.message}`);
      continue;
    }
    const entry = entries.find((candidate) => matches(candidate, diagnostic));
    if (entry === undefined) {
      failures.push(`${where}: not owner-pending — ${diagnostic.message}`);
    } else if (!(today <= String(entry.review_by))) {
      failures.push(
        `${where}: owner-pending since ${entry.recorded}, review_by ${entry.review_by} has passed — ` +
          'the owner signs, withdraws, or re-dates the entry with a reason',
      );
    }
  }

  for (const entry of entries) {
    if (NEVER_EXCUSED(String(entry.rule))) {
      failures.push(`register entry ${entry.subject}: ${entry.rule} can never be owner-pending`);
    }
    if (!diagnostics.some((diagnostic) => matches(entry, diagnostic))) {
      failures.push(
        `register entry ${entry.subject} (${entry.rule}, ${entry.file}) matches no finding: ` +
          'it excuses nothing now, so remove it',
      );
    }
  }

  if (errors > 0 !== (warExit !== 0)) {
    failures.push(
      `war exited ${warExit} with ${errors} error finding(s): the report and the status disagree`,
    );
  }
  return failures;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = readJson(options.report, 'war report');
  const register = readJson(options.register, 'owner-pending register');
  const failures = evaluate(report, register, options.warExit, options.today);
  const counts = report?.counts ? JSON.stringify(report.counts) : 'no counts';
  if (failures.length === 0) {
    process.stdout.write(`war-check-gate: PASS (${counts}; war exit ${options.warExit})\n`);
    return 0;
  }
  for (const failure of failures) process.stdout.write(`war-check-gate: FAIL ${failure}\n`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
