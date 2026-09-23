import type { KeyObject } from 'node:crypto';
import { loadSecret } from '@kf/operations';
import { loadVerificationKeyDirectory } from './keys.js';
import { checkpointSigningKeyId, type SigningKey } from './sign.js';

/**
 * What the checkpoint signer needs to know before it signs, and what it refuses without.
 *
 * Separated from `main.ts` so each refusal can be tested without a database: these are the
 * decisions that make a checkpoint mean something, and they used to be silent defaults.
 */

type Env = NodeJS.ProcessEnv;

export function isProduction(env: Env): boolean {
  return env['NODE_ENV'] === 'production';
}

/**
 * The id a checkpoint is signed under, and the name its public key is looked up by.
 *
 * Production has no default. It used to be `checkpoint-1` everywhere, and the shipped unit
 * never set it — so a rotated key signed under the SAME id as the key it replaced, and every
 * checkpoint signed by the old key became `bad_signature` against the new public key with
 * nothing to say which key had been meant. Development keeps the default so a workstation
 * needs no configuration to try the signer.
 */
export function signingKeyId(env: Env): string {
  const configured = env['CHECKPOINT_SIGNING_KEY_ID'];
  if (configured === undefined || configured === '') {
    if (isProduction(env)) {
      throw new Error(
        'CHECKPOINT_SIGNING_KEY_ID must be set in production. It names the key every ' +
          'checkpoint is signed under; a default shared across keys makes a rotation ' +
          'indistinguishable from tampering.',
      );
    }
    return 'checkpoint-1';
  }
  return checkpointSigningKeyId(configured);
}

function spki(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(der)) throw new Error('public key did not export as DER');
  return der;
}

/**
 * Refuse to sign with a key the verifiers do not already trust under its id.
 *
 * A checkpoint is worth exactly as much as somebody's ability to verify it later. Signing with
 * a key whose `<id>.pub` is absent from the trust directory produces checkpoints that verify
 * as `unknown_key` forever; signing with one whose `.pub` is a DIFFERENT key produces
 * `bad_signature`, which is indistinguishable from forgery. Both were possible: nothing
 * compared the private key to the published public key until verification, months later.
 *
 * Production requires the trust directory. Elsewhere it is checked when configured.
 */
export function assertSigningKeyTrusted(key: SigningKey, env: Env): void {
  const directory = env['CHECKPOINT_PUBLIC_KEY_DIR'];
  if (directory === undefined || directory === '') {
    if (isProduction(env)) {
      throw new Error(
        'CHECKPOINT_PUBLIC_KEY_DIR must be set in production, so --run can prove the signing ' +
          'key is the one verifiers trust before it signs anything.',
      );
    }
    return;
  }
  const trusted = loadVerificationKeyDirectory(directory).get(key.id);
  if (trusted === undefined) {
    throw new Error(
      `refusing to sign: ${key.id}.pub is not in ${directory}. Publish the public key first; ` +
        'a checkpoint no verifier can check is not evidence.',
    );
  }
  if (!spki(trusted).equals(spki(key.publicKey))) {
    throw new Error(
      `refusing to sign: ${directory}/${key.id}.pub is a different key from the private key ` +
        'configured. Rotate to a NEW key id rather than reusing this one.',
    );
  }
}

export interface AnchorConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

/**
 * The external store each signed checkpoint is written to, or undefined.
 *
 * Without it a checkpoint lives only in the database it vouches for: whoever can rewrite the
 * audit table can delete the checkpoint rows over it too, and nothing outside remembers them.
 * The secret is read from `CHECKPOINT_S3_SECRET_ACCESS_KEY_FILE`; production refuses it inline.
 */
export function anchorConfig(env: Env): AnchorConfig | undefined {
  const endpoint = env['CHECKPOINT_S3_ENDPOINT'];
  if (endpoint === undefined || endpoint === '') return undefined;
  const accessKeyId = env['CHECKPOINT_S3_ACCESS_KEY_ID'];
  if (accessKeyId === undefined || accessKeyId === '') {
    throw new Error('CHECKPOINT_S3_ACCESS_KEY_ID is not set');
  }
  return {
    endpoint,
    region: env['CHECKPOINT_S3_REGION'] ?? 'us-east-1',
    accessKeyId,
    secretAccessKey: loadSecret('CHECKPOINT_S3_SECRET_ACCESS_KEY', env, {
      allowInline: !isProduction(env),
    }),
    bucket: env['CHECKPOINT_S3_BUCKET'] ?? 'kf-audit',
  };
}

/**
 * Production signs WITH an external anchor. Returns the refusal to report, or undefined.
 *
 * Reported after signing rather than instead of it: refusing to sign would widen the unsigned
 * window, which is the thing checkpoints exist to shrink. The database checkpoint is still
 * written; the run then exits nonzero so `OnFailure=` reaches a person every hour until the
 * anchor is configured.
 */
export function missingAnchor(env: Env, anchor: AnchorConfig | undefined): string | undefined {
  if (anchor !== undefined || !isProduction(env)) return undefined;
  return (
    'checkpoint signed into the database only: production requires an external anchor ' +
    '(CHECKPOINT_S3_ENDPOINT and credentials), because a checkpoint stored only beside the ' +
    'log it vouches for can be deleted with it.'
  );
}
