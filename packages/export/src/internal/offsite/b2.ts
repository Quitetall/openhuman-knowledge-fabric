import { constants } from 'node:fs';
import { link, lstat, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  GetBucketAclCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import {
  OffsiteTransferRefused,
  refuse,
  version,
  validateCopy,
  type B2ArchiveConfiguration,
  type OffsiteArchiveCopy,
  type OffsiteArchiveStore,
} from './contract.js';
import { archiveFile, fileStream, inspect, missing, privateParent } from './io.js';
const DEADLINE_MS = 30 * 60 * 1000;
export function createB2ArchiveStore(config: B2ArchiveConfiguration): OffsiteArchiveStore {
  try {
    return new B2ArchiveAdapter(config);
  } catch {
    throw new OffsiteTransferRefused();
  }
}
/** Internal SDK seam for transport plants; production factory supplies its own pinned client. */
export class B2ArchiveAdapter implements OffsiteArchiveStore {
  readonly #client: S3Client;
  readonly #endpoint: string;
  readonly #bucket: string;
  #busy = false;
  #closed = false;
  #operation: AbortController | undefined;

  constructor(
    config: B2ArchiveConfiguration,
    clientFactory: (options: S3ClientConfig) => S3Client = (options) => new S3Client(options),
  ) {
    const match = /^https:\/\/s3\.([a-z]{2}-[a-z]+-[0-9]{3})\.backblazeb2\.com\/?$/.exec(
      config.endpoint,
    );
    if (
      !match ||
      typeof config.endpoint !== 'string' ||
      typeof config.bucket !== 'string' ||
      typeof config.applicationKeyId !== 'string' ||
      typeof config.applicationKey !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/.test(config.bucket) ||
      !/^[\x21-\x7e]{16,512}$/.test(config.applicationKeyId) ||
      !/^[\x21-\x7e]{16,512}$/.test(config.applicationKey)
    )
      refuse();
    this.#endpoint = config.endpoint.replace(/\/$/, '');
    this.#bucket = config.bucket;
    this.#client = clientFactory({
      endpoint: this.#endpoint,
      region: match[1]!,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.applicationKeyId,
        secretAccessKey: config.applicationKey,
      },
      maxAttempts: 1,
      followRegionRedirects: false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // No SDK logger may reflect request credentials or raw provider error bodies.
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    });
  }

  async publish(path: string, signal?: AbortSignal): Promise<OffsiteArchiveCopy> {
    return this.#run(signal, async (abort) => {
      const file = await archiveFile(path);
      try {
        const before = await file.stat();
        const digest = await inspect(fileStream(file, before.size), before.size, abort);
        const key = `kf-backups/v1/${digest}.tar.gpg`;
        await this.#policy(abort.signal);
        const body = fileStream(file, before.size);
        let versionId: string;
        try {
          const response = await this.#client.send(
            new PutObjectCommand({
              Bucket: this.#bucket,
              Key: key,
              Body: body,
              ContentLength: before.size,
              ContentType: 'application/pgp-encrypted',
              ACL: 'private',
            }),
            { abortSignal: abort.signal },
          );
          versionId = version(response.VersionId);
        } finally {
          body.destroy();
        }
        const copy: OffsiteArchiveCopy = {
          format: 'kf-offsite-object-v1',
          endpoint: this.#endpoint,
          bucket: this.#bucket,
          key,
          versionId,
          sha256: digest,
          sizeBytes: before.size,
        };
        if ((await this.#read(copy, abort)) !== digest) refuse();
        const after = await file.stat();
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          after.nlink !== 1
        )
          refuse();
        return copy;
      } finally {
        await file.close();
      }
    });
  }

  async pull(copy: OffsiteArchiveCopy, path: string, signal?: AbortSignal): Promise<void> {
    return this.#run(signal, async (abort) => {
      validateCopy(copy, this.#endpoint, this.#bucket);
      const parent = await privateParent(path);
      // Refuse an existing destination before network requests, then use link() for the race.
      try {
        await lstat(path);
        refuse();
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const staging = await mkdtemp(join(parent, '.kf-offsite-'));
      try {
        const stagedPath = join(staging, 'ciphertext');
        const file = await open(
          stagedPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        try {
          await this.#policy(abort.signal);
          const digest = await this.#read(copy, abort, file);
          if (digest !== copy.sha256) refuse();
          await file.sync();
        } finally {
          await file.close();
        }
        // Never rename over an operator's file or follow a final symlink.
        await link(stagedPath, path);
        const directory = await open(
          parent,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  async #read(
    copy: OffsiteArchiveCopy,
    abort: AbortController,
    file?: FileHandle,
  ): Promise<string> {
    const response = await this.#client.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: copy.key,
        VersionId: copy.versionId,
      }),
      { abortSignal: abort.signal },
    );
    const body = response.Body;
    if (!(body instanceof Readable)) refuse();
    try {
      if (response.VersionId !== copy.versionId || response.ContentLength !== copy.sizeBytes)
        refuse();
      return await inspect(body, copy.sizeBytes, abort, file);
    } finally {
      body.destroy();
    }
  }

  async #policy(signal: AbortSignal): Promise<void> {
    const versioning = await this.#client.send(
      new GetBucketVersioningCommand({ Bucket: this.#bucket }),
      { abortSignal: signal },
    );
    if (versioning.Status !== 'Enabled') refuse();
    const acl = await this.#client.send(new GetBucketAclCommand({ Bucket: this.#bucket }), {
      abortSignal: signal,
    });
    if (!acl.Owner?.ID || acl.Grants?.length !== 1) refuse();
    const grant = acl.Grants[0];
    if (
      grant?.Grantee?.Type !== 'CanonicalUser' ||
      grant.Grantee.ID !== acl.Owner.ID ||
      grant.Permission !== 'FULL_CONTROL'
    )
      refuse();
  }

  async #run<T>(
    signal: AbortSignal | undefined,
    action: (abort: AbortController) => Promise<T>,
  ): Promise<T> {
    if (this.#closed || this.#busy || signal?.aborted) refuse();
    this.#busy = true;
    const abort = new AbortController();
    this.#operation = abort;
    const timer = setTimeout(() => abort.abort(), DEADLINE_MS);
    timer.unref();
    const cancel = (): void => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await action(abort);
      if (abort.signal.aborted) refuse();
      return result;
    } catch {
      // Provider/SDK/filesystem errors may reflect credential values; no raw cause escapes.
      throw new OffsiteTransferRefused();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.#operation = undefined;
      this.#busy = false;
    }
  }

  close(): void {
    this.#closed = true;
    this.#operation?.abort();
    this.#client.destroy();
  }
}
