import { join } from 'node:path';
import {
  CODE_PREFIXES,
  LamQuantCompatibilityRejected,
  type LamQuantCompatibilityFileSystem,
} from './contracts.js';
import { normalizeRelativePath } from './relative-paths.js';

function parseInlineList(value: string): readonly string[] {
  const trimmed = value.trim();
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (inner.trim() === '') return [];
  return inner
    .split(',')
    .map((item) => item.trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter((item) => item !== '');
}

function codeReferences(markdown: string): readonly string[] {
  if (!markdown.startsWith('---\n')) return [];
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return [];
  const frontmatter = markdown.slice(4, end).split('\n');
  let linksIndent: number | undefined;
  const references: string[] = [];
  for (const line of frontmatter) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      linksIndent = trimmed === 'links:' ? indent : undefined;
      continue;
    }
    if (linksIndent !== undefined && indent > linksIndent && trimmed.startsWith('code:')) {
      references.push(...parseInlineList(trimmed.slice('code:'.length)));
    }
  }
  return references;
}

function expandCodeReference(reference: string): string {
  for (const [prefix, replacement] of CODE_PREFIXES) {
    if (reference.startsWith(prefix)) return replacement + reference.slice(prefix.length);
  }
  return reference;
}

export async function requiredCodePaths(
  checkoutPath: string,
  fileSystem: LamQuantCompatibilityFileSystem,
): Promise<readonly string[]> {
  const atoms = join(checkoutPath, 'docs', 'atoms');
  if ((await fileSystem.kind(atoms)) === 'missing') return [];
  if ((await fileSystem.kind(atoms)) !== 'directory') {
    throw new LamQuantCompatibilityRejected(
      'missing_input',
      `LamQuant input '${atoms}' is not a directory`,
    );
  }
  const paths = new Set<string>();
  for (const relativePath of await fileSystem.listFiles(atoms)) {
    if (!relativePath.endsWith('.md')) continue;
    const markdown = (await fileSystem.readFile(join(atoms, relativePath))).toString('utf8');
    for (const reference of codeReferences(markdown)) {
      paths.add(normalizeRelativePath(expandCodeReference(reference), 'links.code'));
    }
  }
  return [...paths].sort();
}
