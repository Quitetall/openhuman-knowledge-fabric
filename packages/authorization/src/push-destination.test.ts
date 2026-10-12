import { describe, expect, it } from 'vitest';
import {
  DestinationRefused,
  SEALED_DESTINATION,
  destinationOpener,
  destinationPublicKeyOf,
  generateDestinationKey,
  parseDestination,
  parseDestinationPublicKey,
  parsePushServer,
  parsePushServers,
  sealDestination,
} from './push-destination.js';

const SERVERS = ['https://ntfy.sh'];
const TOPIC = 'kf-0123456789abcdef0123456789abcdef';
const URL_ = `https://ntfy.sh/${TOPIC}`;
const ME = {
  organizationId: '01900000-0000-7000-8000-000000000002',
  personId: '01900000-0000-7000-8000-000000000010',
};
const SOMEONE_ELSE = { ...ME, personId: '01900000-0000-7000-8000-000000000011' };

function refusal(fn: () => unknown): DestinationRefused {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof DestinationRefused) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('a push destination is sealed (KF-SAS-RQ-274, 20261011500000)', () => {
  const key = generateDestinationKey();
  const publicKey = parseDestinationPublicKey(key.publicKey);

  it('opens for the person it was sealed for, with the key it was sealed to', () => {
    const sealed = sealDestination(URL_, publicKey, ME);
    expect(sealed).toMatch(SEALED_DESTINATION);
    expect(sealed).not.toContain(TOPIC);
    expect(destinationOpener(key.privatePem).open(sealed, ME)).toBe(URL_);
    expect(destinationPublicKeyOf(key.privatePem)).toBe(key.publicKey);
  });

  it('seals the same destination differently every time', () => {
    expect(sealDestination(URL_, publicKey, ME)).not.toBe(sealDestination(URL_, publicKey, ME));
  });

  it('does not open for another person: a copied value points nobody at my phone', () => {
    const sealed = sealDestination(URL_, publicKey, ME);
    expect(destinationOpener(key.privatePem).open(sealed, SOMEONE_ELSE)).toBeUndefined();
  });

  it('does not open under another key, nor when tampered with', () => {
    const sealed = sealDestination(URL_, publicKey, ME);
    expect(destinationOpener(generateDestinationKey().privatePem).open(sealed, ME)).toBeUndefined();
    const last = sealed.at(-2) === 'A' ? 'B' : 'A';
    const tampered = `${sealed.slice(0, -2)}${last}${sealed.at(-1)!}`;
    expect(destinationOpener(key.privatePem).open(tampered, ME)).toBeUndefined();
    expect(destinationOpener(key.privatePem).open(URL_, ME)).toBeUndefined();
  });
});

describe('where a destination may point', () => {
  it('accepts one long topic on a named server', () => {
    expect(parseDestination(URL_, SERVERS)).toBe(URL_);
  });

  it.each([
    ['a server the deployment does not name', `https://evil.example/${TOPIC}`],
    ['a short, guessable topic', 'https://ntfy.sh/kf-alerts'],
    ['a query', `${URL_}?auth=x`],
    ['a fragment', `${URL_}#x`],
    ['a credential', `https://user:pw@ntfy.sh/${TOPIC}`],
    ['a second path segment', `${URL_}/json`],
    ['plain http to a remote server', `http://ntfy.sh/${TOPIC}`],
    ['not a URL', 'ntfy.sh/topic'],
  ])('refuses %s, without quoting it', (_what, raw) => {
    const error = refusal(() => parseDestination(raw, SERVERS));
    expect(error.message).not.toContain(TOPIC);
    expect(error.message).not.toContain(raw);
  });

  it('allows plain http only to a loopback server', () => {
    expect(parsePushServer('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(() => parsePushServer('http://ntfy.sh')).toThrow(DestinationRefused);
    expect(() => parsePushServer('https://ntfy.sh/topic')).toThrow(DestinationRefused);
    expect(parsePushServers('https://ntfy.sh, https://push.example.org')).toEqual([
      'https://ntfy.sh',
      'https://push.example.org',
    ]);
    expect(parsePushServers('')).toEqual([]);
  });
});
