/**
 * A real, isolated object store for tests: the SeaweedFS the development stack runs (ADR 0039),
 * in a container of its own, on a volume of its own, initialised by the same script.
 *
 * Shared by the OW-WAR-0111 preservation drill, which stops a store, copies its /data and
 * reconnects restored records to a new one, and by the versioning test, which needs a working
 * store whose buckets it can inspect and plant.
 *
 * NOTHING HERE IS A SECOND COPY OF THE STORE'S CONFIGURATION. The image (release and digest) and
 * the server's arguments are read from the `seaweedfs` service in docker-compose.yml, and buckets
 * are made by deploy/object-store/init-buckets.sh — so a change there is the change tested here.
 * Until 2026-10 this fixture ran MinIO images built from source, because every registry had
 * deleted MinIO's own (tests/fixtures/minio-image, retired with MinIO).
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { S3ObjectStore } from '@kf/artifacts';

const exec = promisify(execFile);
const REPO = resolve(import.meta.dirname, '../..');
const COMPOSE = join(REPO, 'docker-compose.yml');
const INIT = join(REPO, 'deploy/object-store/init-buckets.sh');
const READY = join(REPO, 'deploy/object-store/ready.sh');
const S3_PORT = '8333';
// Public fixture credentials, isolated from user services and used only in these containers.
const ACCESS = 'ow111-fixture';
const SECRET = 'ow111-disposable-not-a-secret';
const REGION = 'us-east-1';

export interface StoreService {
  /** The `seaweedfs` service's image, exactly as docker-compose.yml pins it. */
  readonly image: string;
  /** The server's arguments, exactly as docker-compose.yml gives them. */
  readonly command: readonly string[];
}

/** Read the `seaweedfs` service's image and command from docker-compose.yml. */
export async function composeStoreService(file = COMPOSE): Promise<StoreService> {
  const text = await readFile(file, 'utf8');
  const service = /^ {2}seaweedfs:\n((?: {4}.*\n|\s*\n)+)/m.exec(text)?.[1];
  if (service === undefined) throw new Error(`${file} has no seaweedfs service`);
  const image = /^ {4}image: (\S+)$/m.exec(service)?.[1];
  const command = /^ {4}command:\n((?: {6}- .*\n)+)/m
    .exec(service)?.[1]
    ?.trimEnd()
    .split('\n')
    .map((line) => line.replace(/^ {6}- /, ''));
  if (image === undefined || command === undefined) {
    throw new Error(`${file}: the seaweedfs service has no image or no command list`);
  }
  return { image, command };
}

async function docker(...args: string[]): Promise<string> {
  return (await exec('docker', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

/** `docker <args>` with `input` on stdin: how a credential reaches a container, never argv. */
async function dockerWithInput(input: string, ...args: string[]): Promise<string> {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  child.stdin.end(input);
  const code = await new Promise<number | null>((done, fail) => {
    child.once('error', fail);
    child.once('close', (exitCode) => done(exitCode));
  });
  const stdout = Buffer.concat(out).toString('utf8');
  if (code !== 0) {
    throw new Error(
      `docker ${args[0] ?? ''} exited ${code ?? 'by signal'}: ${stdout}${Buffer.concat(err).toString('utf8')}`,
    );
  }
  return stdout.trim();
}

export interface StartedStore {
  readonly id: string;
  readonly endpoint: string;
  /** A store on the first bucket. */
  readonly store: S3ObjectStore;
}

export class PreservationObjectStore {
  private readonly containers: string[] = [];
  private readonly volumes: string[] = [];
  private backup: string | undefined;
  private config: string | undefined;
  private service: StoreService | undefined;

  /** `buckets` undefined: init-buckets.sh's own default list, as the development stack gets. */
  constructor(private readonly buckets?: readonly string[]) {}

  /** Start a store and create the buckets with versioning on, through init-buckets.sh. */
  async start(): Promise<StartedStore> {
    const service = await composeStoreService();
    this.service = service;
    // A missing image is pulled by its pinned digest; a pull that fails says so.
    await docker('image', 'inspect', '--format', '{{.Id}}', service.image).catch(() =>
      docker('pull', '--quiet', service.image),
    );
    this.config = await mkdtemp(join(tmpdir(), 'kf-objects-fixture-'));
    // The identities file is the store's only source of credentials (-s3.config). The container's
    // own user, which is not this one, reads it, so it is world-readable: its values are this
    // fixture's public ones.
    await writeFile(
      join(this.config, 'identities.json'),
      JSON.stringify({
        identities: [
          {
            name: 'kf-fixture',
            credentials: [{ accessKey: ACCESS, secretKey: SECRET }],
            actions: ['Admin', 'Read', 'List', 'Tagging', 'Write'],
          },
        ],
      }),
    );
    await chmod(join(this.config, 'identities.json'), 0o644);
    await writeFile(join(this.config, 'secret'), SECRET);
    await chmod(join(this.config, 'secret'), 0o644);
    const id = await this.create();
    const opened = await this.launch(id);
    await this.initialise(id, this.buckets);
    return { id, ...opened };
  }

  private async create(): Promise<string> {
    if (this.service === undefined || this.config === undefined) throw new Error('not started');
    const volume = `ow111-${randomUUID()}`;
    await docker('volume', 'create', volume);
    this.volumes.push(volume);
    const id = await docker(
      'create',
      '--name',
      `ow111-${randomUUID()}`,
      '--publish',
      `127.0.0.1::${S3_PORT}`,
      '--mount',
      `type=volume,src=${volume},dst=/data`,
      '--mount',
      `type=bind,src=${join(this.config, 'identities.json')},dst=/etc/seaweedfs/identities.json,readonly`,
      '--mount',
      `type=bind,src=${READY},dst=/kf/ready.sh,readonly`,
      this.service.image,
      ...this.service.command,
    );
    this.containers.push(id);
    return id;
  }

  private async launch(id: string): Promise<{ endpoint: string; store: S3ObjectStore }> {
    await docker('start', id);
    const address = (await docker('port', id, `${S3_PORT}/tcp`)).split('\n')[0] ?? '';
    const endpoint = `http://${address}`;
    // Ready to SERVE, not just listening: the compose healthcheck's own script. A restored /data
    // answers reads with InternalError until the master knows its volumes, and the restore drill
    // reads immediately.
    const deadline = Date.now() + 90_000;
    while (true) {
      const ready = await docker('exec', id, 'sh', '/kf/ready.sh', '/data').then(
        () => true,
        () => false,
      );
      if (ready) break;
      if (Date.now() >= deadline) throw new Error('fixture object store did not become ready');
      await setTimeout(250);
    }
    return { endpoint, store: this.open(endpoint, this.buckets?.[0] ?? 'kf-artifacts') };
  }

  /** A store on `bucket` of the running fixture at `endpoint`. */
  open(endpoint: string, bucket: string): S3ObjectStore {
    return new S3ObjectStore({ ...this.credentials(endpoint), bucket, forcePathStyle: true });
  }

  /** The routing and credential a client needs, for tests that speak S3 themselves. */
  credentials(endpoint: string): {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  } {
    return { endpoint, region: REGION, accessKeyId: ACCESS, secretAccessKey: SECRET };
  }

  /** Run deploy/object-store/init-buckets.sh against the store, in the store's own image. */
  async initialise(id: string, buckets?: readonly string[]): Promise<string> {
    if (this.service === undefined || this.config === undefined) throw new Error('not started');
    return docker(
      'run',
      '--rm',
      '--network',
      `container:${id}`,
      '--mount',
      `type=bind,src=${INIT},dst=/kf/init-buckets.sh,readonly`,
      '--mount',
      `type=bind,src=${join(this.config, 'secret')},dst=/kf/secret,readonly`,
      '--env',
      `KF_OBJECTS_ENDPOINT=http://127.0.0.1:${S3_PORT}`,
      '--env',
      `KF_OBJECTS_ACCESS_KEY_ID=${ACCESS}`,
      '--env',
      'KF_OBJECTS_SECRET_ACCESS_KEY_FILE=/kf/secret',
      ...(buckets === undefined ? [] : ['--env', `KF_OBJECTS_BUCKETS=${buckets.join(' ')}`]),
      '--entrypoint',
      '/bin/sh',
      this.service.image,
      '/kf/init-buckets.sh',
    );
  }

  /**
   * One signed S3 request from inside the store's network, through curl in the store's image;
   * the credential goes in on stdin.
   */
  async request(
    id: string,
    method: string,
    target: string,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    if (this.service === undefined) throw new Error('not started');
    // curl's config syntax: a double-quoted value, with \" for a quote inside it.
    const data = body === undefined ? '' : `data-binary = "${body.replaceAll('"', '\\"')}"\n`;
    const answer = await dockerWithInput(
      `user = "${ACCESS}:${SECRET}"\n${data}`,
      'run',
      '--rm',
      '--interactive',
      '--network',
      `container:${id}`,
      '--entrypoint',
      'curl',
      this.service.image,
      '--silent',
      '--show-error',
      '-K',
      '-',
      '--aws-sigv4',
      `aws:amz:${REGION}:s3`,
      '-X',
      method,
      '--write-out',
      '\n%{http_code}',
      `http://127.0.0.1:${S3_PORT}/${target}`,
    );
    const split = answer.lastIndexOf('\n');
    return { status: Number(answer.slice(split + 1)), body: answer.slice(0, Math.max(split, 0)) };
  }

  /** Suspend versioning on `bucket`, as an operator (or a mistake) could. */
  async suspendVersioning(id: string, bucket: string): Promise<void> {
    const answer = await this.request(
      id,
      'PUT',
      `${bucket}?versioning`,
      '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Suspended</Status></VersioningConfiguration>',
    );
    if (answer.status !== 200) throw new Error(`suspending ${bucket}: ${answer.body}`);
  }

  /** Remove exactly one version of `key` in `bucket`: what a lost or destroyed copy looks like. */
  async deleteVersion(id: string, bucket: string, key: string, versionId: string): Promise<void> {
    const answer = await this.request(
      id,
      'DELETE',
      `${bucket}/${key}?versionId=${encodeURIComponent(versionId)}`,
    );
    if (answer.status !== 204) throw new Error(`delete of ${key}@${versionId}: ${answer.body}`);
  }

  async restore(sourceId: string): Promise<StartedStore> {
    if (this.service === undefined) throw new Error('not started');
    // Quiesce source before copying, then remove it before opening the restored service.
    await docker('stop', sourceId);
    this.backup = await mkdtemp(join(tmpdir(), 'ow111-objects-'));
    await docker('cp', `${sourceId}:/data/.`, this.backup);
    await docker('rm', sourceId);
    this.containers.splice(this.containers.indexOf(sourceId), 1);
    const id = await this.create();
    await docker('cp', `${this.backup}/.`, `${id}:/data`);
    // `docker cp` writes as root; the server runs as the image's own `seaweed` user. Restoring a
    // file-level copy includes giving it back to the account that owns the store.
    await docker(
      'run',
      '--rm',
      '--mount',
      `type=volume,src=${this.volumes.at(-1) ?? ''},dst=/data`,
      '--entrypoint',
      'chown',
      this.service.image,
      '-R',
      'seaweed:seaweed',
      '/data',
    );
    return { id, ...(await this.launch(id)) };
  }

  async stop(): Promise<void> {
    // Only exact resources allocated by this fixture are eligible for cleanup.
    const removed = await Promise.allSettled(
      this.containers.map((id) => docker('rm', '--force', id)),
    );
    const volumes = await Promise.allSettled(
      this.volumes.map((volume) => docker('volume', 'rm', volume)),
    );
    const files = await Promise.allSettled(
      [this.backup, this.config]
        .filter((path): path is string => path !== undefined)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
    const failures = [...removed, ...volumes, ...files].filter(
      (result) => result.status === 'rejected',
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'fixture cleanup failed',
      );
  }
}
