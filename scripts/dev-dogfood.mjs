#!/usr/bin/env node
/**
 * `pnpm dev:dogfood` — the dogfood profile on a workstation, with no owner SQL by hand.
 *
 * Starts kf-attestor first, waits until it answers on its socket, then starts the API and the web
 * app with the socket wired into the API and each process holding only its own database login
 * (`planDogfoodDev` in @kf/operations decides all of that and is what the tests check). Stops
 * everything when either half exits or on Ctrl-C.
 *
 * Needs, once: `pnpm dogfood:logins` (writes the two logins' connection strings 0600 under
 * $XDG_STATE_HOME/knowledge-fabric) and the OIDC_* / KF_WEB_OIDC_* values from .env.
 */
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { planDogfoodDev } from '@kf/operations';

const plan = planDogfoodDev(process.env);
if (!plan.ok) {
  process.stderr.write('pnpm dev:dogfood cannot start:\n');
  for (const problem of plan.problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(2);
}

const children = new Set();
let stopping = false;

function start(name, proc) {
  const child = spawn(proc.command, proc.args, { env: proc.env, stdio: 'inherit' });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      process.stderr.write(`dev:dogfood: ${name} exited (${signal ?? code}); stopping the rest\n`);
      stop(code ?? 1);
    }
  });
  return child;
}

function stop(code) {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));

function healthy(socketPath) {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/health', method: 'GET', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

process.stderr.write(`dev:dogfood: starting kf-attestor on ${plan.socket}\n`);
start('kf-attestor', plan.attestor);

// The attestor builds before it listens; give it a minute.
const deadline = Date.now() + 60_000;
while (!stopping && !(await healthy(plan.socket))) {
  if (Date.now() > deadline) {
    process.stderr.write(`dev:dogfood: kf-attestor did not answer on ${plan.socket} in 60 s\n`);
    stop(1);
    break;
  }
  await sleep(250);
}

if (!stopping) {
  process.stderr.write('dev:dogfood: kf-attestor answers; starting the API and the web app\n');
  start('api+web', plan.apps);
}
