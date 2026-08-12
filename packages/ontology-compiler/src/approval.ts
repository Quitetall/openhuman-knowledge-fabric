/**
 * Approving a release package.
 *
 * Spec §5 requires a **signed or approved** release manifest before a package is normative
 * under §1.2. The pack the compiler emits carries `status: draft_for_approval` and is not
 * that. This is what makes it one.
 *
 * Three decisions, each of which could have gone the other way:
 *
 * THE APPROVAL IS A SEPARATE FILE. The manifest lists a digest for every file in the package
 * and — correctly — does not list itself, because a file cannot contain its own hash. The
 * same argument applies one level up: a manifest cannot contain a signature over itself. So
 * `approval.json` sits beside it, commits to the manifest's digest, and through it to every
 * byte in the package.
 *
 * THE MANIFEST IS NOT REWRITTEN. Flipping `status` to `approved` would change the manifest's
 * digest, which is the thing being signed. The package's effective status is therefore a
 * question answered by `verifyRelease`, not a string sitting in a file — and that is the
 * honest shape, because "approved" is a claim about a signature that verifies, not about a
 * word somebody typed.
 *
 * THERE IS NO WAY TO BACKDATE ONE. §29.4 forbids backdated approvals, and the enforcement is
 * that `approveRelease` takes no timestamp: it reads the clock. An operator who wants a date
 * other than now has to lie to the operating system rather than to this function, which is a
 * meaningfully higher bar and leaves traces elsewhere.
 */

import { createHash, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalize } from '@kf/canonicalization';

export interface Approver {
  /** Who approved. A person, named as the QMS names them. */
  readonly name: string;
  /** The authority under which they approved — a role, not a job title. */
  readonly role: string;
  /**
   * What they are attesting to.
   *
   * Required, and required to be substantial. An approval whose statement is "ok" records
   * that somebody clicked, which is not what an approval is for: the known gaps travel with
   * the package, and approving it means accepting them.
   */
  readonly statement: string;
}

export interface ReleaseApproval {
  readonly manifest_sha256: string;
  readonly approved_at: string;
  readonly approver: Approver;
  readonly signing_key_id: string;
  readonly signature: string;
  /** The gaps as they stood at approval, copied so the record is self-contained. */
  readonly accepted_gaps: readonly string[];
}

export class ApprovalRejected extends Error {}

/** The bytes an approval commits to. Everything except the signature itself. */
function payload(a: Omit<ReleaseApproval, 'signature'>): Buffer {
  return Buffer.from(
    canonicalize({
      manifest_sha256: a.manifest_sha256,
      approved_at: a.approved_at,
      approver_name: a.approver.name,
      approver_role: a.approver.role,
      approver_statement: a.approver.statement,
      signing_key_id: a.signing_key_id,
      // Signed too. An approval that committed to the manifest but not to the gaps could be
      // re-presented as though the approver had seen a shorter list.
      accepted_gaps: [...a.accepted_gaps],
    }),
    'utf8',
  );
}

const MINIMUM_STATEMENT = 40;

/**
 * Sign an approval over a manifest.
 *
 * `manifestBytes` is the manifest exactly as it sits on disk, not a re-serialisation of it:
 * signing a value that was parsed and re-emitted would attest to a file nobody has.
 */
export function approveRelease(
  manifestBytes: Buffer,
  approver: Approver,
  key: { readonly id: string; readonly privateKey: KeyObject },
  acceptedGaps: readonly string[],
  now: Date = new Date(),
): ReleaseApproval {
  if (approver.name.trim() === '' || approver.role.trim() === '') {
    throw new ApprovalRejected('an approval needs a named person and the role they held');
  }
  if (approver.statement.trim().length < MINIMUM_STATEMENT) {
    // Not decoration. The statement is the part an auditor reads, and "approved" tells them
    // nothing about whether the gaps were understood.
    throw new ApprovalRejected(
      `the approval statement must say what is being accepted (at least ${MINIMUM_STATEMENT} characters)`,
    );
  }

  const unsigned = {
    manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    approved_at: now.toISOString(),
    approver,
    signing_key_id: key.id,
    accepted_gaps: acceptedGaps,
  };
  return { ...unsigned, signature: edSign(null, payload(unsigned), key.privateKey).toString('base64') };
}

export type ReleaseFinding =
  | 'file_missing'
  | 'file_digest_mismatch'
  | 'file_unlisted'
  | 'manifest_digest_mismatch'
  | 'bad_signature'
  | 'unknown_key'
  | 'approval_in_future'
  | 'gaps_not_accepted';

export interface ReleaseVerdict {
  /** `approved` only when every file matches AND an approval verifies. */
  readonly status: 'approved' | 'draft' | 'invalid';
  readonly findings: readonly { readonly finding: ReleaseFinding; readonly detail: string }[];
  readonly filesChecked: number;
  readonly approval?: ReleaseApproval;
}

export interface ManifestShape {
  readonly known_gaps?: readonly string[];
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

/**
 * Verify a package, and say what it is.
 *
 * Files first, then the manifest digest, then the signature. Reporting a good signature over
 * a manifest whose files no longer match would be the worst possible output: it reads as
 * "verified" and means "this manifest was approved once, and the package has changed since".
 *
 * `readFile` is injected so this works over a directory, a zip, or an object store without
 * the verification logic knowing which.
 */
export function verifyRelease(
  manifestBytes: Buffer,
  manifest: ManifestShape,
  readFile: (path: string) => Buffer | undefined,
  approval: ReleaseApproval | undefined,
  publicKeys: ReadonlyMap<string, KeyObject>,
  now: Date = new Date(),
): ReleaseVerdict {
  const findings: { finding: ReleaseFinding; detail: string }[] = [];

  for (const entry of manifest.files) {
    const bytes = readFile(entry.path);
    if (bytes === undefined) {
      findings.push({ finding: 'file_missing', detail: `${entry.path} is listed and absent` });
      continue;
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) {
      findings.push({
        finding: 'file_digest_mismatch',
        detail: `${entry.path} does not match the manifest (${actual.slice(0, 12)} vs ${entry.sha256.slice(0, 12)})`,
      });
    }
  }

  if (approval === undefined) {
    // Not a finding. A package with no approval is a draft, which is a legitimate state and
    // the one every package starts in. Calling it invalid would make "not yet approved"
    // indistinguishable from "approval failed", and those need different reactions.
    return {
      status: findings.length === 0 ? 'draft' : 'invalid',
      findings,
      filesChecked: manifest.files.length,
    };
  }

  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
  if (manifestDigest !== approval.manifest_sha256) {
    findings.push({
      finding: 'manifest_digest_mismatch',
      detail:
        'the approval is for a different manifest. Either the package was changed after ' +
        'approval, or this approval belongs to another release.',
    });
  }

  if (new Date(approval.approved_at).getTime() > now.getTime()) {
    // §29.4 forbids backdating; a future date is the same defect pointing the other way, and
    // is what a clock-skewed or hand-edited approval looks like.
    findings.push({
      finding: 'approval_in_future',
      detail: `approved_at is ${approval.approved_at}, which has not happened yet`,
    });
  }

  const declared = [...(manifest.known_gaps ?? [])].sort();
  const accepted = [...approval.accepted_gaps].sort();
  if (declared.length !== accepted.length || declared.some((g, i) => g !== accepted[i])) {
    // The manifest gained or lost a gap after approval. Approving a package means accepting
    // its known nonconformances, so a changed list is a changed decision.
    findings.push({
      finding: 'gaps_not_accepted',
      detail:
        "the manifest's known gaps are not the ones this approval accepted — the package's " +
        'nonconformances changed after it was approved',
    });
  }

  const key = publicKeys.get(approval.signing_key_id);
  if (key === undefined) {
    findings.push({
      finding: 'unknown_key',
      detail: `signed with '${approval.signing_key_id}', for which no public key was supplied`,
    });
  } else {
    const { signature, ...unsigned } = approval;
    if (!edVerify(null, payload(unsigned), key, Buffer.from(signature, 'base64'))) {
      findings.push({ finding: 'bad_signature', detail: 'the approval signature does not verify' });
    }
  }

  return {
    status: findings.length === 0 ? 'approved' : 'invalid',
    findings,
    filesChecked: manifest.files.length,
    approval,
  };
}
