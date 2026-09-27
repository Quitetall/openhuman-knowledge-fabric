#!/usr/bin/env node
// One request to the Véracier API as a persona, from a 0600 token file (never printed).
// Usage: node kf-act.mjs <token-file> <organization> <assignment> <classification> <METHOD> <route> [json-body]
// Prints the HTTP status and the response body; exits 0 only on 2xx. Used for the persona's own
// master-record compile (LAMU's --before-sources) and for the Records Office's grant/revoke acts.
import { readFileSync } from 'node:fs';
const [tokenFile, org, role, cls, method, route, body] = process.argv.slice(2);
const token = readFileSync(tokenFile, 'utf8').trim();
const api = `http://127.0.0.1:${process.env.KF_VERACIER_API_PORT ?? '4100'}`;
const res = await fetch(api + route, {
  method,
  headers: {
    authorization: `Bearer ${token}`,
    'x-kf-organization': org,
    'x-kf-acting-role': role,
    'x-kf-classification': cls,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  },
  ...(body === undefined ? {} : { body }),
});
const text = await res.text();
process.stdout.write(`${new Date().toISOString()} ${method} ${route} -> HTTP ${res.status}\n${text.slice(0, 2000)}\n`);
process.exit(res.ok ? 0 : 1);
