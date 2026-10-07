import { describe, expect, it } from 'vitest';
import { composeDigests, type DigestRow } from './digest.js';
import { parseSmtpSettings } from './smtp.js';

const ORIGIN = 'https://kf.example.test';
const base = {
  organizationId: '01900000-0000-7000-8000-000000000002',
  organizationName: 'Véracier SA',
  personId: '01900000-0000-7000-8000-000000000010',
  email: 'ceo@example.test',
} as const;

const shown: DigestRow = {
  ...base,
  kind: 'to_verify',
  disclosed: true,
  itemId: '01900000-0000-7000-8000-0000000000aa',
  title: 'Bench rail measured at 3.31 V',
};

describe('the digest composer (KF-SAS-RQ-274)', () => {
  it('names a disclosed item with its link and counts an undisclosed one', () => {
    const [message] = composeDigests(
      [shown, { ...base, kind: 'to_verify', disclosed: false, itemId: null, title: null }],
      ORIGIN,
    );
    expect(message!.text).toContain('Bench rail measured at 3.31 V');
    expect(message!.text).toContain(`${ORIGIN}/objects/${shown.itemId!}`);
    expect(message!.text).toContain('1 more item whose content stays in Knowledge Fabric');
    expect(message!.subject).toBe('Knowledge Fabric: 2 items need you');
  });

  it('never prints a title or id from a row not marked disclosed, whatever it carries', () => {
    // A planted row: the database said no, and the row still carries the content.
    const planted: DigestRow = {
      ...base,
      kind: 'to_verify',
      disclosed: false,
      itemId: '01900000-0000-7000-8000-0000000000bb',
      title: 'Acquisition target is Halberd Aero',
    };
    const [message] = composeDigests([planted], ORIGIN);
    expect(message!.text).not.toContain('Halberd');
    expect(message!.text).not.toContain(planted.itemId!);
    expect(message!.subject).not.toContain('Halberd');
  });

  it('keeps titles and organization names out of the subject', () => {
    const [message] = composeDigests([shown], ORIGIN);
    expect(message!.subject).not.toContain('Bench');
    expect(message!.subject).not.toContain('Véracier');
  });

  it('writes one message per person and organization', () => {
    const other = { ...shown, organizationId: '01900000-0000-7000-8000-000000000003' };
    expect(composeDigests([shown, other, { ...shown, personId: 'x' }], ORIGIN)).toHaveLength(3);
  });
});

describe('SMTP settings', () => {
  it('refuses plain SMTP to anything but a loopback relay', () => {
    expect(() =>
      parseSmtpSettings(
        JSON.stringify({
          host: 'smtp.example.com',
          port: 25,
          security: 'none',
          from: 'kf@example.test',
        }),
      ),
    ).toThrow(/loopback/);
    expect(
      parseSmtpSettings(
        JSON.stringify({
          host: '127.0.0.1',
          port: 2525,
          security: 'none',
          from: 'kf@example.test',
        }),
      ).host,
    ).toBe('127.0.0.1');
  });

  it('requires the password file when a user is named', () => {
    expect(() =>
      parseSmtpSettings(
        JSON.stringify({
          host: 'smtp.example.com',
          port: 465,
          security: 'tls',
          user: 'kf',
          from: 'kf@example.test',
        }),
      ),
    ).toThrow(/PASSWORD_FILE/);
  });
});
