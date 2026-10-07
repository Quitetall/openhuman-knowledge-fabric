#!/usr/bin/env node
/**
 * Make one database login's password, write its connection string, and print the SQL that sets
 * it — for this host's own PostgreSQL, from `scripts/deploy/provision-host.sh`.
 *
 *   node login-url.mjs <url-file> <login> <port> <database>
 *
 * <url-file> must already exist (the caller creates it 0600, owned correctly, and renames it into
 * place only after the SQL below succeeded, so a failed run never leaves a connection string the
 * server does not accept). It is truncated and receives `postgresql://<login>:<password>@
 * 127.0.0.1:<port>/<database>`.
 *
 * Stdout is one statement, `alter role "<login>" password '<SCRAM-SHA-256 verifier>';`, for the
 * caller to pipe into psql as the cluster's superuser. The PLAINTEXT never leaves this process:
 * not in argv, not in SQL (where `log_statement = ddl` would write it to the server log), not on
 * stdout. PostgreSQL stores a pre-hashed verifier as given — the same construction as
 * `apps/api/src/dogfood/config.ts` `scramVerifier`, which the dogfood loader uses for the same
 * reason.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [file, login, port, database] = process.argv.slice(2);
if (file === undefined || login === undefined || port === undefined || database === undefined) {
  process.stderr.write('usage: login-url.mjs <url-file> <login> <port> <database>\n');
  process.exit(64);
}
// Identifiers are written into SQL and a URL: accept only what needs no quoting in either.
for (const [name, value] of [
  ['login', login],
  ['database', database],
]) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    process.stderr.write(`login-url: ${name} ${JSON.stringify(value)} is not a plain identifier\n`);
    process.exit(64);
  }
}
if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  process.stderr.write(`login-url: ${JSON.stringify(port)} is not a port\n`);
  process.exit(64);
}

// Hex: nothing in it needs escaping in a URL, and 32 bytes is more than any guessing reaches.
const password = randomBytes(32).toString('hex');

function scramVerifier(secret) {
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(secret.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return (
    `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  );
}

// Into the existing file, so the mode and owner the caller gave it are kept.
writeFileSync(file, `postgresql://${login}:${password}@127.0.0.1:${port}/${database}\n`);
process.stdout.write(`alter role "${login}" password '${scramVerifier(password)}';\n`);
