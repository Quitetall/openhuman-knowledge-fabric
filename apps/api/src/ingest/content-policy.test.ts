import { describe, expect, it } from 'vitest';
import { deniedPathRule, formatContentRefusal, scanContent } from './content-policy.js';

/**
 * Fixtures are assembled at runtime rather than written out whole, so that this file does not
 * itself trip a secret scanner — which would be the right call by the scanner and a nuisance
 * for everyone else. Every value is a published test value: the IBAN is the ISO 13616 example,
 * the card is the Visa test PAN, and the SSN is outside nothing the SSA reserves.
 */
const KEY_HEADER = ['-----BEGIN', 'OPENSSH', 'PRIVATE', 'KEY-----'].join(' ');
const IBAN = ['DE89', '3704', '0044', '0532', '0130', '00'].join(' ');
const CARD = ['4111', '1111', '1111', '1111'].join(' ');
const SSN = ['123', '45', '6789'].join('-');

const scan = (text: string) => scanContent('note.md', Buffer.from(text));

describe('path rules', () => {
  it.each([
    ['.env', 'dotfile'],
    ['config/.env.production', 'dotfile'],
    ['repo/.git/config', 'dotfile'],
    ['home/.ssh/known_hosts', 'dotfile'],
    ['certs/server.pem', 'pem'],
    ['tls/server.key', 'key-file'],
    ['id_rsa', 'ssh-identity'],
    ['keys/id_ed25519.pub', 'ssh-identity'],
    ['vault.kdbx', 'password-database'],
    ['signing.p12', 'pkcs12'],
    ['signing.PFX', 'pkcs12'],
  ])('refuses %s under %s', (path, rule) => {
    expect(deniedPathRule(path)?.ruleId).toBe(rule);
  });

  it.each(['docs/brake-service.md', 'drawings/frame.dxf', 'keys-and-locks.md', 'id_card.md'])(
    'admits %s',
    (path) => {
      expect(deniedPathRule(path)).toBeUndefined();
    },
  );
});

describe('byte rules', () => {
  it('refuses a private key header and names the line', () => {
    expect(scan(`# Notes\n\n${KEY_HEADER}\nAAAA\n`)).toMatchObject({
      ruleId: 'private-key',
      line: 3,
    });
  });

  it('refuses an IBAN whose checksum holds, spaced or compact', () => {
    expect(scan(`Pay to ${IBAN} please`)?.ruleId).toBe('iban');
    expect(scan(`Pay to ${IBAN.replace(/ /g, '')}.`)?.ruleId).toBe('iban');
    // Greedy candidate running on into the next uppercase word must still be caught.
    expect(scan(`${IBAN} AND MORE`)?.ruleId).toBe('iban');
  });

  it('admits an IBAN-shaped string whose checksum fails', () => {
    expect(scan(`Ref ${IBAN.replace('DE89', 'DE88')}`)).toBeUndefined();
  });

  it('refuses a plausible SSN and admits the never-issued ranges', () => {
    expect(scan(`SSN: ${SSN}`)?.ruleId).toBe('us-ssn');
    for (const never of [
      '000-12-3456',
      '666-12-3456',
      '912-34-5678',
      '123-00-4567',
      '123-45-0000',
    ]) {
      expect(scan(`id ${never}`), never).toBeUndefined();
    }
  });

  it('refuses a Luhn-valid card number, grouped or not, even followed by a year', () => {
    expect(scan(`card ${CARD}`)?.ruleId).toBe('payment-card');
    expect(scan(`card ${CARD.replace(/ /g, '')}`)?.ruleId).toBe('payment-card');
    expect(scan(`card ${CARD.replace(/ /g, '')} 2029`)?.ruleId).toBe('payment-card');
  });

  it('admits a Luhn-invalid card number and ordinary numbers', () => {
    expect(scan(`card ${CARD.replace(/1$/, '2')}`)).toBeUndefined();
    const ordinary = [
      'Order 2026-09-23, part 1234-5678, qty 16.',
      'Serial 0123456789012345, phone +1 555 010 9999.',
      'Record 01a04000-0000-7000-8000-000000000000.',
      'Torque 45 Nm at 3000 rpm; tolerance 0.05 mm.',
    ];
    for (const text of ordinary) expect(scan(text), text).toBeUndefined();
  });

  it('never echoes the matched text in the refusal', () => {
    for (const secret of [KEY_HEADER, IBAN, CARD, SSN]) {
      const found = scan(`before ${secret} after`);
      expect(found, secret).toBeDefined();
      const message = formatContentRefusal(found!);
      expect(message).toContain('note.md');
      expect(message).toContain(found!.ruleId);
      for (const fragment of secret.split(/[ -]/).filter((part) => part.length >= 4)) {
        if (/^\d+$/.test(fragment) || fragment === 'PRIVATE') {
          expect(message, `${found!.ruleId} echoed ${fragment}`).not.toContain(fragment);
        }
      }
    }
  });
});
