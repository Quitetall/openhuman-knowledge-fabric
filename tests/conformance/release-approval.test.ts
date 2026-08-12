/**
 * Approving a release package.
 *
 * Spec §5 requires a signed or approved manifest before a package is normative under §1.2.
 * These tests are about the ways an approval could appear to hold and not: over a package
 * that has since changed, over a different manifest, with a key nobody published, or with a
 * date that has not happened yet.
 *
 * The property that matters most is the boring one — a signature that verifies over a
 * manifest whose files no longer match must NOT read as approved. That output is worse than
 * a failure, because it says "verified" and means "this was approved once".
 */

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  approveRelease,
  verifyRelease,
  ApprovalRejected,
  type ReleaseApproval,
} from '../../packages/ontology-compiler/src/approval.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const KEY = { id: 'release-1', privateKey };
const KEYS = new Map<string, KeyObject>([['release-1', publicKey]]);

const STATEMENT =
  'Approved as the normative successor to R01; the three known gaps are accepted as stated.';

const APPROVER = { name: 'A Person', role: 'Technical Authority', statement: STATEMENT };

const FILES: Record<string, Buffer> = {
  'knowledge-fabric.schema.json': Buffer.from('{"$id":"schema"}'),
  'validate_graph.py': Buffer.from('print("ok")\n'),
};

const GAPS = ['validate_graph.py implements 4 of 10 invariants', 'relation types are untyped'];

function manifestFor(files: Record<string, Buffer>, gaps: readonly string[] = GAPS) {
  const manifest = {
    schema_version: '1.0.0-draft.2',
    known_gaps: [...gaps],
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
  return { manifest, bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
}

const reader = (files: Record<string, Buffer>) => (path: string) => files[path];

describe('a package nobody has approved', () => {
  it('is a draft, not a failure', () => {
    // Every package starts here, and it is a legitimate state. Reporting it as invalid would
    // make "not yet approved" indistinguishable from "approval failed", and those call for
    // very different reactions.
    const { manifest, bytes } = manifestFor(FILES);
    const v = verifyRelease(bytes, manifest, reader(FILES), undefined, KEYS);
    expect(v.status).toBe('draft');
    expect(v.findings).toEqual([]);
    expect(v.filesChecked).toBe(2);
  });

  it('is invalid when its own files do not match, approval or not', () => {
    const changed = { ...FILES, 'validate_graph.py': Buffer.from('print("altered")\n') };
    const { manifest, bytes } = manifestFor(FILES);
    const v = verifyRelease(bytes, manifest, reader(changed), undefined, KEYS);
    expect(v.status).toBe('invalid');
    expect(v.findings[0]?.finding).toBe('file_digest_mismatch');
  });

  it('reports a listed file that is not there', () => {
    const { manifest, bytes } = manifestFor(FILES);
    const v = verifyRelease(bytes, manifest, () => undefined, undefined, KEYS);
    expect(v.findings.map((f) => f.finding)).toEqual(['file_missing', 'file_missing']);
  });
});

describe('an approval that holds', () => {
  it('makes the package approved without rewriting the manifest', () => {
    const { manifest, bytes } = manifestFor(FILES);
    const approval = approveRelease(bytes, APPROVER, KEY, GAPS);
    const v = verifyRelease(bytes, manifest, reader(FILES), approval, KEYS);

    expect(v.status).toBe('approved');
    expect(v.findings).toEqual([]);
    // The manifest still says draft_for_approval, and that is correct: its digest is the
    // thing that was signed. "Approved" is a claim about a signature that verifies, not about
    // a word in a file.
    expect(JSON.parse(bytes.toString('utf8')).status).toBeUndefined();
    expect(v.approval?.approver.name).toBe('A Person');
  });

  it('records who, under what authority, and what they accepted', () => {
    const { bytes } = manifestFor(FILES);
    const approval = approveRelease(bytes, APPROVER, KEY, GAPS);
    expect(approval.approver.role).toBe('Technical Authority');
    // The gaps travel with the approval, so the record is self-contained: reading it later
    // does not require finding the manifest it was made against.
    expect(approval.accepted_gaps).toEqual(GAPS);
  });
});

describe('an approval that does not', () => {
  it('does NOT read as approved once a file has changed underneath it', () => {
    // The worst possible output. The signature is genuine, the manifest is untouched, and the
    // package is not what was approved.
    const { manifest, bytes } = manifestFor(FILES);
    const approval = approveRelease(bytes, APPROVER, KEY, GAPS);
    const changed = { ...FILES, 'validate_graph.py': Buffer.from('print("altered")\n') };

    const v = verifyRelease(bytes, manifest, reader(changed), approval, KEYS);
    expect(v.status).toBe('invalid');
    expect(v.findings.map((f) => f.finding)).toContain('file_digest_mismatch');
  });

  it('refuses an approval made against a different manifest', () => {
    const a = manifestFor(FILES);
    const b = manifestFor({ ...FILES, extra: Buffer.from('x') });
    const approval = approveRelease(a.bytes, APPROVER, KEY, GAPS);
    const v = verifyRelease(b.bytes, b.manifest, reader({ ...FILES, extra: Buffer.from('x') }), approval, KEYS);
    expect(v.findings.map((f) => f.finding)).toContain('manifest_digest_mismatch');
  });

  it('refuses a tampered statement, name or role', () => {
    const { manifest, bytes } = manifestFor(FILES);
    const approval = approveRelease(bytes, APPROVER, KEY, GAPS);
    for (const forged of [
      { ...approval, approver: { ...approval.approver, name: 'Someone Else' } },
      { ...approval, approver: { ...approval.approver, role: 'Administrator' } },
      { ...approval, approver: { ...approval.approver, statement: 'Approved without conditions.' } },
    ] satisfies ReleaseApproval[]) {
      const v = verifyRelease(bytes, manifest, reader(FILES), forged, KEYS);
      expect(v.findings.map((f) => f.finding)).toContain('bad_signature');
    }
  });

  it('refuses when the gaps changed after approval', () => {
    // Approving a package means accepting its known nonconformances. A manifest that quietly
    // gained one afterwards is asking the approver to have agreed to something they did not
    // see; one that lost a gap is asking them to look more thorough than they were.
    const original = manifestFor(FILES, GAPS);
    const approval = approveRelease(original.bytes, APPROVER, KEY, GAPS);
    const fewer = manifestFor(FILES, [GAPS[0]!]);

    const v = verifyRelease(original.bytes, fewer.manifest, reader(FILES), approval, KEYS);
    expect(v.findings.map((f) => f.finding)).toContain('gaps_not_accepted');
  });

  it('refuses a key nobody supplied, rather than trusting the id', () => {
    const { manifest, bytes } = manifestFor(FILES);
    const approval = approveRelease(bytes, APPROVER, { id: 'somebody-elses', privateKey }, GAPS);
    const v = verifyRelease(bytes, manifest, reader(FILES), approval, KEYS);
    expect(v.findings.map((f) => f.finding)).toEqual(['unknown_key']);
    expect(v.status).toBe('invalid');
  });

  it('refuses a signature from the wrong key', () => {
    const other = generateKeyPairSync('ed25519');
    const { manifest, bytes } = manifestFor(FILES);
    const approval = approveRelease(bytes, APPROVER, { id: 'release-1', privateKey: other.privateKey }, GAPS);
    const v = verifyRelease(bytes, manifest, reader(FILES), approval, KEYS);
    expect(v.findings.map((f) => f.finding)).toEqual(['bad_signature']);
  });

  it('refuses an approval dated in the future', () => {
    // §29.4 forbids backdating. A future date is the same defect pointing the other way, and
    // is what a hand-edited or clock-skewed approval looks like.
    const { manifest, bytes } = manifestFor(FILES);
    const approval = approveRelease(bytes, APPROVER, KEY, GAPS, new Date('2027-01-01T00:00:00Z'));
    const v = verifyRelease(bytes, manifest, reader(FILES), approval, KEYS, new Date('2026-08-11T00:00:00Z'));
    expect(v.findings.map((f) => f.finding)).toContain('approval_in_future');
  });
});

describe('what approveRelease will not sign', () => {
  it('refuses an approval with nobody named', () => {
    const { bytes } = manifestFor(FILES);
    expect(() => approveRelease(bytes, { ...APPROVER, name: '  ' }, KEY, GAPS)).toThrow(
      ApprovalRejected,
    );
    expect(() => approveRelease(bytes, { ...APPROVER, role: '' }, KEY, GAPS)).toThrow(
      ApprovalRejected,
    );
  });

  it('refuses a statement that says nothing', () => {
    // The statement is the part an auditor reads. "approved" records that somebody clicked,
    // which is not what an approval is for when known gaps travel with the package.
    const { bytes } = manifestFor(FILES);
    expect(() => approveRelease(bytes, { ...APPROVER, statement: 'approved' }, KEY, GAPS)).toThrow(
      /what is being accepted/,
    );
  });

  it('takes no timestamp from the caller in normal use', () => {
    // The `now` parameter exists for these tests and has no CLI flag behind it. §29.4 forbids
    // backdated approvals, and the enforcement is that an operator who wants another date has
    // to lie to the operating system instead of to this function.
    const { bytes } = manifestFor(FILES);
    const before = Date.now();
    const approval = approveRelease(bytes, APPROVER, KEY, GAPS);
    const at = new Date(approval.approved_at).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
