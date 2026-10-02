import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  symlinkSync,
  statSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  GetBucketAclCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { B2ArchiveAdapter } from './internal/offsite/b2.js';
import { createB2ArchiveStore, type OffsiteArchiveCopy } from './offsite.js';

const config = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'opaque-backups',
  applicationKeyId: 'public-fixture-key-id',
  applicationKey: 'public-fixture-application-key',
};
const bytes = Buffer.concat([Buffer.from([0x85]), Buffer.from('public encrypted-packet fixture')]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const copy: OffsiteArchiveCopy = {
  format: 'kf-offsite-object-v1',
  endpoint: config.endpoint,
  bucket: config.bucket,
  key: `kf-backups/v1/${sha256}.tar.gpg`,
  versionId: 'historical-version-1',
  sha256,
  sizeBytes: bytes.length,
};
const made: string[] = [];
const clients: S3Client[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(
  plants: {
    body?: Buffer;
    version?: string;
    missingPutVersion?: boolean;
    missingGetVersion?: boolean;
    claimedLength?: number;
    stream?: Readable;
    publicBucket?: boolean;
    versioned?: boolean;
    fail?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'kf-b2-transport-'));
  made.push(root);
  const file = join(root, 'ciphertext.tar.gpg');
  writeFileSync(file, bytes);
  const client = new S3Client({ region: 'us-west-004' });
  clients.push(client);
  const send = vi.spyOn(client, 'send').mockImplementation(async (command: unknown) => {
    if (plants.fail) throw new Error(config.applicationKey);
    if (command instanceof GetBucketVersioningCommand)
      return { $metadata: {}, Status: plants.versioned === false ? 'Suspended' : 'Enabled' };
    if (command instanceof GetBucketAclCommand)
      return {
        $metadata: {},
        Owner: { ID: 'owner' },
        Grants: [
          {
            Grantee: { Type: plants.publicBucket ? 'Group' : 'CanonicalUser', ID: 'owner' },
            Permission: 'FULL_CONTROL',
          },
        ],
      };
    if (command instanceof PutObjectCommand)
      return {
        $metadata: {},
        VersionId: plants.missingPutVersion
          ? undefined
          : plants.version === 'null'
            ? 'null'
            : copy.versionId,
      };
    if (command instanceof GetObjectCommand)
      return {
        $metadata: {},
        VersionId: plants.missingGetVersion ? undefined : (plants.version ?? copy.versionId),
        ContentLength: plants.claimedLength ?? (plants.body ?? bytes).length,
        Body: plants.stream ?? Readable.from([plants.body ?? bytes]),
      };
    throw new Error('unexpected command');
  });
  return { root, file, send, store: new B2ArchiveAdapter(config, () => client) };
}

describe('version-pinned B2 ciphertext transfer (controlled SDK responses, not provider commissioning)', () => {
  it('publishes only after downloading and hashing the exact returned version', async () => {
    const { store, file, send } = fixture();
    await expect(store.publish(file)).resolves.toEqual(copy);
    const requests = send.mock.calls.map(([command]) => command);
    const get = requests.find((request) => request instanceof GetObjectCommand);
    expect(get).toBeInstanceOf(GetObjectCommand);
    expect((get as GetObjectCommand).input).toMatchObject({
      Bucket: copy.bucket,
      Key: copy.key,
      VersionId: copy.versionId,
    });
  });
  it('pulls the recorded historical version into a new private file', async () => {
    const { store, root, send } = fixture();
    const destination = join(root, 'restored.tar.gpg');
    await store.pull(copy, destination);
    expect(readFileSync(destination)).toEqual(bytes);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(
      send.mock.calls.find(([command]) => command instanceof GetObjectCommand)?.[0],
    ).toMatchObject({ input: { VersionId: copy.versionId } });
  });
  it.each([
    { body: Buffer.from([0x85, 1]) },
    { body: Buffer.concat([bytes, Buffer.from('extra')]) },
    { version: 'another-version' },
    { version: 'null' },
    { missingPutVersion: true },
    { missingGetVersion: true },
    { body: Buffer.from([0x85, 1]), claimedLength: bytes.length },
    { body: Buffer.concat([bytes, Buffer.from('extra')]), claimedLength: bytes.length },
    { body: Buffer.alloc(bytes.length, 0x85) },
  ])('refuses mismatched bytes or missing/wrong historical identity: %j', async (plant) => {
    const { store, file } = fixture(plant);
    await expect(store.publish(file)).rejects.toMatchObject({ code: 'offsite_transfer_refused' });
  });
  it.each([{ publicBucket: true }, { versioned: false }])(
    'refuses unsafe bucket policy before uploading: %j',
    async (plant) => {
      const { store, file, send } = fixture(plant);
      await expect(store.publish(file)).rejects.toMatchObject({ code: 'offsite_transfer_refused' });
      expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
    },
  );
  it('refuses plaintext and leaves an existing destination unchanged', async () => {
    const { store, file, root, send } = fixture();
    writeFileSync(file, 'plaintext archive');
    await expect(store.publish(file)).rejects.toMatchObject({ code: 'offsite_transfer_refused' });
    expect(send).not.toHaveBeenCalled();
    const destination = join(root, 'existing');
    writeFileSync(destination, 'keep me');
    await expect(store.pull(copy, destination)).rejects.toMatchObject({
      code: 'offsite_transfer_refused',
    });
    expect(readFileSync(destination, 'utf8')).toBe('keep me');
  });
  it('removes only its staged file on a refused download and suppresses provider error values', async () => {
    const { store, root } = fixture({ fail: true });
    const destination = join(root, 'refused');
    await expect(store.pull(copy, destination)).rejects.toThrow(
      'off-site ciphertext transfer refused',
    );
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(root)).toEqual(['ciphertext.tar.gpg']);
  });
  it.each([
    Buffer.alloc(bytes.length, 0x85),
    bytes.subarray(0, bytes.length - 1),
    Buffer.concat([bytes, Buffer.from('extra')]),
  ])(
    'cleans staged mismatched downloads without publishing or touching the source: %j',
    async (plant) => {
      const stream = Readable.from([plant]);
      const { store, root, file } = fixture({ stream, claimedLength: bytes.length });
      await expect(store.pull(copy, join(root, 'refused'))).rejects.toMatchObject({
        code: 'offsite_transfer_refused',
      });
      expect(readFileSync(file)).toEqual(bytes);
      expect(stream.destroyed).toBe(true);
      expect(readdirSync(root)).toEqual(['ciphertext.tar.gpg']);
    },
  );
  it('preserves an operator file created during the download instead of overwriting it', async () => {
    let destination = '';
    const stream = Readable.from(
      (async function* () {
        if (!destination) throw new Error('raced-file fixture was not configured');
        writeFileSync(destination, 'keep raced file');
        yield bytes;
      })(),
    );
    const { store, root } = fixture({ stream });
    destination = join(root, 'raced');
    await expect(store.pull(copy, destination)).rejects.toMatchObject({
      code: 'offsite_transfer_refused',
    });
    expect(readFileSync(destination, 'utf8')).toBe('keep raced file');
    expect(readdirSync(root).sort()).toEqual(['ciphertext.tar.gpg', 'raced']);
  });
  it('refuses a FIFO without waiting for another process to open it', async () => {
    const { store, root, send } = fixture();
    const fifo = join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    await expect(store.publish(fifo)).rejects.toMatchObject({ code: 'offsite_transfer_refused' });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { endpoint: 'https://s3.eu-central-003.backblazeb2.com' },
    { bucket: 'wrong-bucket' },
    { key: 'somewhere-else' },
    { versionId: '' },
    { sha256: 'not-a-digest' },
    { sizeBytes: 0 },
    { sizeBytes: 5 * 1024 * 1024 * 1024 + 1 },
  ])('refuses an invalid or foreign receipt without network access: %j', async (plant) => {
    const { store, root, send } = fixture();
    await expect(store.pull({ ...copy, ...plant }, join(root, 'refused'))).rejects.toMatchObject({
      code: 'offsite_transfer_refused',
    });
    expect(send).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual(['ciphertext.tar.gpg']);
  });
  it('refuses source symlinks, multiple links and a non-private restore directory', async () => {
    const { store, root, file, send } = fixture();
    const alias = join(root, 'alias');
    symlinkSync(file, alias);
    await expect(store.publish(alias)).rejects.toMatchObject({ code: 'offsite_transfer_refused' });
    rmSync(alias);
    linkSync(file, alias);
    await expect(store.publish(file)).rejects.toMatchObject({ code: 'offsite_transfer_refused' });
    chmodSync(root, 0o755);
    await expect(store.pull(copy, join(root, 'refused'))).rejects.toMatchObject({
      code: 'offsite_transfer_refused',
    });
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['abort', 'close'] as const)(
    'cancels a stalled stream on %s and cleans only its staging',
    async (mode) => {
      const stream = new Readable({ read() {} });
      const { store, root, send } = fixture({ stream });
      const abort = new AbortController();
      const destination = join(root, 'refused');
      const result = store.pull(copy, destination, abort.signal);
      const rejected = expect(result).rejects.toMatchObject({ code: 'offsite_transfer_refused' });
      await vi.waitFor(() =>
        expect(send.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(true),
      );
      await expect(store.publish(join(root, 'ciphertext.tar.gpg'))).rejects.toMatchObject({
        code: 'offsite_transfer_refused',
      });
      if (mode === 'close') store.close();
      else abort.abort();
      await rejected;
      expect(stream.destroyed).toBe(true);
      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(root)).toEqual(['ciphertext.tar.gpg']);
      if (mode === 'close')
        await expect(store.pull(copy, destination)).rejects.toMatchObject({
          code: 'offsite_transfer_refused',
        });
    },
  );
  it('refuses already-cancelled calls without starting any transfer', async () => {
    const { store, file, send } = fixture();
    await expect(store.publish(file, AbortSignal.abort())).rejects.toMatchObject({
      code: 'offsite_transfer_refused',
    });
    expect(send).not.toHaveBeenCalled();
  });
  it('enforces the operation deadline and cleans a stalled download', async () => {
    vi.useFakeTimers();
    const stream = new Readable({ read() {} });
    const { store, root, send } = fixture({ stream });
    const rejected = expect(store.pull(copy, join(root, 'refused'))).rejects.toMatchObject({
      code: 'offsite_transfer_refused',
    });
    await vi.waitFor(() =>
      expect(send.mock.calls.some(([command]) => command instanceof GetObjectCommand)).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await rejected;
    expect(stream.destroyed).toBe(true);
    expect(readdirSync(root)).toEqual(['ciphertext.tar.gpg']);
  });
  it('refuses redirected/insecure endpoints before creating a client', () => {
    for (const endpoint of [
      'http://s3.us-west-004.backblazeb2.com',
      'https://evil.example',
      `${config.endpoint}/other`,
      `${config.endpoint}?host=evil`,
    ]) {
      expect(() => createB2ArchiveStore({ ...config, endpoint })).toThrow(
        'off-site ciphertext transfer refused',
      );
    }
  });
});
