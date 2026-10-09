// Native deployment binding only. No secret values, alternative executables or legacy fallback.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, readdirSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applicationCredentialBindings } from './workstation-credentials.mjs';
import {
  applicationConsumerAccount,
  applicationConsumerPlan,
} from './internal/application-consumer-plan.mjs';

function refuse() {
  throw new Error('native application binding refused');
}
function protectedPath(path, file = false) {
  if (realpathSync(path) !== path) refuse();
  const metadata = lstatSync(path);
  if (file && (!metadata.isFile() || metadata.nlink !== 1)) refuse();
  for (let current = path; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.uid !== 0 || stat.isSymbolicLink() || (stat.mode & 0o7022) !== 0) refuse();
    if (current !== path && !stat.isDirectory()) refuse();
    if (current === dirname(current)) break;
  }
}
function run(command, plan) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: 'inherit',
    });
    const handlers = ['SIGTERM', 'SIGINT'].map((signal) => {
      const handler = () => child.kill(signal);
      process.on(signal, handler);
      return [signal, handler];
    });
    const cleanup = () =>
      handlers.forEach(([signal, handler]) => process.removeListener(signal, handler));
    child.once('error', () => {
      cleanup();
      reject(new Error('native application binding refused'));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}
async function main() {
  const [role, ...extra] = process.argv.slice(2);
  let fields;
  let account;
  try {
    account = applicationConsumerAccount(role);
    fields = applicationCredentialBindings(account);
  } catch {
    fields = undefined;
  }
  if (!fields || extra.length) {
    process.stderr.write(
      'usage: application-consumer.mjs api|worker|attestor|checkpoint|storage|readiness|compiler-determinism\n',
    );
    return 64;
  }
  if (
    process.platform !== 'linux' ||
    process.getuid() === 0 ||
    process.env.KF_SECRET_CUSTODY !== 'systemd'
  )
    refuse();
  const self = realpathSync(fileURLToPath(import.meta.url));
  const root = dirname(dirname(dirname(self)));
  const plan = applicationConsumerPlan(role, root, process.env);
  for (const file of [
    self,
    join(root, 'scripts/deploy/workstation-credentials.mjs'),
    join(root, 'scripts/deploy/internal/application-consumer-plan.mjs'),
    join(root, 'deploy/systemd/application-public-fields.json'),
    join(root, 'packages/operations/dist/internal/native-secret.js'),
    '/usr/bin/id',
    ...plan.commands.flatMap((command) => [command.executable, command.args[0]]),
  ])
    protectedPath(file, true);
  const identity = spawnSync('/usr/bin/id', ['-u', `kf-${account}`], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128,
  });
  if (
    identity.error ||
    identity.signal ||
    identity.status !== 0 ||
    !/^\d+\n$/.test(identity.stdout) ||
    Number(identity.stdout) !== process.getuid()
  )
    refuse();
  const work = lstatSync(plan.env.TMPDIR);
  if (
    realpathSync(plan.env.TMPDIR) !== plan.env.TMPDIR ||
    !work.isDirectory() ||
    work.uid !== process.getuid() ||
    statfsSync(plan.env.TMPDIR).type !== 0x01021994
  )
    refuse();
  protectedPath(dirname(plan.env.TMPDIR));
  // PID1 reapplies RuntimeDirectoryMode for each exec. Narrow the verified
  // attestor work directory here; its API-facing socket directory stays 0710.
  if (role === 'attestor' && (work.mode & 0o7777) === 0o710) chmodSync(plan.env.TMPDIR, 0o700);
  else if ((work.mode & 0o7777) !== 0o700) refuse();
  if ((lstatSync(plan.env.TMPDIR).mode & 0o7777) !== 0o700) refuse();
  const expected = fields.map(([, name]) => name).sort();
  if (
    JSON.stringify(readdirSync(plan.env.CREDENTIALS_DIRECTORY).sort()) !== JSON.stringify(expected)
  )
    refuse();
  const { verifyNativeSecret } = await import(
    pathToFileURL(join(root, 'packages/operations/dist/internal/native-secret.js')).href
  );
  for (const [, name] of fields)
    verifyNativeSecret(join(plan.env.CREDENTIALS_DIRECTORY, name), plan.env);
  if (role === 'checkpoint') protectedPath(plan.env.CHECKPOINT_PUBLIC_KEY_DIR);
  if (role === 'api' && plan.env.KF_PANDOC_PATH) protectedPath(plan.env.KF_PANDOC_PATH, true);
  for (const command of plan.commands) {
    const { code, signal } = await run(command, plan);
    if (signal) {
      process.kill(process.pid, signal);
      return 1;
    }
    if (code !== 0) return code ?? 1;
  }
  return 0;
}
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.stderr.write('native application binding refused\n');
    process.exitCode = 1;
  });
