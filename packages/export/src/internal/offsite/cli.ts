/** Bounded stdin carries credentials; stdout carries only verified public copy identity. */
import type { Readable, Writable } from 'node:stream';
import { createB2ArchiveStore } from './b2.js';
import {
  refuse,
  validateCopy,
  type B2ArchiveConfiguration,
  type OffsiteArchiveCopy,
  type OffsiteArchiveStore,
} from './contract.js';

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    refuse();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') refuse();
  return value;
}
async function request(
  input: Readable,
  signal?: AbortSignal,
): Promise<{ configuration: B2ArchiveConfiguration; copy: unknown }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => input.destroy(new Error('offsite stdin refused')), 15_000);
  timer.unref();
  const cancel = () => input.destroy(new Error('offsite stdin refused'));
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) refuse();
    for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > 16 * 1024 - size) refuse();
      chunks.push(Buffer.from(chunk));
      size += chunk.byteLength;
    }
    const bytes = Buffer.concat(chunks);
    const json = bytes.toString('utf8');
    if (!Buffer.from(json).equals(bytes)) refuse();
    const value = record(JSON.parse(json), ['format', 'configuration', 'copy']);
    if (value['format'] !== 'kf-offsite-request-v1') refuse();
    const cfg = record(value['configuration'], [
      'endpoint',
      'bucket',
      'applicationKeyId',
      'applicationKey',
    ]);
    return {
      configuration: {
        endpoint: text(cfg['endpoint']),
        bucket: text(cfg['bucket']),
        applicationKeyId: text(cfg['applicationKeyId']),
        applicationKey: text(cfg['applicationKey']),
      },
      copy: value['copy'],
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    input.destroy();
  }
}
function copy(value: unknown, cfg: B2ArchiveConfiguration, digest: string): OffsiteArchiveCopy {
  const raw = record(value, [
    'format',
    'endpoint',
    'bucket',
    'key',
    'versionId',
    'sha256',
    'sizeBytes',
  ]);
  if (raw['format'] !== 'kf-offsite-object-v1' || typeof raw['sizeBytes'] !== 'number') refuse();
  const result: OffsiteArchiveCopy = {
    format: 'kf-offsite-object-v1',
    endpoint: text(raw['endpoint']),
    bucket: text(raw['bucket']),
    key: text(raw['key']),
    versionId: text(raw['versionId']),
    sha256: text(raw['sha256']),
    sizeBytes: raw['sizeBytes'],
  };
  validateCopy(result, cfg.endpoint.replace(/\/$/, ''), cfg.bucket);
  if (result.sha256 !== digest) refuse();
  return result;
}

export async function runOffsiteCli(
  argv: readonly string[],
  input: Readable,
  output: Writable,
  signal?: AbortSignal,
  factory: (cfg: B2ArchiveConfiguration) => OffsiteArchiveStore = createB2ArchiveStore,
): Promise<void> {
  const [verb, path, digest, ...extra] = argv;
  if (
    !['publish', 'pull'].includes(verb ?? '') ||
    !path?.startsWith('/') ||
    !digest ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    extra.length
  )
    refuse();
  const parsed = await request(input, signal);
  if (signal?.aborted) refuse();
  const recorded = verb === 'pull' ? copy(parsed.copy, parsed.configuration, digest) : null;
  if (verb === 'publish' && parsed.copy !== null) refuse();
  const store = factory(parsed.configuration);
  try {
    if (recorded) await store.pull(recorded, path, signal);
    else {
      const published = await store.publish(path, signal);
      // Revalidate before emitting even if an internal adapter/test seam is substituted.
      const verified = copy(published, parsed.configuration, digest);
      await new Promise<void>((resolve, reject) =>
        output.write(`${JSON.stringify(verified)}\n`, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
  } finally {
    store.close();
  }
}
