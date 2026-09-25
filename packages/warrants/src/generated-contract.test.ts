import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('./generated/openwarrant/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8')) as {
  artifacts: Record<string, string>;
  runtime_validation_required: boolean;
};

describe('pinned OpenWarrant declarations', () => {
  it('retains exactly the declared artifacts and bytes', () => {
    expect(
      readdirSync(root)
        .filter((name) => name.endsWith('.ts'))
        .sort(),
    ).toEqual(Object.keys(manifest.artifacts).sort());
    for (const [name, digest] of Object.entries(manifest.artifacts)) {
      expect(
        createHash('sha256')
          .update(readFileSync(new URL(name, root)))
          .digest('hex'),
      ).toBe(digest);
    }
    expect(manifest.runtime_validation_required).toBe(true);
  });
});
