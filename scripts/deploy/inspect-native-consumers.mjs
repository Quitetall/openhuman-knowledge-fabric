// Read-only current-process CLI. No PID/helper/namespace/environment selectors.
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROLES = ['api', 'worker', 'attestor', 'checkpoint', 'storage', 'readiness'];
function protectedFile(path) {
  if (realpathSync(path) !== path) throw new Error('refused');
  const file = lstatSync(path);
  if (!file.isFile() || file.nlink !== 1) throw new Error('refused');
  for (let at = path; ; at = dirname(at)) {
    const stat = lstatSync(at);
    if (
      stat.uid !== 0 ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o7022) !== 0 ||
      (at !== path && !stat.isDirectory())
    )
      throw new Error('refused');
    if (at === dirname(at)) break;
  }
}
async function main() {
  const args = process.argv.slice(2),
    json = args.includes('--json');
  const selected = args.filter((value) => value !== '--json');
  if (
    args.filter((value) => value === '--json').length > 1 ||
    selected.length > 1 ||
    (selected.length && !ROLES.includes(selected[0]))
  ) {
    process.stderr.write(
      'usage: inspect-native-consumers.mjs [api|worker|attestor|checkpoint|storage|readiness] [--json]\n',
    );
    return 64;
  }
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('refused');
  const self = realpathSync(fileURLToPath(import.meta.url)),
    release = dirname(dirname(dirname(self)));
  for (const path of [
    self,
    join(release, 'scripts/deploy/workstation-credentials.mjs'),
    join(release, 'scripts/deploy/internal/native-consumer-observation.mjs'),
    join(release, 'scripts/deploy/internal/native-consumer-verdict.mjs'),
  ])
    protectedFile(path);
  const { observeNativeConsumer } = await import('./internal/native-consumer-observation.mjs');
  const { nativeConsumerVerdict } = await import('./internal/native-consumer-verdict.mjs');
  const checks = [];
  for (const role of selected.length ? selected : ROLES)
    checks.push(nativeConsumerVerdict(role, await observeNativeConsumer(role, release)));
  const report = {
    schema: 'kf-native-consumer-posture/v1',
    scope: 'current-main-process-metadata',
    complete: checks.every((check) => check.status === 'satisfied'),
    checks,
  };
  if (json) process.stdout.write(JSON.stringify(report) + '\n');
  else
    for (const check of checks)
      process.stdout.write(`${check.role}: ${check.status}: ${check.detail}\n`);
  return report.complete ? 0 : 1;
}
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    process.stderr.write('native consumer inspection unavailable\n');
    process.exitCode = 2;
  });
