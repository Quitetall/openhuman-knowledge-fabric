/**
 * The two notifier runs (ADR 0040 decision 9, KF-SAS-RQ-274; KF-WAR-0006 work order 4 and 5).
 *
 *   digest  daily (kf-notify-digest.timer): every person's Needs you, redacted by the database for
 *           a channel the deployment does not control, one e-mail per person and organization with
 *           anything in it. A person with nothing waiting, or with the digest off, gets nothing.
 *   urgent  every five minutes (kf-notify-urgent.timer): each urgent item that arose since the
 *           last run, to each person the database says may be told of it now
 *           (`core.urgent_pushes()`, 20261011500000), once: to the person's own destination — an
 *           ntfy topic they set, sealed, opened here with kf-notify's key — one push per item
 *           (push.ts), with a title only when the database disclosed one; or, for the person this
 *           host's alert path reaches (KF_NOTIFY_PUSH_PERSON) when they set none, ONE fixed-line
 *           push for the run through `scripts/alert-dispatch.sh urgent`. Everyone else is told by
 *           the digest. Nothing non-urgent is ever pushed.
 *
 * Both connect as the notifier's login (`kf_notifier`), which reads no table: they see only what
 * `core.needs_you_digest()` and `core.urgent_pushes()` return. The log carries counts, never an
 * address, a destination, a title or an identifier.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTransaction, type Pool } from '@kf/database';
import type { DestinationOpener } from '@kf/authorization';
import { composeDigests, type DigestKind, type DigestRow } from './digest.js';
import { composePush, type PushSender, type UrgentRow } from './push.js';
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
  /**
   * The person this host's alert path reaches (KF_NOTIFY_PUSH_PERSON). They are pushed through it
   * when they have set no destination of their own; a destination they set wins.
   */
  readonly pushPerson: string | undefined;
  /** Send one push on the host's alert path. Production runs `alert-dispatch.sh urgent`. */
  readonly push: () => Promise<void>;
  /**
   * Opens a person's sealed destination with kf-notify's key (KF_NOTIFY_DESTINATION_KEY_FILE).
   * Absent: no person's own destination is used, and everyone but `pushPerson` is told by the
   * digest.
   */
  readonly opener?: DestinationOpener;
  /** Sends one message to one person's destination. Production: ntfy, on the named servers. */
  readonly send?: PushSender;
  /** Where a push's tap leads (Needs you). */
  readonly webOrigin?: string;
  readonly log?: Log;
}

const WATERMARK = 'urgent-since';

/**
 * Consecutive failed runs after which a person's own destination stops being retried for the items
 * behind it: an hour at the timer's five minutes. Those items are in the person's digest; the
 * failure was alerted on every run (the unit fails), and a destination that stays dead must not
 * hold every later query back.
 */
export const MAX_DESTINATION_FAILURES = 12;

/**
 * The last item a run saw, as (instant, item): the instant as the database's own text at
 * microseconds, so nothing is rounded on the way round (20261007500100).
 */
interface Boundary {
  readonly at: string;
  readonly item: string | null;
}

/**
 * What the urgent run keeps between runs: the head — every item at or before it is settled for
 * everyone — and, per person whose own destination failed, how far THEY have been told, so that
 * the next run retries exactly what they have not received and nothing they have (at most once
 * per item and person, 20261011500000).
 */
interface UrgentState {
  readonly head: Boundary;
  readonly lagging: ReadonlyMap<string, Boundary & { readonly failures: number }>;
}

const MICROSECOND_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LAGGING_KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

function boundaryOf(value: { at?: unknown; item?: unknown }): Boundary | undefined {
  if (typeof value.at !== 'string' || !MICROSECOND_INSTANT.test(value.at)) return undefined;
  const item = value.item ?? null;
  if (item !== null && (typeof item !== 'string' || !UUID.test(item))) return undefined;
  return { at: value.at, item };
}

/** The boundary file, or undefined. The earlier format, one ISO instant, reads as (it, none). */
export function parseBoundary(text: string): Boundary | undefined {
  return parseUrgentState(text)?.head;
}

export function parseUrgentState(text: string): UrgentState | undefined {
  const trimmed = text.trim();
  if (MICROSECOND_INSTANT.test(trimmed))
    return { head: { at: trimmed, item: null }, lagging: new Map() };
  try {
    const parsed = JSON.parse(trimmed) as { at?: unknown; item?: unknown; lagging?: unknown };
    const head = boundaryOf(parsed);
    if (head === undefined) return undefined;
    const lagging = new Map<string, Boundary & { failures: number }>();
    if (parsed.lagging !== undefined) {
      if (parsed.lagging === null || typeof parsed.lagging !== 'object') return undefined;
      for (const [key, value] of Object.entries(parsed.lagging as Record<string, unknown>)) {
        if (!LAGGING_KEY.test(key) || value === null || typeof value !== 'object') return undefined;
        const entry = value as { at?: unknown; item?: unknown; failures?: unknown };
        const boundary = boundaryOf(entry);
        if (boundary === undefined || !Number.isInteger(entry.failures)) return undefined;
        lagging.set(key, { ...boundary, failures: entry.failures as number });
      }
    }
    return { head, lagging };
  } catch {
    return undefined;
  }
}

/** (at, item) order, as the database's row comparison: the instant text is fixed-width UTC. */
function after(row: { readonly aroseAt: string; readonly itemId: string }, boundary: Boundary) {
  if (row.aroseAt !== boundary.at) return row.aroseAt > boundary.at;
  return row.itemId > (boundary.item ?? '00000000-0000-0000-0000-000000000000');
}

function earliest(boundaries: readonly Boundary[]): Boundary {
  return boundaries.reduce((low, b) =>
    b.at < low.at || (b.at === low.at && (b.item ?? '') < (low.item ?? '')) ? b : low,
  );
}

/** An instant as the database writes it at microseconds, UTC. */
const INSTANT_SQL = `to_char(%s at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface UrgentResult {
  /** Whether anything was pushed this run, on any path. */
  readonly pushed: boolean;
  /** Items delivered this run (to a person's own destination, or on the alert path). */
  readonly urgent: number;
  /** Deliveries that failed and will be retried, or were given up after MAX_DESTINATION_FAILURES. */
  readonly failed: number;
}

export async function runUrgent(pool: Pool, options: UrgentOptions): Promise<UrgentResult> {
  const log = options.log ?? stderrLog;
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const file = join(options.stateDir, WATERMARK);
  let state: UrgentState | undefined;
  try {
    state = parseUrgentState(await readFile(file, 'utf8'));
  } catch {
    state = undefined;
  }
  const save = async (next: UrgentState) => {
    const lagging = Object.fromEntries(next.lagging);
    const body = { ...next.head, ...(next.lagging.size === 0 ? {} : { lagging }) };
    await writeFile(`${file}.tmp`, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  if (state === undefined) {
    // First run: start from now. What arose before the notifier existed is in the digest.
    const now = await withTransaction(pool, (tx) =>
      tx.one<{ now: string }>(`select ${INSTANT_SQL.replace('%s', 'now()')} as now`),
    );
    await save({ head: { at: now.now, item: null }, lagging: new Map() });
    log({ run: 'urgent', started: true, urgent: 0, pushed: false });
    return { pushed: false, urgent: 0, failed: 0 };
  }
  const head = state.head;
  const lagging = new Map(state.lagging);
  const since = earliest([head, ...lagging.values()]);
  // Ordered by (arose_at, item_id, person_id). The database has decided, at this moment, who may
  // be told of each item and what the push may say (core.urgent_pushes, 20261011500000).
  const rows: UrgentRow[] = (
    await withTransaction(pool, (tx) =>
      tx.query<{
        organization_id: string;
        person_id: string;
        kind: string;
        arose_at: string;
        item_id: string;
        disclosed: boolean;
        title: string | null;
        destination: string | null;
      }>(
        `select organization_id, person_id, kind,
                ${INSTANT_SQL.replace('%s', 'arose_at')} as arose_at, item_id, disclosed, title,
                destination
           from core.urgent_pushes($1::timestamptz, $2::uuid)`,
        [since.at, since.item],
      ),
    )
  ).map((row) => ({
    organizationId: row.organization_id,
    personId: row.person_id,
    kind: row.kind,
    aroseAt: row.arose_at,
    itemId: row.item_id,
    disclosed: row.disclosed,
    title: row.title,
    destination: row.destination,
  }));

  // Each person's items they have not been told of: after their own cursor if they lag, else after
  // the head. A person is a (organization, person) pair: a destination is set per organization.
  const owed = new Map<string, UrgentRow[]>();
  for (const row of rows) {
    const key = `${row.organizationId}/${row.personId}`;
    if (!after(row, lagging.get(key) ?? head)) continue;
    owed.set(key, [...(owed.get(key) ?? []), row]);
  }

  let delivered = 0;
  let failed = 0;
  let abandoned = 0;
  let withoutPush = 0;
  let unopenable = 0;
  let alertPathItems = 0;
  for (const [key, items] of owed) {
    const first = items[0]!;
    const binding = { organizationId: first.organizationId, personId: first.personId };
    const sealed = items.at(-1)!.destination;
    const destination =
      sealed === null || options.opener === undefined
        ? undefined
        : options.opener.open(sealed, binding);
    if (sealed !== null && destination === undefined) unopenable += 1;
    if (destination !== undefined && options.send !== undefined) {
      // One push per item, in order; the first failure stops this person's run, and their cursor
      // stays at the last item they received, so the next run sends the rest and nothing twice.
      let told: Boundary | undefined;
      let failure = false;
      for (const item of items) {
        try {
          await options.send(destination, composePush(item, options.webOrigin));
        } catch {
          // PushFailed names neither the destination nor the server's answer; nothing is logged
          // per person at all, only counts.
          failure = true;
          break;
        }
        told = { at: item.aroseAt, item: item.itemId };
        delivered += 1;
      }
      if (failure) {
        const before = lagging.get(key);
        const failures = (before?.failures ?? 0) + 1;
        failed += 1;
        if (failures >= MAX_DESTINATION_FAILURES) {
          lagging.delete(key);
          abandoned += 1;
        } else {
          lagging.set(key, { ...(told ?? before ?? head), failures });
        }
      } else {
        lagging.delete(key);
      }
    } else if (first.personId === options.pushPerson) {
      // The host's alert path: one fixed line for everything that arose since the last run. A
      // failed push leaves this person behind, and the next run tries again; the push carries
      // nothing, so a repeat leaks nothing either.
      try {
        await options.push();
        delivered += items.length;
        alertPathItems += items.length;
        lagging.delete(key);
      } catch {
        const before = lagging.get(key);
        const failures = (before?.failures ?? 0) + 1;
        failed += 1;
        if (failures >= MAX_DESTINATION_FAILURES) {
          lagging.delete(key);
          abandoned += 1;
        } else {
          lagging.set(key, { ...(before ?? head), failures });
        }
      }
    } else {
      // No destination: told by the digest.
      withoutPush += 1;
      lagging.delete(key);
    }
    // Saved after each person, so a crash part-way repeats nobody already told.
    await save({ head, lagging });
  }
  // Someone behind with nothing still owed (their items were answered meanwhile) is caught up.
  for (const key of [...lagging.keys()]) if (!owed.has(key)) lagging.delete(key);
  const last = rows.at(-1);
  const nextHead =
    last === undefined || !after(last, head) ? head : { at: last.aroseAt, item: last.itemId };
  await save({ head: nextHead, lagging });
  log({
    run: 'urgent',
    urgent: rows.length,
    delivered,
    alertPath: alertPathItems,
    failed,
    abandoned,
    lagging: lagging.size,
    // People with an urgent item and no destination of their own: they are told by the digest.
    withoutPush,
    // Destinations sealed to another key, another person, or malformed: told by the digest.
    unopenable,
  });
  if (failed > 0) {
    throw new UrgentDeliveryFailed(failed);
  }
  return { pushed: delivered > 0, urgent: delivered, failed };
}

/** Some pushes failed; the unit fails, so its OnFailure= alert reaches a person. Counts only. */
export class UrgentDeliveryFailed extends Error {
  constructor(readonly failed: number) {
    super(`${String(failed)} urgent push(es) failed; they are retried on the next run`);
    this.name = 'UrgentDeliveryFailed';
  }
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
