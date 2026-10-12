/**
 * The pins a host's semantic search is installed from say one thing, wherever they are written.
 *
 * deploy/retrieval/retrieval.release is what scripts/deploy/provision-retrieval.sh installs from;
 * scripts/embedding/model.py is what the provider refuses anything else than at startup;
 * scripts/embedding/prepare-model.py converts the Hub checkpoint; deploy/retrieval/bge-m3.sources
 * pins the Hub files; KF-WAR-0001's basis names the engine. A pin changed in one place and not
 * the others installs something the next layer refuses, on a host, after the network fetch.
 * The installer's behaviour is tests/deployment/provision-host.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function pins(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of read('deploy/retrieval/retrieval.release').split('\n')) {
    const match = /^([A-Z][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) result[match[1]!] = match[2]!;
  }
  return result;
}

/** A Python string constant, `NAME = '...'` or an f-string over MODEL_REVISION. */
function python(path: string, name: string): string {
  const text = read(path);
  const value = new RegExp(`^${name} = f?'([^']*)'$`, 'm').exec(text)?.[1];
  if (value === undefined) throw new Error(`${path} has no ${name}`);
  const revision = /^MODEL_REVISION = '([0-9a-f]{40})'$/m.exec(text)?.[1] ?? '';
  return value.replace('{MODEL_REVISION}', revision);
}

describe('the retrieval pins agree with the code that enforces them', () => {
  it('names the model the provider accepts, by identity and by manifest digest', () => {
    const p = pins();
    const revision = python('scripts/embedding/model.py', 'MODEL_REVISION');
    expect(p['MODEL_IDENTITY']).toBe(python('scripts/embedding/model.py', 'MODEL_NAME'));
    expect(p['MODEL_MANIFEST_SHA256']).toBe(python('scripts/embedding/model.py', 'MODEL_MANIFEST'));
    expect(p['MODEL_DIRECTORY']).toBe(`/opt/kf-models/bge-m3-${revision.slice(0, 12)}-f16`);
    expect(p['MODEL_SOURCE_URL']).toBe(`https://huggingface.co/BAAI/bge-m3/resolve/${revision}`);
  });

  it('converts exactly the Hub files it pins, the checkpoint by the same digest', () => {
    const sources = read('deploy/retrieval/bge-m3.sources')
      .trim()
      .split('\n')
      .map((line) => /^([0-9a-f]{64}) {2}(\S+)$/.exec(line));
    expect(sources.every((match) => match !== null)).toBe(true);
    const byName = new Map(sources.map((match) => [match![2]!, match![1]!]));
    expect(byName.get('pytorch_model.bin')).toBe(
      python('scripts/embedding/prepare-model.py', 'SOURCE_SHA256'),
    );
    const tokenizer = /^TOKENIZER_FILES = \(([^)]*)\)/m
      .exec(read('scripts/embedding/prepare-model.py'))?.[1]
      ?.match(/'[^']+'/g)
      ?.map((quoted) => quoted.slice(1, -1));
    expect([...byName.keys()].sort()).toEqual(['pytorch_model.bin', ...(tokenizer ?? [])].sort());
  });

  it('pins the engine KF-WAR-0001 names, and probes it for every option the startup passes', async () => {
    const p = pins();
    expect(p['LAMU_COMMIT']).toMatch(/^26923afb[0-9a-f]{32}$/);
    expect(read('docs/warrants/KF-WAR-0001/atoms/20-basis.md')).toContain(
      `binary sha256 \`${p['LAMU_SHA256_amd64']}\``,
    );
    const { engineArguments } = (await import(
      pathToFileURL(join(ROOT, 'scripts/retrieval/config.mjs')).href
    )) as { engineArguments: (config: unknown) => string[] };
    // The option the pinned build lacks is one the probe asks for.
    expect(
      engineArguments({
        releaseManifestSha256: '0'.repeat(64),
        modelIdentity: 'm',
        embeddingPort: 1,
        allowedPeerUids: [1],
      }),
    ).toContain('--key-release-socket');
  });

  it('locks the CPU build of every wheel by hash, and nothing for a GPU', () => {
    const lock = read(pins()['EMBEDDING_LOCK']!);
    const requirements = [...lock.matchAll(/^([a-z0-9][a-z0-9._-]*)==(\S+) \\$/gm)];
    expect(requirements.length).toBeGreaterThan(10);
    for (const [, name, version] of requirements) {
      const block = lock.slice(lock.indexOf(`${name}==${version} \\`)).split(/\n(?=\S)/)[0]!;
      expect(block, name).toMatch(/--hash=sha256:[0-9a-f]{64}/);
    }
    expect(lock).toMatch(/^torch==2\.11\.0\+cpu \\$/m);
    expect(lock).toMatch(/^transformers==5\.5\.3 \\$/m);
    expect(lock).not.toMatch(/^(nvidia-|cuda-|triton==)/m);
    expect(pins()['EMBEDDING_PYTHON']).toBe('/usr/bin/python3.13');
  });

  it('serves the provider on a valid port, as the startup contract requires', () => {
    const port = Number(pins()['EMBEDDING_PORT']);
    expect(Number.isInteger(port) && port >= 1 && port <= 65535).toBe(true);
  });
});
