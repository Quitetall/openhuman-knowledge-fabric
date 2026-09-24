import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { requiredOrganizationLegalName } from './config.js';

/**
 * KF-SAS-RQ-192: the deploying organization's identity is configuration, and is not compiled into
 * the product's source. SAS §100.16 recorded where it was: three literals in the dogfood
 * bootstrap. This scans every source file the product ships from — apps, packages, scripts,
 * deploy — for the copyright holder's legal name, read from NOTICE so the scan follows the name
 * rather than a second copy of it. Tests are exempt: a fixture may name anyone.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const SCANNED = ['apps', 'packages', 'scripts', 'deploy'];
const TEST_FILE = /(^|\/)(tests?|__tests__|__fixtures__)\/|\.test\.[cm]?[jt]sx?$/;

function legalNameStem(): string {
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8');
  const holder = /^Copyright\s+\d{4}(?:-\d{4})?\s+(.+?)\s*$/m.exec(notice)?.[1];
  if (holder === undefined) throw new Error('NOTICE names no copyright holder');
  // "Acme Widgets LLC" -> "Acme Widgets": the name without its corporate form is still the name.
  return holder.replace(/[,\s]+(LLC|L\.L\.C\.|Inc\.?|Ltd\.?|GmbH|Corp\.?)$/i, '');
}

function productSourceFiles(): string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCANNED],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return listed.split('\0').filter((path) => path !== '' && !TEST_FILE.test(path));
}

function filesNaming(stem: string, files: readonly string[]): string[] {
  const needle = stem.toLowerCase();
  return files.filter((path) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(ROOT, path));
    } catch {
      return false; // listed but deleted in the working tree
    }
    if (bytes.includes(0)) return false; // binary
    return bytes.toString('utf8').toLowerCase().includes(needle);
  });
}

describe('the deploying organization is configuration (KF-SAS-RQ-192, SAS §100.16)', () => {
  it('no product source file names the legal name', () => {
    const stem = legalNameStem();
    expect(stem.length).toBeGreaterThan(5);
    const files = productSourceFiles();
    // A scan that reads nothing passes everything: prove it read the bootstrap it guards.
    expect(files).toContain('apps/api/src/dogfood/bootstrap.ts');
    expect(files.length).toBeGreaterThan(200);
    expect(filesNaming(stem, files)).toEqual([]);
  });

  it('the scan detects a planted literal', () => {
    // The same matcher over a file that is known to hold the name (NOTICE) must find it, so a
    // green scan is the absence of the name and not a broken matcher.
    expect(filesNaming(legalNameStem(), ['NOTICE'])).toEqual(['NOTICE']);
  });
});

describe('requiredOrganizationLegalName', () => {
  it('is required, with no default', () => {
    expect(() => requiredOrganizationLegalName({})).toThrow(/KF_ORGANIZATION_LEGAL_NAME/);
    expect(() => requiredOrganizationLegalName({ KF_ORGANIZATION_LEGAL_NAME: '  ' })).toThrow(
      /required/,
    );
  });

  it('returns the configured name, trimmed', () => {
    expect(
      requiredOrganizationLegalName({ KF_ORGANIZATION_LEGAL_NAME: ' Example Organization LLC\n' }),
    ).toBe('Example Organization LLC');
  });

  it('refuses control characters and absurd lengths', () => {
    expect(() =>
      requiredOrganizationLegalName({ KF_ORGANIZATION_LEGAL_NAME: 'Acme\u0007 LLC' }),
    ).toThrow(/control character/);
    expect(() =>
      requiredOrganizationLegalName({ KF_ORGANIZATION_LEGAL_NAME: 'x'.repeat(201) }),
    ).toThrow(/longer than 200/);
  });
});
