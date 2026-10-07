/**
 * The daily digest of Needs you, composed (ADR 0040 decision 9, KF-SAS-RQ-274).
 *
 * What a row may say is decided by the database (`core.needs_you_digest()`, 20261007300000): a
 * title and an identifier only for an item at or below the organization's provider ceiling, which
 * the person reads now; otherwise neither. This composer is the second line: it never prints a
 * title or an identifier from a row that is not marked disclosed, whatever the row carries, so a
 * defect in one cannot put a restricted title in a mailbox by itself.
 *
 * The subject names no organization and no item: it is the part of an e-mail most often shown in
 * full on a locked phone.
 */

export type DigestKind = 'to_verify' | 'awaiting_others' | 'proposal';

export interface DigestRow {
  readonly organizationId: string;
  readonly organizationName: string | null;
  readonly personId: string;
  readonly email: string;
  readonly kind: DigestKind;
  readonly disclosed: boolean;
  readonly itemId: string | null;
  readonly title: string | null;
}

export interface DigestMessage {
  readonly personId: string;
  readonly organizationId: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly items: number;
}

const HEADINGS: Readonly<Record<DigestKind, string>> = {
  to_verify: 'Records an agent wrote, waiting for you to verify',
  awaiting_others: 'What your agents submitted, waiting for someone else to verify',
  proposal: 'Acts your agents proposed, waiting for you to perform or decline',
};

const ORDER: readonly DigestKind[] = ['proposal', 'to_verify', 'awaiting_others'];

/** A title on one line, bounded: it is shown, not parsed. */
function line(title: string): string {
  const flat = title.replace(/[\r\n\t]+/gu, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

export function composeDigests(rows: readonly DigestRow[], webOrigin: string): DigestMessage[] {
  const origin = webOrigin.replace(/\/+$/u, '');
  const groups = new Map<string, DigestRow[]>();
  for (const row of rows) {
    const key = `${row.personId}\u0000${row.organizationId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const messages: DigestMessage[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const sections: string[] = [];
    for (const kind of ORDER) {
      const items = group.filter((row) => row.kind === kind);
      if (items.length === 0) continue;
      const shown = items.filter(
        (row) => row.disclosed && row.itemId !== null && row.title !== null,
      );
      const counted = items.length - shown.length;
      const lines = shown.map((row) =>
        kind === 'proposal'
          ? `  - ${line(row.title!)}\n    ${origin}/needs-you`
          : `  - ${line(row.title!)}\n    ${origin}/objects/${encodeURIComponent(row.itemId!)}`,
      );
      if (counted > 0) {
        lines.push(
          `  - ${String(counted)} more ${counted === 1 ? 'item' : 'items'} whose content stays ` +
            `in Knowledge Fabric: ${origin}/needs-you`,
        );
      }
      sections.push(`${HEADINGS[kind]} (${String(items.length)}):\n${lines.join('\n')}`);
    }
    const total = group.length;
    const where = first.organizationName === null ? '' : ` in ${line(first.organizationName)}`;
    messages.push({
      personId: first.personId,
      organizationId: first.organizationId,
      to: first.email,
      subject: `Knowledge Fabric: ${String(total)} ${total === 1 ? 'item needs' : 'items need'} you`,
      text: [
        `What needs you${where}, as of this morning.`,
        '',
        sections.join('\n\n'),
        '',
        `Open Needs you: ${origin}/needs-you`,
        '',
        'Items above what your organization lets leave its host are counted here and shown only',
        'in Knowledge Fabric. To stop this daily e-mail, turn the digest off in Knowledge Fabric',
        '(set_notification_preference).',
      ].join('\n'),
      items: total,
    });
  }
  return messages;
}
