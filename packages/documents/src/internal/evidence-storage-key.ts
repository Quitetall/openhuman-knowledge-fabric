import { ActionRejected } from '@kf/actions';

/**
 * Where `attach_evidence` bytes live, derived by the server from the bound organization and the
 * digest — never taken from the caller.
 *
 * `storage_uri` used to be read from the payload and only checked for "an object exists there
 * with this digest and size". That check is a content test, not an ownership test: a caller who
 * knew another organization's digest and size (both appear in exports, receipts and audit
 * detail) could attach that organization's object as their own evidence and then download it
 * through the source route. `document-imports/<sha256>` made it worse by not being scoped at
 * all, so every organization's imports shared one namespace.
 *
 * Two namespaces, because two writers stage bytes for this action: `ingest/` (the ingest route
 * and CLI) and `document-imports/` (the document import route and the dogfood loader). Both
 * are `<namespace>/<organization>/<sha256>`. The payload may still NAME the key — the writers
 * already know it, and the recorded version carries it — but it is accepted only when it is
 * byte-for-byte one of the keys this function derives for the request's own organization.
 */
export const EVIDENCE_KEY_NAMESPACES = ['ingest', 'document-imports'] as const;
export type EvidenceKeyNamespace = (typeof EVIDENCE_KEY_NAMESPACES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export function evidenceStorageKey(
  namespace: EvidenceKeyNamespace,
  organizationId: string,
  sha256: string,
): string {
  // Both halves are interpolated into a path, so both are checked for shape here rather than
  // trusted: an organization id with a `/` in it would name some other organization's prefix.
  if (!UUID.test(organizationId)) throw new Error('organizationId must be a UUID');
  if (!SHA256.test(sha256)) throw new Error('sha256 must be lowercase hexadecimal');
  return `${namespace}/${organizationId}/${sha256}`;
}

/** The payload's key, if and only if the server would have derived exactly that key. */
export function requireDerivedEvidenceKey(
  claimed: string,
  organizationId: string,
  sha256: string,
): string {
  const derived = EVIDENCE_KEY_NAMESPACES.map((namespace) =>
    evidenceStorageKey(namespace, organizationId, sha256),
  );
  if (!derived.includes(claimed)) {
    throw new ActionRejected(
      'precondition_failed',
      'KF-ART-KEY: storage_uri must be the key the server derives from the bound organization ' +
        'and the digest',
      { rule: 'KF-ART-KEY', expected: derived },
    );
  }
  return claimed;
}
