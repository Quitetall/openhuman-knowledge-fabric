/**
 * Wiring the secure-object action atoms for this process.
 *
 * One decision, made here rather than deeper: whether an external Secure Object Authority
 * signer exists. With none, `recordErasure` refuses with `signing_key_unavailable` — the
 * fail-closed posture a deployment that has not qualified an authority should have, and it
 * comes from the atoms themselves rather than from anything added here.
 */

import {
  createSecureObjectActionAtoms,
  type SecureObjectActionAtoms,
  type SecureObjectAuthoritySigner,
} from '@kf/integration';
import { HttpErasureAuthoritySigner, type SignerFetch } from './erasure-signer.js';
import type { SecureObjectSignerConfig } from './config.js';

/**
 * Adapt the HTTP client to the signer interface the atoms expect.
 *
 * The client returns the decoded response — key id, echoed bytes, signature — because it
 * checks the echo. The atoms want the signature alone, because that is all
 * `signErasureTombstone` needs to verify against the bytes and key it already holds. Dropping
 * the rest here is not information loss: it has done its work by this point.
 */
function authoritySigner(
  config: SecureObjectSignerConfig,
  fetcher?: SignerFetch,
): SecureObjectAuthoritySigner {
  const client =
    fetcher === undefined
      ? new HttpErasureAuthoritySigner(config)
      : new HttpErasureAuthoritySigner(config, fetcher);
  return { sign: async (input) => (await client.sign(input)).signature };
}

export function createSecureObjectRuntimeAtoms(
  config: SecureObjectSignerConfig | undefined,
  fetcher?: SignerFetch,
): SecureObjectActionAtoms {
  if (config === undefined) {
    return createSecureObjectActionAtoms();
  }
  return createSecureObjectActionAtoms({
    authoritySigner: authoritySigner(config, fetcher),
    authoritySignerTimeoutMs: config.timeoutMs,
  });
}
