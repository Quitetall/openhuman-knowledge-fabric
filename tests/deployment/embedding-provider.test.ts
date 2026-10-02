import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/** Real HTTP/parser/admission tests with a synthetic inference adapter; no model qualification. */
it('runs the production embedding interface and its refusals without ML dependencies', () => {
  const root = join(import.meta.dirname, '..', '..');
  const result = spawnSync('python3', [join(root, 'tests/deployment/embedding_provider_test.py')], {
    encoding: 'utf8',
    timeout: 25_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stderr).toContain('OK');
});
