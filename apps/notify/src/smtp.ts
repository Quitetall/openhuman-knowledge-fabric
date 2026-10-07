/**
 * Where the digest is sent from: an SMTP relay named in an owner-only file (KF-WAR-0006).
 *
 *   KF_NOTIFY_SMTP_FILE           JSON: {"host", "port", "security": "tls" | "starttls" | "none",
 *                                 "user"?, "from"}, an owner-only file
 *   KF_NOTIFY_SMTP_PASSWORD_FILE  the relay password, when `user` is set, an owner-only file
 *
 * `security: "none"` is accepted only for a loopback relay (a local MTA, or a test sink): a digest
 * names records, and over a network it travels encrypted or not at all.
 */

import { readSecretFile } from '@kf/operations';
import { createTransport } from 'nodemailer';
import type { DigestMessage } from './digest.js';

export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly security: 'tls' | 'starttls' | 'none';
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
}

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);
const ADDRESS = /^[^@\s<>]+@[^@\s<>]+$/u;

export function parseSmtpSettings(raw: string, password?: string): SmtpSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('the SMTP settings file is not JSON');
  }
  const s = parsed as Record<string, unknown>;
  const host = s['host'];
  const port = s['port'];
  const security = s['security'];
  const from = s['from'];
  const user = s['user'];
  if (typeof host !== 'string' || host === '') throw new Error('SMTP settings need a host');
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP settings need a port');
  }
  if (security !== 'tls' && security !== 'starttls' && security !== 'none') {
    throw new Error('SMTP security must be tls, starttls or none');
  }
  if (security === 'none' && !LOOPBACK.has(host)) {
    throw new Error('SMTP security none is allowed only for a loopback relay');
  }
  if (typeof from !== 'string' || !ADDRESS.test(from)) {
    throw new Error('SMTP settings need a from address');
  }
  if (user !== undefined && (typeof user !== 'string' || user === '')) {
    throw new Error('SMTP user, when given, must be text');
  }
  if (typeof user === 'string' && password === undefined) {
    throw new Error('SMTP user is set, so KF_NOTIFY_SMTP_PASSWORD_FILE is required');
  }
  return {
    host,
    port,
    security,
    from,
    ...(typeof user === 'string' ? { user } : {}),
    ...(password === undefined ? {} : { password }),
  };
}

export function loadSmtpSettings(env: NodeJS.ProcessEnv = process.env): SmtpSettings {
  const file = env['KF_NOTIFY_SMTP_FILE'];
  if (file === undefined || file === '') throw new Error('KF_NOTIFY_SMTP_FILE is not set');
  const passwordFile = env['KF_NOTIFY_SMTP_PASSWORD_FILE'];
  return parseSmtpSettings(
    readSecretFile(file, 'KF_NOTIFY_SMTP_FILE', undefined, env),
    passwordFile === undefined || passwordFile === ''
      ? undefined
      : readSecretFile(passwordFile, 'KF_NOTIFY_SMTP_PASSWORD_FILE', undefined, env),
  );
}

export interface Mailer {
  send(message: DigestMessage): Promise<void>;
  close(): void;
}

export function smtpMailer(settings: SmtpSettings): Mailer {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === 'tls',
    requireTLS: settings.security === 'starttls',
    ignoreTLS: settings.security === 'none',
    ...(settings.user === undefined
      ? {}
      : { auth: { user: settings.user, pass: settings.password ?? '' } }),
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    async send(message) {
      await transport.sendMail({
        from: settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
    close() {
      transport.close();
    },
  };
}
