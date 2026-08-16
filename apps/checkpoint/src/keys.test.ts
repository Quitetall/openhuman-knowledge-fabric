import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadVerificationKeyDirectory } from './keys.js';

function publicPem(kind: 'ed25519' | 'rsa' = 'ed25519'): string {
  // Branched rather than parameterised. `generateKeyPairSync` is overloaded per algorithm,
  // each with its own options type, so a union-typed first argument matches no overload —
  // and the `{}` fallback was being offered to every non-RSA algorithm as though options
  // were interchangeable between them.
  const { publicKey } =
    kind === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'pem', type: 'spki' }) as string;
}

describe('checkpoint public-key history', () => {
  it('loads every permanent key by signing id', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kf-checkpoint-keys-'));
    writeFileSync(join(directory, 'checkpoint-1.pub'), publicPem());
    writeFileSync(join(directory, 'checkpoint-2.pub'), publicPem());
    writeFileSync(join(directory, 'README'), 'not a key');

    expect([...loadVerificationKeyDirectory(directory).keys()]).toEqual([
      'checkpoint-1',
      'checkpoint-2',
    ]);
  });

  it('refuses empty directories, non-Ed25519 keys, and symlinked trust entries', () => {
    const empty = mkdtempSync(join(tmpdir(), 'kf-checkpoint-empty-'));
    expect(() => loadVerificationKeyDirectory(empty)).toThrow('contains no *.pub keys');

    const wrongType = mkdtempSync(join(tmpdir(), 'kf-checkpoint-rsa-'));
    writeFileSync(join(wrongType, 'rsa.pub'), publicPem('rsa'));
    expect(() => loadVerificationKeyDirectory(wrongType)).toThrow('is not an Ed25519 public key');

    const linked = mkdtempSync(join(tmpdir(), 'kf-checkpoint-link-'));
    const target = join(linked, 'target');
    writeFileSync(target, publicPem());
    symlinkSync(target, join(linked, 'linked.pub'));
    expect(() => loadVerificationKeyDirectory(linked)).toThrow('must be a regular file');

    mkdirSync(join(linked, 'directory.pub'));
  });

  it('rejects a public key whose PEM body is valid but not canonical base64', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kf-checkpoint-noncanonical-'));
    const pem = publicPem();
    const [header, body, footer] = pem.trimEnd().split('\n');
    const folded = `${header}\n${body!.slice(0, 20)}\n${body!.slice(20)}\n${footer}\n`;
    writeFileSync(join(directory, 'checkpoint-1.pub'), folded);

    expect(() => loadVerificationKeyDirectory(directory)).toThrow(/canonical base64/);
  });

  it('rejects nonzero trailing bits even when they decode to the same public-key bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kf-checkpoint-trailing-bits-'));
    const pem = publicPem();
    const [header, body, footer] = pem.trimEnd().split('\n');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const trailingIndex = alphabet.indexOf(body![58]!);
    const noncanonicalBody = `${body!.slice(0, 58)}${alphabet[trailingIndex + 1]}=`;
    expect(Buffer.from(noncanonicalBody, 'base64')).toEqual(Buffer.from(body!, 'base64'));
    writeFileSync(
      join(directory, 'checkpoint-1.pub'),
      `${header}\n${noncanonicalBody}\n${footer}\n`,
    );

    expect(() => loadVerificationKeyDirectory(directory)).toThrow(/canonical base64/);
  });
});
