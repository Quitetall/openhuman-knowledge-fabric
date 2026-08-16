export interface ParsedFrontmatter {
  readonly data: Readonly<Record<string, string | readonly string[]>>;
  readonly body: string;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  if (!markdown.startsWith('---\n')) return { data: {}, body: markdown };
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: markdown };
  const data: Record<string, string | readonly string[]> = {};
  for (const line of markdown.slice(4, end).split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    data[match[1]!] = parseFrontmatterValue(match[2] ?? '');
  }
  const bodyStart = markdown.indexOf('\n', end + 4);
  return { data, body: bodyStart === -1 ? '' : markdown.slice(bodyStart + 1) };
}

export function stringList(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? (value === '' ? [] : [value]) : [...value];
}

export function stringValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseFrontmatterValue(value: string): string | readonly string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return unquote(trimmed);
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== '');
}

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, '$2');
}
