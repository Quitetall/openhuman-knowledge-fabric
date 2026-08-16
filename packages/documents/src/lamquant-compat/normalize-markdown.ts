export function normalizeGeneratedMarkdown(markdown: string): string {
  return normalizeMarkdown(stripGeneratedBanner(stripFrontmatter(markdown)));
}

export function normalizeMarkdown(markdown: string): string {
  return `${markdown.replace(/\r\n?/g, '\n').replace(/\n*$/, '')}\n`;
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown;
  const end = markdown.indexOf('\n---', 4);
  if (end === -1) return markdown;
  const next = markdown.indexOf('\n', end + 4);
  return next === -1 ? '' : markdown.slice(next + 1);
}

function stripGeneratedBanner(markdown: string): string {
  return markdown.replace(/^\s*<!--\s*GENERATED[\s\S]*?-->\s*/i, '');
}
