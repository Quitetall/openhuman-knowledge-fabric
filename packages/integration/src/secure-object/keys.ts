import type { Tx } from '@kf/database';
import {
  type AuthorityKeyRevocationReason,
  type AuthoritySigningKey,
  type RegisterAuthorityKeyInput,
  SecureObjectRejected,
} from './contracts.js';
import { authorityKey, type AuthorityKeyRow } from './rows.js';
import { authoritySigningKeyMaterial } from './action-intents.js';
import { opaqueReference } from './validation.js';

/** Register public Ed25519 verification material for one owning SOA. */
export async function registerAuthoritySigningKey(
  tx: Tx,
  input: RegisterAuthorityKeyInput,
): Promise<AuthoritySigningKey> {
  opaqueReference(input.keyId, 'signing key identifier', 255);
  const material = authoritySigningKeyMaterial(input.publicKey);
  const row = await tx.one<AuthorityKeyRow>(
    `insert into secure_object.authority_signing_key
       (organization_id, external_authority_ref, key_id, algorithm,
        public_key_spki_der_base64, public_key_sha256, rotates_key_registry_id, valid_until)
     values ($1, $2, $3, 'Ed25519', $4, $5, $6, $7)
     returning id, organization_id, external_authority_ref, key_id, algorithm,
               public_key_spki_der_base64, public_key_sha256, rotates_key_registry_id,
               valid_from, valid_until`,
    [
      input.organizationId,
      input.authorityRef,
      input.keyId,
      material.publicKeySpkiDerBase64,
      material.publicKeySha256,
      input.rotatesKeyRegistryId,
      input.validUntil,
    ],
  );
  return authorityKey(row);
}

/** Append a terminal revocation for registered public verification material. */
export async function revokeAuthoritySigningKey(
  tx: Tx,
  input: { readonly key: AuthoritySigningKey; readonly reasonCode: AuthorityKeyRevocationReason },
): Promise<boolean> {
  const row = await tx.maybeOne<{ readonly signing_key_registry_id: string }>(
    `insert into secure_object.authority_signing_key_revocation
       (signing_key_registry_id, reason_code)
     select k.id, $2::secure_object.key_revocation_reason
       from secure_object.authority_signing_key k
      where k.id = $1
        and k.organization_id = $3
        and k.external_authority_ref = $4
        and k.key_id = $5
     on conflict (signing_key_registry_id) do nothing
     returning signing_key_registry_id`,
    [
      input.key.id,
      input.reasonCode,
      input.key.organizationId,
      input.key.authorityRef,
      input.key.keyId,
    ],
  );
  return row !== undefined;
}

export async function loadAuthoritySigningKey(
  tx: Tx,
  keyRegistryId: string,
): Promise<AuthoritySigningKey> {
  const row = await tx.maybeOne<AuthorityKeyRow>(
    `select id, organization_id, external_authority_ref, key_id, algorithm,
            public_key_spki_der_base64, public_key_sha256, rotates_key_registry_id,
            valid_from, valid_until
       from secure_object.authority_signing_key where id = $1`,
    [keyRegistryId],
  );
  if (row === undefined) {
    throw new SecureObjectRejected(
      'signing_key_unavailable',
      'authority signing key is unavailable',
    );
  }
  return authorityKey(row);
}
