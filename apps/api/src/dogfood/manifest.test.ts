import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemoryObjectStore, digestOf, type StoredObject } from '@kf/artifacts';
import { describe, expect, it } from 'vitest';
import { stageDocumentConstitution } from './manifest.js';

class CountingStore extends InMemoryObjectStore {
  putCount = 0;

  override async put(key: string, body: Buffer, mediaType: string): Promise<StoredObject> {
    this.putCount += 1;
    return super.put(key, body, mediaType);
  }
}

class UnversionedStore extends CountingStore {
  override async head(key: string): Promise<StoredObject | undefined> {
    const stored = await super.head(key);
    return stored === undefined ? undefined : { ...stored, versionId: undefined };
  }
}

describe('dogfood content-addressed staging', () => {
  it('does not create new object-store versions when unchanged bytes already verify', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kf-dogfood-stage-'));
    try {
      const manifestPath = join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        'dogfood',
        'document-constitution.json',
      );
      const entries = JSON.parse(await readFile(manifestPath, 'utf8')) as Array<{ file: string }>;
      for (const entry of entries) {
        const path = join(directory, entry.file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(`${entry.file}\n`));
      }
      const store = new CountingStore();

      await stageDocumentConstitution(directory, store);
      const firstPutCount = store.putCount;
      await stageDocumentConstitution(directory, store);

      expect(firstPutCount).toBe(entries.length + 1);
      expect(store.putCount).toBe(firstPutCount);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses an occupied content-addressed key whose bytes do not match', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kf-dogfood-stage-'));
    try {
      const manifestPath = join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        'dogfood',
        'document-constitution.json',
      );
      const entries = JSON.parse(await readFile(manifestPath, 'utf8')) as Array<{ file: string }>;
      for (const entry of entries) {
        const path = join(directory, entry.file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(`${entry.file}\n`));
      }
      const firstBytes = Buffer.from(`${entries[0]!.file}\n`);
      const occupiedKey = `document-imports/${digestOf(firstBytes)}`;
      const store = new CountingStore();
      await store.put(
        occupiedKey,
        Buffer.alloc(firstBytes.length, 0x78),
        'application/octet-stream',
      );

      await expect(stageDocumentConstitution(directory, store)).rejects.toMatchObject({
        failure: 'digest_mismatch',
      });
      expect(store.putCount).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses storage without immutable version identifiers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kf-dogfood-stage-'));
    try {
      const manifestPath = join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        '..',
        'dogfood',
        'document-constitution.json',
      );
      const entries = JSON.parse(await readFile(manifestPath, 'utf8')) as Array<{ file: string }>;
      for (const entry of entries) {
        const path = join(directory, entry.file);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(`${entry.file}\n`));
      }

      await expect(
        stageDocumentConstitution(directory, new UnversionedStore()),
      ).rejects.toMatchObject({ failure: 'unversioned_storage' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
