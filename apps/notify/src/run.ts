/**
 * The two notifier runs (ADR 0040 decision 9, KF-SAS-RQ-274; KF-WAR-0006 work order 4 and 5).
 *
 *   digest  daily (kf-notify-digest.timer): every person's Needs you, redacted by the database for
 *           a channel the deployment does not control, one e-mail per person and organization with
 *           anything in it. A person with nothing waiting, or with the digest off, gets nothing.
 *   urgent  every five minutes (kf-notify-urgent.timer): if anything urgent arose since the last
 *           run for the person this host's alert path reaches, ONE push through
 *           `scripts/alert-dispatch.sh urgent` — the same script, endpoint and fixed-text stance as
 *           the operational alerts. Nothing non-urgent is ever pushed.
 *
 * Both connect as the notifier's login (`kf_notifier`), which reads no table: they see only what
 * `core.needs_you_digest()` and `core.urgent_notifications()` return. The log carries counts, never
 * an address, a title or an identifier.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTransaction, type Pool } from '@kf/database';
import { composeDigests, type DigestKind, type DigestRow } from './digest.js';
import type { Mailer } from './smtp.js';

export interface Log {
  (entry: Record<string, unknown>): void;
}

export const stderrLog: Log = (entry) => {
  process.stderr.write(`${JSON.stringify({ service: 'kf-notify', ...entry })}\n`);
};

export async function readDigestRows(pool: Pool): Promise<DigestRow[]> {
  const rows = await withTransaction(pool, (tx) =>
    tx.query<{
      organization_id: string;
      organization_name: string | null;
      person_id: string;
      email: string;
      kind: DigestKind;
      disclosed: boolean;
      item_id: string | null;
      title: string | null;
    }>('select * from core.needs_you_digest()'),
  );
  return rows.map((row) => ({
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    personId: row.person_id,
    email: row.email,
    kind: row.kind,
    disclosed: row.disclosed,
    itemId: row.item_id,
    title: row.title,
  }));
}

export async function runDigest(
  pool: Pool,
  mailer: Mailer,
  options: { readonly webOrigin: string; readonly log?: Log },
): Promise<{ readonly sent: number; readonly failed: number }> {
  const log = options.log ?? stderrLog;
  const messages = composeDigests(await readDigestRows(pool), options.webOrigin);
  let sent = 0;
  let failed = 0;
  for (const message of messages) {
    try {
      await mailer.send(message);
      sent += 1;
    } catch {
      // The error can quote the address; the count is what an operator needs to act.
      failed += 1;
    }
  }
  log({ run: 'digest', people: messages.length, sent, failed });
  return { sent, failed };
}

export interface UrgentOptions {
  /** Where the last run's boundary is kept: operational state, not a record. */
  readonly stateDir: string;
  /** The person this host's alert path reaches. Others are told by the digest only. */
  readonly pushPerson: string | undefined;
  /** Send one push. Production runs `alert-dispatch.sh urgent`. */
  readonly push: () => Promise<void>;
  readonly log?: Log;
}

const WATERMARK = 'urgent-since';

export async function runUrgent(
  pool: Pool,
  options: UrgentOptions,
): Promise<{ readonly pushed: boolean; readonly urgent: number }> {
  const log = options.log ?? stderrLog;
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const file = join(options.stateDir, WATERMARK);
  let since: string | undefined;
  try {
    since = (await readFile(file, 'utf8')).trim();
    if (Number.isNaN(Date.parse(since))) since = undefined;
  } catch {
    since = undefined;
  }
  const save = async (instant: string) => {
    await writeFile(`${file}.tmp`, `${instant}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  if (since === undefined) {
    // First run: start from now. What arose before the notifier existed is in the digest.
    const now = await withTransaction(pool, (tx) => tx.one<{ now: Date }>('select now() as now'));
    await save(now.now.toISOString());
    log({ run: 'urgent', started: true, urgent: 0, pushed: false });
    return { pushed: false, urgent: 0 };
  }
  const rows = await withTransaction(pool, (tx) =>
    tx.query<{ person_id: string; kind: string; arose_at: Date }>(
      'select person_id, kind, arose_at from core.urgent_notifications($1)',
      [since],
    ),
  );
  const mine = rows.filter((row) => row.person_id === options.pushPerson);
  let pushed = false;
  if (mine.length > 0) {
    // One push for everything that arose since the last run. A failed push leaves the boundary
    // where it was, so the next run tries again; the push carries nothing, so a repeat leaks
    // nothing either.
    await options.push();
    pushed = true;
  }
  const latest = rows.reduce(
    (max, row) => (row.arose_at.getTime() > max ? row.arose_at.getTime() : max),
    Date.parse(since),
  );
  await save(new Date(latest).toISOString());
  log({
    run: 'urgent',
    urgent: rows.length,
    pushed,
    // People with an urgent item and no push destination: they are told by the digest.
    withoutPush: new Set(
      rows.filter((r) => r.person_id !== options.pushPerson).map((r) => r.person_id),
    ).size,
  });
  return { pushed, urgent: mine.length };
}

/** `alert-dispatch.sh urgent`, inheriting this unit's alert credentials. */
export function alertDispatchPush(script: string): () => Promise<void> {
  return () =>
    new Promise((resolve, reject) => {
      const child = spawn(script, ['urgent'], { stdio: ['ignore', 'ignore', 'inherit'] });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`alert-dispatch.sh urgent exited ${String(code)}`)),
      );
    });
}
