/** Controller/stdio plants; the transport wire suite and PostgreSQL suite prove the other seams. */
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runOffsiteCli } from './internal/offsite/cli.js';

const cfg = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'opaque-backups',
  applicationKeyId: 'public-fixture-key-id',
  applicationKey: 'public-fixture-application-key',
};
const digest = 'a'.repeat(64);
const copy = {
  format: 'kf-offsite-object-v1' as const,
  endpoint: cfg.endpoint,
  bucket: cfg.bucket,
  key: `kf-backups/v1/${digest}.tar.gpg`,
  versionId: 'exact-historical-version',
  sha256: digest,
  sizeBytes: 123,
};
const packet = (value: unknown = null) => ({
  format: 'kf-offsite-request-v1',
  configuration: cfg,
  copy: value,
});
function fixture(value: unknown = packet(), published = copy) {
  let stdout = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      stdout += String(chunk);
      done();
    },
  });
  const store = {
    publish: vi.fn(async () => published),
    pull: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const factory = vi.fn(() => store);
  const input = Readable.from([
    Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
  ]);
  return { stdout: () => stdout, output, store, factory, input };
}
describe('the cloud CLI has bounded secret stdin and verified identity-only stdout', () => {
  it('emits only the closed verified publish identity and closes its adapter', async () => {
    const f = fixture();
    await runOffsiteCli(
      ['publish', '/private/ciphertext', digest],
      f.input,
      f.output,
      undefined,
      f.factory,
    );
    expect(JSON.parse(f.stdout())).toEqual(copy);
    expect(f.stdout()).not.toContain(cfg.applicationKey);
    expect(f.factory).toHaveBeenCalledWith(cfg);
    expect(f.store.close).toHaveBeenCalledOnce();
  });
  it('passes a trusted recorded identity to pull and emits nothing', async () => {
    const f = fixture(packet(copy));
    await runOffsiteCli(['pull', '/private/new', digest], f.input, f.output, undefined, f.factory);
    expect(f.store.pull).toHaveBeenCalledWith(copy, '/private/new', undefined);
    expect(f.stdout()).toBe('');
    expect(f.store.close).toHaveBeenCalledOnce();
  });
  it.each([
    { ...packet(), unexpected: true },
    { ...packet(), format: 'other' },
    { ...packet(), configuration: { ...cfg, unrequested: 'extra' } },
    { ...packet(), configuration: null },
    Buffer.alloc(16 * 1024 + 1, 0x61),
    Buffer.from([0xff]),
    packet({ ...copy, versionId: '' }),
    packet({ ...copy, applicationKey: cfg.applicationKey }),
    packet({ ...copy, sha256: 'b'.repeat(64) }),
    packet({ ...copy, endpoint: 'https://s3.eu-central-003.backblazeb2.com' }),
  ])(
    'refuses malformed/foreign input before constructing a network adapter: case %#',
    async (value) => {
      const f = fixture(value);
      await expect(
        runOffsiteCli(['pull', '/private/new', digest], f.input, f.output, undefined, f.factory),
      ).rejects.toThrow();
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.stdout()).toBe('');
    },
  );
  it('refuses a response not bound to the independently measured source digest without crediting it', async () => {
    const other = 'b'.repeat(64);
    const f = fixture(packet(), { ...copy, sha256: other, key: `kf-backups/v1/${other}.tar.gpg` });
    await expect(
      runOffsiteCli(
        ['publish', '/private/source', digest],
        f.input,
        f.output,
        undefined,
        f.factory,
      ),
    ).rejects.toThrow();
    expect(f.stdout()).toBe('');
    expect(f.store.close).toHaveBeenCalledOnce();
  });
  it('requires only a verb, absolute path and digest, never credential arguments', async () => {
    const f = fixture();
    await expect(
      runOffsiteCli(
        ['publish', '/private/source', digest, cfg.applicationKey],
        f.input,
        f.output,
        undefined,
        f.factory,
      ),
    ).rejects.toThrow();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.stdout()).toBe('');
  });
  it('cancels stalled secret input immediately without constructing a network adapter', async () => {
    const f = fixture();
    const input = new PassThrough();
    const abort = new AbortController();
    const pending = runOffsiteCli(
      ['publish', '/private/source', digest],
      input,
      f.output,
      abort.signal,
      f.factory,
    );
    const rejected = expect(pending).rejects.toThrow();
    try {
      await Promise.resolve();
      abort.abort();
      await Promise.resolve();
      expect(input.destroyed).toBe(true);
      await rejected;
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.stdout()).toBe('');
    } finally {
      input.destroy(new Error('public test cleanup'));
      await rejected;
    }
  });
  it('expires stalled secret input after its bounded deadline, before any network adapter', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const input = new PassThrough();
    const rejected = expect(
      runOffsiteCli(['publish', '/private/source', digest], input, f.output, undefined, f.factory),
    ).rejects.toThrow();
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(input.destroyed).toBe(true);
      expect(f.factory).not.toHaveBeenCalled();
    } finally {
      input.destroy();
      vi.useRealTimers();
    }
  });
});
