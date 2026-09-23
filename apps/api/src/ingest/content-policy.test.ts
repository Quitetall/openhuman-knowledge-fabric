import { describe, expect, it } from 'vitest';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
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

// --- inside compressed documents -----------------------------------------------------------

interface ZipFixtureEntry {
  readonly name: string;
  readonly data: Buffer;
  /** Store rather than deflate. */
  readonly stored?: boolean;
  /** Lie in the directory about the uncompressed size. */
  readonly declaredSize?: number;
  readonly flags?: number;
}

/** A minimal, valid ZIP: local headers, then the central directory, then its end record. */
function zip(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = entry.stored === true ? entry.data : deflateRawSync(entry.data);
    const method = entry.stored === true ? 0 : 8;
    const crc = crc32(entry.data);
    const size = entry.declaredSize ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A DOCX whose body is the given paragraphs, each paragraph a list of runs. */
function docx(paragraphs: readonly (readonly string[])[]): Buffer {
  const body = paragraphs
    .map(
      (runs) =>
        `<w:p>${runs.map((run) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(run)}</w:t></w:r>`).join('')}</w:p>`,
    )
    .join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from('<?xml version="1.0"?><Types xmlns="x"><Default Extension="xml"/></Types>'),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`,
      ),
    },
  ]);
}

/** An ODT whose content is the given paragraphs. */
function odt(paragraphs: readonly string[]): Buffer {
  const body = paragraphs.map((p) => `<text:p text:style-name="P1">${esc(p)}</text:p>`).join('');
  return zip([
    {
      name: 'mimetype',
      data: Buffer.from('application/vnd.oasis.opendocument.text'),
      stored: true,
    },
    {
      name: 'content.xml',
      data: Buffer.from(
        `<?xml version="1.0"?><office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
      ),
    },
  ]);
}

/** A PDF with one page whose content stream (FlateDecode) is `content`, plus extra objects. */
function pdf(content: string, extra = ''): Buffer {
  const stream = deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from(
      '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
        `4 0 obj\n<< /Length ${String(stream.length)} /Filter /FlateDecode >>\nstream\n`,
      'latin1',
    ),
    stream,
    Buffer.from(`\nendstream\nendobj\n${extra}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1'),
  ]);
}

const [CARD_A, CARD_B] = [CARD.slice(0, 9), CARD.slice(9)];

describe('byte rules inside compressed documents', () => {
  it('refuses a DOCX carrying a card number Word split across runs, naming the part', () => {
    const found = scanContent('expenses.docx', docx([['Card: ', CARD_A, CARD_B, ' paid.']]));
    expect(found).toMatchObject({ ruleId: 'payment-card', part: 'word/document.xml' });
    expect(found?.line).toBeUndefined();
    const message = formatContentRefusal(found!);
    expect(message).toContain('expenses.docx');
    expect(message).toContain('word/document.xml');
    expect(message).not.toContain('1111');
  });

  it('refuses a DOCX carrying a private key', () => {
    expect(scanContent('notes.docx', docx([[KEY_HEADER], ['AAAA']]))).toMatchObject({
      ruleId: 'private-key',
      part: 'word/document.xml',
    });
  });

  it('refuses an ODT carrying a card number or a private key', () => {
    expect(scanContent('a.odt', odt(['Pay with', `card ${CARD}`]))).toMatchObject({
      ruleId: 'payment-card',
      part: 'content.xml',
    });
    expect(scanContent('b.odt', odt([KEY_HEADER]))?.ruleId).toBe('private-key');
  });

  it('admits clean DOCX and ODT, and does not join digits across paragraphs', () => {
    expect(scanContent('clean.docx', docx([['Torque 45 Nm at 3000 rpm.']]))).toBeUndefined();
    expect(scanContent('clean.odt', odt(['Order 2026-09-23, qty 16.']))).toBeUndefined();
    // The end of one paragraph and the start of the next are not one number.
    expect(scanContent('split.docx', docx([[CARD_A], [CARD_B]]))).toBeUndefined();
  });

  it('refuses a PDF whose compressed page draws a card number, kerned or not', () => {
    const kerned = `BT /F1 12 Tf 72 700 Td [(Card)-333(${CARD_A})20(${CARD_B})] TJ ET`;
    expect(scanContent('receipt.pdf', pdf(kerned))).toMatchObject({
      ruleId: 'payment-card',
      part: expect.stringMatching(/^stream@/) as unknown,
    });
    const plain = `BT /F1 12 Tf 72 700 Td (Card ${CARD}) Tj ET`;
    expect(scanContent('receipt.pdf', pdf(plain))?.ruleId).toBe('payment-card');
    // Octal escapes are how a PDF writes bytes it would rather not put raw.
    const octal = `BT (${[...CARD].map((c) => `\\${c.charCodeAt(0).toString(8)}`).join('')}) Tj ET`;
    expect(scanContent('receipt.pdf', pdf(octal))?.ruleId).toBe('payment-card');
  });

  it('refuses a PDF carrying a private key in a compressed stream', () => {
    expect(
      scanContent('bundle.pdf', pdf(`BT (see attached) Tj ET\n${KEY_HEADER}\n`)),
    ).toMatchObject({ ruleId: 'private-key' });
  });

  it('admits a clean PDF, including a width table that reads as a Luhn-valid card', () => {
    // A font's /Widths array is numbers separated by single spaces. Find one whose first sixteen
    // digits are a Mastercard-prefixed Luhn-valid number, the way real width tables are.
    const luhn = (digits: string) =>
      [...digits].reverse().reduce((sum, d, i) => {
        const n = Number(d) * (i % 2 === 1 ? 2 : 1);
        return sum + (n > 9 ? n - 9 : n);
      }, 0) %
        10 ===
      0;
    const last = [...Array(1000).keys()].find((n) =>
      luhn(`556556556556556${String(n).padStart(3, '0')}`.slice(0, 16)),
    )!;
    const widths = `5 0 obj\n<< /Type /Font /Widths [556 556 556 556 556 ${String(last).padStart(3, '0')}] >>\nendobj\n`;
    const clean = pdf('BT /F1 12 Tf 72 700 Td [(Torque)-333(45)-333(Nm)] TJ ET', widths);
    expect(scanContent('manual.pdf', clean)).toBeUndefined();
  });

  it('refuses a zip bomb by ratio before expanding it, naming the part', () => {
    const bomb = zip([{ name: 'word/document.xml', data: Buffer.alloc(4 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(16 * 1024);
    const found = scanContent('bomb.docx', bomb);
    expect(found).toMatchObject({ ruleId: 'archive-compression-ratio', part: 'word/document.xml' });
    expect(formatContentRefusal(found!)).toMatch(/decompression bomb/);
  });

  it('refuses a zip bomb whose directory lies about the size, at the inflater', () => {
    // The directory claims 100 bytes; the part is 72 MiB. The inflater's own ceiling stops it at
    // the ratio bound. Inflated in full and only then checked, it would be the budget that
    // refused it — after 72 MiB had been allocated — so the rule id tells the two apart.
    const liar = zip([
      { name: 'content.xml', data: Buffer.alloc(72 * 1024 * 1024), declaredSize: 100 },
    ]);
    expect(scanContent('liar.odt', liar)?.ruleId).toBe('archive-compression-ratio');
  });

  it('refuses a ZIP whose parts together expand past the budget', () => {
    // Each part is exactly at the ratio floor, so only the total can refuse it.
    const part = Buffer.alloc(1024 * 1024, 0x20);
    const wide = zip(
      Array.from({ length: 65 }, (_, i) => ({ name: `sheet${String(i)}.xml`, data: part })),
    );
    expect(scanContent('wide.xlsx', wide)).toMatchObject({ ruleId: 'archive-expanded-size' });
  });

  it('refuses a ZIP it cannot read rather than admitting it unscanned', () => {
    const encrypted = zip([{ name: 'content.xml', data: Buffer.from('x'), flags: 0x1 }]);
    expect(scanContent('locked.odt', encrypted)?.ruleId).toBe('archive-encrypted');
    const truncated = docx([['hello']]).subarray(0, 40);
    expect(scanContent('broken.docx', truncated)?.ruleId).toBe('archive-malformed');
  });

  it('reads a ZIP inside a ZIP', () => {
    const inner = odt([`card ${CARD}`]);
    const outer = zip([{ name: 'word/embeddings/oleObject1.odt', data: inner }]);
    expect(scanContent('outer.docx', outer)).toMatchObject({
      ruleId: 'payment-card',
      part: 'word/embeddings/oleObject1.odt!/content.xml',
    });
  });
});
