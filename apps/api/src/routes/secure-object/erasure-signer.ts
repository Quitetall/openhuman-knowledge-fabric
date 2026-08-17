/**
 * The HTTP client for an external Secure Object Authority's erasure signer.
 *
 * What this does NOT establish is worth stating first, because it explains why the checks
 * below are shaped the way they are. `signErasureTombstone` verifies the returned signature
 * against the canonical bytes KF computed and the public key KF looked up from its own
 * registry. A substituted key or substituted payload fails there, cryptographically, whatever
 * this client believes. Nothing here is load-bearing for that.
 *
 * What this DOES establish is that a misconfigured or misbehaving authority is caught at the
 * boundary, with an error naming the mismatch, rather than surfacing later as an opaque
 * signature failure inside a transaction that has already done work. So the response is
 * required to echo which key it used and which bytes it signed, and the echo is compared
 * against what was asked for.
 *
 * The second rule here is that an external body never reaches the caller. A failing authority
 * returns whatever it likes — an HTML error page, a stack trace, a key. Reflecting any of it
 * into a KF error message would put someone else's incident into this system's logs.
 */

import {
  SecureObjectRejected,
  type SecureObjectSigningRequest,
  type SignedErasureTombstonePayload,
} from '@kf/integration';
import type { SecureObjectSignerConfig } from './config.js';

const REQUEST_VERSION = 'kf-secure-object-erasure-sign-request/v1';
const RESPONSE_VERSION = 'kf-secure-object-erasure-signature/v1';

/**
 * A signature response is four small fields; 32 KiB is already two orders of magnitude of
 * headroom. The cap exists so a authority that streams an error page cannot make this process
 * hold it in memory while deciding it is invalid.
 */
const MAX_RESPONSE_BYTES = 32 * 1024;

const RESPONSE_FIELDS = [
  'version',
  'signing_key_registry_id',
  'canonical_tombstone_base64',
  'signature_base64',
] as const;

const ED25519_SIGNATURE_BYTES = 64;

export type SignerFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Refused without naming what the authority said. */
function transportRejected(detail: string): SecureObjectRejected {
  return new SecureObjectRejected('signing_key_unavailable', `external erasure signer ${detail}`);
}

/**
 * Decode base64 and require the encoding to have been canonical.
 *
 * `Buffer.from(x, 'base64')` is lenient: it accepts missing padding, wrong padding and stray
 * characters, silently producing bytes for input no correct encoder emits. Re-encoding and
 * comparing is what turns "decodes to something" into "is the encoding of these bytes".
 */
function decodeCanonicalBase64(value: unknown, field: string): Buffer {
  if (typeof value !== 'string') {
    throw transportRejected(`returned a non-string ${field}`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw transportRejected(`returned a non-canonical base64 ${field}`);
  }
  return decoded;
}

export class HttpErasureAuthoritySigner {
  readonly #config: SecureObjectSignerConfig;
  readonly #fetch: SignerFetch;

  constructor(config: SecureObjectSignerConfig, fetcher: SignerFetch = globalThis.fetch) {
    this.#config = config;
    this.#fetch = fetcher;
  }

  /**
   * Ask the authority to sign exactly these canonical bytes with exactly this registered key.
   *
   * The request body carries no PHI, no locator and no free text — an organization id, the
   * authority reference, the key registry id, and the canonical tombstone bytes KF built.
   */
  async sign(input: SecureObjectSigningRequest): Promise<SignedErasureTombstonePayload> {
    const canonicalTombstoneBytes = Buffer.from(input.canonicalTombstoneBytes);
    const body = JSON.stringify({
      version: REQUEST_VERSION,
      organization_id: input.organizationId,
      external_authority_ref: input.authorityRef,
      signing_key_registry_id: input.signingKeyRegistryId,
      canonical_tombstone_base64: canonicalTombstoneBytes.toString('base64'),
    });

    // The caller's signal is forwarded rather than replaced: `signWithDeadline` upstream owns
    // the timeout, and a second competing deadline here would make which one fired ambiguous.
    let response: Response;
    try {
      response = await this.#fetch(this.#config.endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body,
        signal: input.signal,
      });
    } catch {
      throw transportRejected('could not be reached');
    }

    if (!response.ok) {
      // The status is named; the body is not. A 502 from someone else's proxy is their
      // incident, and its HTML has no business in this system's error path.
      throw transportRejected(`returned HTTP ${response.status}`);
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw transportRejected('returned an oversized response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw transportRejected('returned a body that is not JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw transportRejected('returned a body that is not a JSON object');
    }

    const fields = parsed as Record<string, unknown>;
    const names = Object.keys(fields).sort();
    // Exact field set, not a superset. An authority that starts returning an extra field is
    // either a version this client does not understand or one leaking something it should not,
    // and both are reasons to stop rather than to ignore the field.
    if (
      names.length !== RESPONSE_FIELDS.length ||
      !RESPONSE_FIELDS.every((field) => names.includes(field))
    ) {
      throw transportRejected('returned an unexpected response shape');
    }
    if (fields['version'] !== RESPONSE_VERSION) {
      throw transportRejected('returned an unsupported response version');
    }

    const signature = decodeCanonicalBase64(fields['signature_base64'], 'signature');
    if (signature.length !== ED25519_SIGNATURE_BYTES) {
      throw transportRejected('returned a signature of the wrong length');
    }

    // The echo. Neither check is what makes the tombstone trustworthy — signErasureTombstone
    // does that against KF's own bytes and KF's own registered key — but a mismatch here means
    // the authority signed something other than what it was asked to, and that is worth
    // stopping on with a message that says so.
    if (fields['signing_key_registry_id'] !== input.signingKeyRegistryId) {
      throw transportRejected('signed with a different key than the one requested');
    }
    const echoed = decodeCanonicalBase64(fields['canonical_tombstone_base64'], 'tombstone');
    if (!echoed.equals(canonicalTombstoneBytes)) {
      throw transportRejected('signed different bytes than the ones requested');
    }

    return {
      version: RESPONSE_VERSION,
      signingKeyRegistryId: input.signingKeyRegistryId,
      canonicalTombstoneBytes,
      signature,
    };
  }
}
