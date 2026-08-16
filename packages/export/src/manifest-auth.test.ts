import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import {
  canonicalBytes,
  canonicalize,
  compareCanonicalText,
  digestBytes,
} from '@kf/canonicalization';
import { describe, expect, it, vi } from 'vitest';
import {
  EXPORT_MANIFEST_SIGNATURE_PATH,
  importExport,
  LEGACY_UNSIGNED_EXPORT_WARNING,
  PRESERVATION_IMPORT_TARGETS,
  recomputeDatabaseSnapshotDigest,
  signExportPackage,
  verifyExport,
  type ExportManifest,
  type ExportManifestSignature,
  type ExportPackage,
} from './index.js';

const KEY_ID = 'preservation-2026-08';

function unsignedPackage(formatVersion = '2'): ExportPackage {
  const data = `${canonicalize([{ id: 'record-01', value: 'preserved' }])}\n`;
  if (formatVersion === '2') {
    const sectionFiles = Object.keys(PRESERVATION_IMPORT_TARGETS).map((section) => ({
      path: `${section}.json`,
      content: section === 'objects' ? data : `${canonicalize([])}\n`,
    }));
    const dataFiles = [
      { path: 'ontology/registry.json', content: `${canonicalize({ fixture: true })}\n` },
      ...sectionFiles,
    ].sort((left, right) => compareCanonicalText(left.path, right.path));
    const counts = Object.fromEntries(
      Object.keys(PRESERVATION_IMPORT_TARGETS).map((section) => [
        section,
        section === 'objects' ? 1 : 0,
      ]),
    );
    const manifest: ExportManifest = {
      format_version: formatVersion,
      ontology_version: '2026.08',
      ontology_digest: 'a'.repeat(64),
      schema_version: '2026.08',
      audit_from_seq: null,
      audit_to_seq: null,
      database_snapshot_sha256: recomputeDatabaseSnapshotDigest(dataFiles),
      counts,
      files: dataFiles.map((file) => ({
        path: file.path,
        size_bytes: Buffer.byteLength(file.content),
        sha256: digestBytes(Buffer.from(file.content, 'utf8')),
      })),
    };
    return {
      manifest,
      files: [...dataFiles, { path: 'manifest.json', content: `${canonicalize(manifest)}\n` }],
    };
  }
  const manifest: ExportManifest = {
    format_version: formatVersion,
    ontology_version: '2026.08',
    ontology_digest: 'a'.repeat(64),
    schema_version: '2026.08',
    audit_from_seq: 1,
    audit_to_seq: 1,
    counts: { objects: 1 },
    files: [
      {
        path: 'objects.json',
        size_bytes: Buffer.byteLength(data),
        sha256: digestBytes(Buffer.from(data, 'utf8')),
      },
    ],
  };
  return {
    manifest,
    files: [
      { path: 'objects.json', content: data },
      { path: 'manifest.json', content: `${canonicalize(manifest)}\n` },
    ],
  };
}

function sidecar(pkg: ExportPackage): ExportManifestSignature {
  const file = pkg.files.find((candidate) => candidate.path === EXPORT_MANIFEST_SIGNATURE_PATH);
  if (file === undefined) throw new Error('test package has no signature sidecar');
  return JSON.parse(file.content) as ExportManifestSignature;
}

function replaceFile(pkg: ExportPackage, path: string, content: string): ExportPackage {
  return {
    ...pkg,
    files: pkg.files.map((file) => (file.path === path ? { path, content } : file)),
  };
}

function problems(pkg: ExportPackage, trustedManifestKeys = new Map()) {
  return verifyExport(pkg, { trustedManifestKeys }).map((finding) => finding.problem);
}

describe('authenticated preservation manifests', () => {
  it('signs the exact canonical manifest and verifies a signed package round trip', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkg = signExportPackage(unsignedPackage(), { keyId: KEY_ID, privateKey });
    const signature = sidecar(pkg);
    const canonicalManifest = Buffer.from(canonicalize(pkg.manifest), 'utf8');

    expect(signature).toMatchObject({
      format_version: 'kf-preservation-manifest-signature-v1',
      algorithm: 'Ed25519',
      key_id: KEY_ID,
      manifest_sha256: digestBytes(canonicalManifest),
    });
    expect(signature.signature_base64).toBe(
      edSign(null, canonicalManifest, privateKey).toString('base64'),
    );
    expect(verifyExport(pkg, { trustedManifestKeys: new Map([[KEY_ID, publicKey]]) })).toEqual([]);
  });

  it('rejects content substitution and an attacker-repacked package', () => {
    const trusted = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const original = signExportPackage(unsignedPackage(), {
      keyId: KEY_ID,
      privateKey: trusted.privateKey,
    });
    const substituted = replaceFile(
      original,
      'objects.json',
      `${canonicalize([{ id: 'record-01', value: 'substituted' }])}\n`,
    );
    expect(problems(substituted, new Map([[KEY_ID, trusted.publicKey]]))).toContain(
      'digest_mismatch',
    );

    const attackerUnsigned = unsignedPackage();
    const attackerData = `${canonicalize([{ id: 'record-01', value: 'repacked' }])}\n`;
    const attackerFiles = attackerUnsigned.files.map((file) =>
      file.path === 'objects.json' ? { path: 'objects.json', content: attackerData } : file,
    );
    const attackerManifest: ExportManifest = {
      ...attackerUnsigned.manifest,
      database_snapshot_sha256: recomputeDatabaseSnapshotDigest(attackerFiles),
      files: attackerUnsigned.manifest.files.map((entry) =>
        entry.path === 'objects.json'
          ? {
              path: 'objects.json',
              size_bytes: Buffer.byteLength(attackerData),
              sha256: digestBytes(Buffer.from(attackerData, 'utf8')),
            }
          : entry,
      ),
    };
    const repacked = signExportPackage(
      {
        manifest: attackerManifest,
        files: attackerFiles.map((file) =>
          file.path === 'manifest.json'
            ? { path: 'manifest.json', content: `${canonicalize(attackerManifest)}\n` }
            : file,
        ),
      },
      { keyId: 'attacker-key', privateKey: attacker.privateKey },
    );
    expect(problems(repacked, new Map([[KEY_ID, trusted.publicKey]]))).toContain('untrusted_key');
  });

  it('recomputes the signed database snapshot digest from exact preservation bytes', () => {
    const trusted = generateKeyPairSync('ed25519');
    const unsigned = unsignedPackage();
    expect(unsigned.manifest.database_snapshot_sha256).toBe(
      recomputeDatabaseSnapshotDigest(unsigned.files),
    );

    const staleDigestManifest: ExportManifest = {
      ...unsigned.manifest,
      database_snapshot_sha256: '0'.repeat(64),
    };
    expect(() =>
      signExportPackage(
        {
          manifest: staleDigestManifest,
          files: unsigned.files.map((entry) =>
            entry.path === 'manifest.json'
              ? { ...entry, content: `${canonicalize(staleDigestManifest)}\n` }
              : entry,
          ),
        },
        { keyId: KEY_ID, privateKey: trusted.privateKey },
      ),
    ).toThrow(/database snapshot digest/);
  });

  it('rejects unknown keys, same-id key substitution, and tampered sidecars', () => {
    const trusted = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const pkg = signExportPackage(unsignedPackage(), {
      keyId: KEY_ID,
      privateKey: trusted.privateKey,
    });

    expect(problems(pkg)).toContain('untrusted_key');
    expect(problems(pkg, new Map([[KEY_ID, other.publicKey]]))).toContain('signature_invalid');

    const signature = sidecar(pkg);
    const changedSignature = `${signature.signature_base64.startsWith('A') ? 'B' : 'A'}${signature.signature_base64.slice(1)}`;
    const tampered = replaceFile(
      pkg,
      EXPORT_MANIFEST_SIGNATURE_PATH,
      `${canonicalize({ ...signature, signature_base64: changedSignature })}\n`,
    );
    expect(problems(tampered, new Map([[KEY_ID, trusted.publicKey]]))).toContain(
      'signature_invalid',
    );

    const openSchema = replaceFile(
      pkg,
      EXPORT_MANIFEST_SIGNATURE_PATH,
      `${canonicalize({ ...signature, trust_me: true })}\n`,
    );
    expect(problems(openSchema, new Map([[KEY_ID, trusted.publicKey]]))).toContain(
      'malformed_signature',
    );
  });

  it('keeps historical packages verifiable across rotation while both keys remain trusted', () => {
    const oldKey = generateKeyPairSync('ed25519');
    const newKey = generateKeyPairSync('ed25519');
    const oldPackage = signExportPackage(unsignedPackage(), {
      keyId: 'preservation-2026-01',
      privateKey: oldKey.privateKey,
    });
    const newPackage = signExportPackage(unsignedPackage(), {
      keyId: 'preservation-2026-08',
      privateKey: newKey.privateKey,
    });
    const historicalTrustStore = new Map([
      ['preservation-2026-01', oldKey.publicKey],
      ['preservation-2026-08', newKey.publicKey],
    ]);

    expect(verifyExport(oldPackage, { trustedManifestKeys: historicalTrustStore })).toEqual([]);
    expect(verifyExport(newPackage, { trustedManifestKeys: historicalTrustStore })).toEqual([]);
    expect(problems(oldPackage, new Map([['preservation-2026-08', newKey.publicKey]]))).toContain(
      'untrusted_key',
    );
  });

  it('authenticates archived public trust files without ever embedding a private key', () => {
    const preservationKey = generateKeyPairSync('ed25519');
    const checkpointKey = generateKeyPairSync('ed25519');
    const publicPem = checkpointKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const pkg = signExportPackage(
      unsignedPackage(),
      { keyId: KEY_ID, privateKey: preservationKey.privateKey },
      {
        authenticatedFiles: [
          { path: 'trust/checkpoint/checkpoint-2026-01.pub', content: publicPem },
        ],
      },
    );
    const trusted = new Map([[KEY_ID, preservationKey.publicKey]]);

    expect(verifyExport(pkg, { trustedManifestKeys: trusted })).toEqual([]);
    expect(pkg.manifest.files.map((entry) => entry.path)).toContain(
      'trust/checkpoint/checkpoint-2026-01.pub',
    );
    expect(pkg.files.some((entry) => entry.content.includes('PRIVATE KEY'))).toBe(false);

    const replaced = replaceFile(
      pkg,
      'trust/checkpoint/checkpoint-2026-01.pub',
      generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    expect(problems(replaced, trusted)).toContain('digest_mismatch');

    const privatePem = checkpointKey.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() =>
      signExportPackage(
        unsignedPackage(),
        { keyId: KEY_ID, privateKey: preservationKey.privateKey },
        {
          authenticatedFiles: [
            { path: 'trust/checkpoint/checkpoint-2026-01.pub', content: privatePem },
          ],
        },
      ),
    ).toThrow(/private material/);
  });

  it('rejects a manifest file that does not exactly match the parsed manifest', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pkg = signExportPackage(unsignedPackage(), { keyId: KEY_ID, privateKey });
    const mismatchedObject: ExportPackage = {
      ...pkg,
      manifest: { ...pkg.manifest, schema_version: 'substituted' },
    };
    expect(problems(mismatchedObject, new Map([[KEY_ID, publicKey]]))).toContain(
      'manifest_mismatch',
    );

    const nonCanonicalFile = replaceFile(
      pkg,
      'manifest.json',
      `${JSON.stringify(pkg.manifest, null, 2)}\n`,
    );
    expect(problems(nonCanonicalFile, new Map([[KEY_ID, publicKey]]))).toContain(
      'manifest_mismatch',
    );

    const nullManifest = {
      files: [{ path: 'manifest.json', content: 'null\n' }],
      manifest: null,
    } as unknown as ExportPackage;
    expect(() => verifyExport(nullManifest)).not.toThrow();
    expect(verifyExport(nullManifest).map((finding) => finding.problem)).toContain(
      'manifest_mismatch',
    );
  });

  it('allows unsigned format v1 only behind an explicit warning-producing opt-in', () => {
    const legacy = unsignedPackage('1');
    expect(problems(legacy)).toContain('unsigned_legacy');

    const onWarning = vi.fn();
    expect(
      verifyExport(legacy, {
        trustedManifestKeys: new Map(),
        allowUnsignedLegacyV1: true,
        onWarning,
      }),
    ).toEqual([]);
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning).toHaveBeenCalledWith(LEGACY_UNSIGNED_EXPORT_WARNING);
    expect(
      verifyExport(legacy, { allowUnsignedLegacyV1: true } as never).map(
        (finding) => finding.problem,
      ),
    ).toContain('unsigned_legacy');

    const unsignedV2 = unsignedPackage();
    expect(
      verifyExport(unsignedV2, {
        trustedManifestKeys: new Map(),
        allowUnsignedLegacyV1: true,
        onWarning,
      }).map((finding) => finding.problem),
    ).toContain('missing_signature');
  });

  it('refuses unsigned and untrusted v2 before import performs any database write', async () => {
    const tx = { query: vi.fn() } as never;
    await expect(importExport(tx, unsignedPackage())).rejects.toThrow(/missing_signature/);

    const { privateKey } = generateKeyPairSync('ed25519');
    const signed = signExportPackage(unsignedPackage(), { keyId: KEY_ID, privateKey });
    await expect(importExport(tx, signed, { trustedManifestKeys: new Map() })).rejects.toThrow(
      /untrusted_key/,
    );

    const trusted = generateKeyPairSync('ed25519');
    const complete = signExportPackage(unsignedPackage(), {
      keyId: KEY_ID,
      privateKey: trusted.privateKey,
    });
    const { roles: _removedRoleCount, ...incompleteCounts } = complete.manifest.counts;
    const incompleteManifest: ExportManifest = {
      ...complete.manifest,
      counts: incompleteCounts,
      files: complete.manifest.files.filter((entry) => entry.path !== 'roles.json'),
    };
    const incompleteManifestBytes = canonicalBytes(incompleteManifest);
    const incompleteSignature: ExportManifestSignature = {
      format_version: 'kf-preservation-manifest-signature-v1',
      algorithm: 'Ed25519',
      key_id: KEY_ID,
      manifest_sha256: digestBytes(incompleteManifestBytes),
      signature_base64: edSign(null, incompleteManifestBytes, trusted.privateKey).toString(
        'base64',
      ),
    };
    const incomplete: ExportPackage = {
      manifest: incompleteManifest,
      files: [
        ...complete.files.filter(
          (file) =>
            file.path !== 'roles.json' &&
            file.path !== 'manifest.json' &&
            file.path !== EXPORT_MANIFEST_SIGNATURE_PATH,
        ),
        { path: 'manifest.json', content: `${canonicalize(incompleteManifest)}\n` },
        {
          path: EXPORT_MANIFEST_SIGNATURE_PATH,
          content: `${canonicalize(incompleteSignature)}\n`,
        },
      ],
    };
    await expect(
      importExport(tx, incomplete, {
        trustedManifestKeys: new Map([[KEY_ID, trusted.publicKey]]),
      }),
    ).rejects.toThrow(/roles\.json manifest_mismatch/);
    expect((tx as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
  });
});
