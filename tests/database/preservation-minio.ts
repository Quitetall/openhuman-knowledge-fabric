/** Real, isolated object-store restore fixture for shared OW-WAR-0111. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { S3ObjectStore } from '@kf/artifacts';

const exec = promisify(execFile);
const IMAGE = 'minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';
const CLIENT = 'minio/mc@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727';
// Public fixture credentials, isolated from user services and used only in these containers.
const ACCESS = 'ow111-fixture';
const SECRET = 'ow111-disposable-not-a-secret';
const BUCKET = 'preserved';

async function docker(...args: string[]): Promise<string> {
  return (await exec('docker', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

export class PreservationMinio {
  private readonly containers: string[] = [];
  private readonly volumes: string[] = [];
  private backup: string | undefined;

  async start(): Promise<{ id: string; store: S3ObjectStore }> {
    const id = await this.create();
    const store = await this.launch(id);
    await this.client(id, 'mb', '--ignore-existing', `fixture/${BUCKET}`);
    await this.client(id, 'version', 'enable', `fixture/${BUCKET}`);
    return { id, store };
  }

  private async create(): Promise<string> {
    const volume = `ow111-${randomUUID()}`;
    await docker('volume', 'create', volume);
    this.volumes.push(volume);
    const id = await docker(
      'create',
      '--name',
      `ow111-${randomUUID()}`,
      '--publish',
      '127.0.0.1::9000',
      '--env',
      `MINIO_ROOT_USER=${ACCESS}`,
      '--env',
      `MINIO_ROOT_PASSWORD=${SECRET}`,
      '--mount',
      `type=volume,src=${volume},dst=/data`,
      IMAGE,
      'server',
      '/data',
    );
    this.containers.push(id);
    return id;
  }

  private async launch(id: string): Promise<S3ObjectStore> {
    await docker('start', id);
    const address = await docker('port', id, '9000/tcp');
    const endpoint = `http://${address}`;
    const deadline = Date.now() + 45_000;
    while (true) {
      try {
        const response = await fetch(`${endpoint}/minio/health/live`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) break;
      } catch {
        /* A new server has not bound its listener yet. */
      }
      if (Date.now() >= deadline) throw new Error('fixture MinIO did not become ready');
      await setTimeout(200);
    }
    return new S3ObjectStore({
      endpoint,
      region: 'us-east-1',
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      bucket: BUCKET,
      forcePathStyle: true,
    });
  }

  async client(id: string, ...args: string[]): Promise<void> {
    await docker(
      'run',
      '--rm',
      '--network',
      `container:${id}`,
      '--env',
      `MC_HOST_fixture=http://${ACCESS}:${SECRET}@127.0.0.1:9000`,
      CLIENT,
      ...args,
    );
  }

  async restore(sourceId: string): Promise<{ id: string; store: S3ObjectStore }> {
    // Quiesce source before copying, then remove it before opening the restored service.
    await docker('stop', sourceId);
    this.backup = await mkdtemp(join(tmpdir(), 'ow111-minio-'));
    await docker('cp', `${sourceId}:/data/.`, this.backup);
    await docker('rm', sourceId);
    this.containers.splice(this.containers.indexOf(sourceId), 1);
    const id = await this.create();
    await docker('cp', `${this.backup}/.`, `${id}:/data`);
    return { id, store: await this.launch(id) };
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
      this.backup === undefined ? [] : [rm(this.backup, { recursive: true, force: true })],
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
