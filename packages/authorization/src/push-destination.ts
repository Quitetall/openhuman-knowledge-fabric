/**
 * A person's urgent-push destination, sealed (ADR 0040 decision 9, KF-SAS-RQ-274;
 * 20261011500000).
 *
 * An ntfy topic URL is a capability: whoever holds it reads and forges what is sent to it. So it is
 * never recorded in plaintext. The API seals it, before the `set_push_destination` act is
 * dispatched, to the public half of an X25519 key whose private half only kf-notify's unit holds;
 * the act's parameters, the ledger, `core.push_destination`, the operational backup and the export
 * of the ledger carry the sealed value only. kf-notify opens it at send time.
 *
 *   kfpd1.<key id>.<ephemeral public key>.<nonce>.<ciphertext and tag>
 *
 * X25519 with a fresh ephemeral key per seal, HKDF-SHA256 to a 256-bit key, AES-256-GCM. The
 * associated data binds the organization and the person: a sealed value copied onto another
 * person's row does not open there, so nobody can point their own items at somebody else's phone
 * by copying, nor read another's topic by moving it. The key id (16 hex characters of SHA-256 over
 * `kf-push-destination-key-v1`, a NUL and the raw public key) says which key a value was sealed to; one sealed to another key does not
 * open, and the person is told by the digest until they set it again.
 *
 * WHERE A DESTINATION MAY POINT. Only at a push server the deployment names (`servers`, origins
 * such as `https://ntfy.sh`), with one path segment, the topic, of 24 to 64 URL-safe characters,
 * and nothing else: no user, password, query or fragment. A person chooses their topic; the
 * deployment chooses where the notifier may send — so a destination cannot turn the notifier into a
 * client of some other service on the host's network. A server is `https:`, or `http:` on loopback
 * only (as the digest's SMTP relay may be plain only on loopback). A topic shorter than 24
 * characters is refused: a free ntfy topic is public to whoever guesses it
 * (docs/deployment/phone-alerts.md).
 *
 * What this does not do: it does not authenticate to an ntfy server that requires an access token,
 * and it does not rotate keys — a new key leaves earlier values unopenable, which fails to the
 * digest, never to a wrong recipient.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

export const SEALED_DESTINATION =
  /^kfpd1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,704}$/u;

const TOPIC = /^\/[A-Za-z0-9_-]{24,64}$/u;
const MAX_URL = 512;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const INFO = Buffer.from('kf-push-destination-v1', 'utf8');

export class DestinationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DestinationRefused';
  }
}

/** A push server's origin as the deployment configures it, validated. */
export function parsePushServer(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new DestinationRefused('a push server must be an origin such as https://ntfy.sh');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new DestinationRefused('a push server must be https (plain http only on loopback)');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new DestinationRefused('a push server is an origin, with no credential or query');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new DestinationRefused('a push server is an origin, with no path');
  }
  return url.origin;
}

/** A comma- or space-separated list of origins (KF_NOTIFY_PUSH_SERVERS). Empty: none allowed. */
export function parsePushServers(list: string | undefined): readonly string[] {
  return (list ?? '')
    .split(/[\s,]+/u)
    .filter((entry) => entry !== '')
    .map(parsePushServer);
}

/**
 * The destination a person gave, as the URL the notifier will POST to, or a refusal naming what
 * is wrong — never quoting the URL, which is the capability.
 */
export function parseDestination(raw: string, servers: readonly string[]): string {
  if (raw.length > MAX_URL) throw new DestinationRefused('a push destination is at most 512 bytes');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DestinationRefused(
      'a push destination must be a URL such as https://ntfy.sh/<topic>',
    );
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new DestinationRefused('a push destination carries no user, password, query or fragment');
  }
  if (!servers.includes(url.origin)) {
    throw new DestinationRefused(
      'a push destination must be on a push server this deployment names (KF_NOTIFY_PUSH_SERVERS)',
    );
  }
  if (!TOPIC.test(url.pathname)) {
    throw new DestinationRefused(
      'a push destination is one topic of 24 to 64 letters, digits, - or _ (a short topic is ' +
        'guessable, and a free ntfy topic is public to whoever guesses it)',
    );
  }
  return `${url.origin}${url.pathname}`;
}

function aad(organizationId: string, personId: string): Buffer {
  return Buffer.from(`kf-push-destination-v1\u0000${organizationId}\u0000${personId}`, 'utf8');
}

function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'X25519' || typeof jwk.x !== 'string') {
    throw new DestinationRefused('the destination key is not an X25519 key');
  }
  return Buffer.from(jwk.x, 'base64url');
}

function publicFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new DestinationRefused('an X25519 public key is 32 bytes');
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

function keyIdOf(raw: Buffer): string {
  return createHash('sha256')
    .update('kf-push-destination-key-v1\u0000')
    .update(raw)
    .digest('hex')
    .slice(0, 16);
}

function derive(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), INFO, 32));
}

/** The public half as the API is configured with it: 32 raw bytes, base64url. */
export function parseDestinationPublicKey(text: string): Buffer {
  const raw = Buffer.from(text.trim(), 'base64url');
  publicFromRaw(raw);
  return raw;
}

/** A new key pair: the private half as PKCS#8 PEM for kf-notify, the public half for the API. */
export function generateDestinationKey(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: rawPublic(publicKey).toString('base64url'),
  };
}

/** The public half of a PKCS#8 PEM private key, as the API is configured with it. */
export function destinationPublicKeyOf(privatePem: string): string {
  return rawPublic(createPublicKey(createPrivateKey(privatePem))).toString('base64url');
}

export function sealDestination(
  destination: string,
  recipientPublicKey: Buffer,
  binding: { readonly organizationId: string; readonly personId: string },
): string {
  const recipient = publicFromRaw(recipientPublicKey);
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const ephemeral = rawPublic(publicKey);
  const key = derive(
    diffieHellman({ privateKey, publicKey: recipient }),
    ephemeral,
    recipientPublicKey,
  );
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(binding.organizationId, binding.personId));
  const body = Buffer.concat([
    cipher.update(Buffer.from(destination, 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const sealed = [
    'kfpd1',
    keyIdOf(recipientPublicKey),
    ephemeral.toString('base64url'),
    nonce.toString('base64url'),
    body.toString('base64url'),
  ].join('.');
  if (!SEALED_DESTINATION.test(sealed)) throw new DestinationRefused('sealed value out of shape');
  return sealed;
}

/** kf-notify's half: the private key, and opening. */
export interface DestinationOpener {
  readonly keyId: string;
  /** The URL, or undefined when it was sealed to another key, another person, or is malformed. */
  open(
    sealed: string,
    binding: { readonly organizationId: string; readonly personId: string },
  ): string | undefined;
}

export function destinationOpener(privatePem: string): DestinationOpener {
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== 'x25519') {
    throw new DestinationRefused('the destination key is not an X25519 private key');
  }
  const recipient = rawPublic(createPublicKey(privateKey));
  const keyId = keyIdOf(recipient);
  return {
    keyId,
    open(sealed, binding) {
      if (!SEALED_DESTINATION.test(sealed)) return undefined;
      const [, id, ephemeralText, nonceText, bodyText] = sealed.split('.');
      if (id !== keyId) return undefined;
      try {
        const ephemeral = Buffer.from(ephemeralText!, 'base64url');
        const nonce = Buffer.from(nonceText!, 'base64url');
        const body = Buffer.from(bodyText!, 'base64url');
        if (nonce.length !== 12 || body.length <= 16) return undefined;
        const key = derive(
          diffieHellman({ privateKey, publicKey: publicFromRaw(ephemeral) }),
          ephemeral,
          recipient,
        );
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(aad(binding.organizationId, binding.personId));
        decipher.setAuthTag(body.subarray(body.length - 16));
        return Buffer.concat([
          decipher.update(body.subarray(0, body.length - 16)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        return undefined;
      }
    },
  };
}
