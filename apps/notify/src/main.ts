#!/usr/bin/env node
/**
 * kf-notify digest | urgent — see run.ts.
 *
 *   DATABASE_URL_FILE        the notifier's login (member of kf_notifier and nothing else)
 *   KF_NOTIFY_WEB_ORIGIN     where links in a digest point (https://…)
 *   KF_NOTIFY_SMTP_FILE, KF_NOTIFY_SMTP_PASSWORD_FILE   digest only (smtp.ts)
 *   KF_NOTIFY_STATE_DIR      urgent only: where the last run's boundary is kept
 *   KF_NOTIFY_PUSH_PERSON    urgent only: the person this host's alert path reaches
 *   KF_NOTIFY_ALERT_DISPATCH urgent only: default /opt/kf/scripts/alert-dispatch.sh
 *
 * Exits non-zero when any digest failed to send or the push failed, so the unit fails and its
 * OnFailure= alert reaches a person.
 */

import { createPool } from '@kf/database';
import { loadSecret } from '@kf/operations';
import { alertDispatchPush, runDigest, runUrgent, stderrLog } from './run.js';
import { loadSmtpSettings, smtpMailer } from './smtp.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function webOrigin(): string {
  const raw = process.env['KF_NOTIFY_WEB_ORIGIN'] ?? '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('KF_NOTIFY_WEB_ORIGIN must be the web application’s origin');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('KF_NOTIFY_WEB_ORIGIN must be https');
  }
  return url.origin;
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command !== 'digest' && command !== 'urgent') {
    process.stderr.write('usage: kf-notify digest | urgent\n');
    return 2;
  }
  const pool = createPool({ connectionString: loadSecret('DATABASE_URL'), maxConnections: 2 });
  try {
    if (command === 'digest') {
      const mailer = smtpMailer(loadSmtpSettings());
      try {
        const { failed } = await runDigest(pool, mailer, { webOrigin: webOrigin() });
        return failed === 0 ? 0 : 1;
      } finally {
        mailer.close();
      }
    }
    const person = process.env['KF_NOTIFY_PUSH_PERSON'];
    if (person !== undefined && person !== '' && !UUID.test(person)) {
      throw new Error('KF_NOTIFY_PUSH_PERSON must be a person id');
    }
    await runUrgent(pool, {
      stateDir: process.env['KF_NOTIFY_STATE_DIR'] ?? '/var/lib/kf-notify',
      pushPerson: person === '' ? undefined : person,
      push: alertDispatchPush(
        process.env['KF_NOTIFY_ALERT_DISPATCH'] ?? '/opt/kf/scripts/alert-dispatch.sh',
      ),
    });
    return 0;
  } catch (error: unknown) {
    // Configuration and connection failures; no query here returns record content in an error.
    stderrLog({ run: command, error: error instanceof Error ? error.message : 'error' });
    return 1;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
