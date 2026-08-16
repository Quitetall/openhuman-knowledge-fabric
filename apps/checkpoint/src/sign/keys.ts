import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

import type { SigningKey } from './contracts.js';
import { checkpointSigningKeyId } from './sequences.js';

export function assertEd25519SigningKey(key: SigningKey): void {
  checkpointSigningKeyId(key.id);
  if (
    key.privateKey.type !== 'private' ||
    key.privateKey.asymmetricKeyType !== 'ed25519' ||
    key.publicKey.type !== 'public' ||
    key.publicKey.asymmetricKeyType !== 'ed25519'
  ) {
    throw new Error('checkpoint signing key pair must be Ed25519');
  }
  const derived = createPublicKey(key.privateKey).export({ format: 'der', type: 'spki' });
  const supplied = key.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(derived) || !Buffer.isBuffer(supplied) || !derived.equals(supplied)) {
    throw new Error('checkpoint signing public key does not match private key');
  }
}

/** Ed25519: small keys, small signatures, no parameter choices to get wrong. */
export function generateSigningKey(id: string): SigningKey {
  checkpointSigningKeyId(id);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { id, privateKey, publicKey };
}

export function loadSigningKey(id: string, privatePem: string): SigningKey {
  checkpointSigningKeyId(id);
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('checkpoint signing key is not an Ed25519 private key');
  }
  return { id, privateKey, publicKey: createPublicKey(privateKey) };
}
