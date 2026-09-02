import { canonicalize, digestBytes } from '@kf/canonicalization';
import type { ProjectionMember, ProjectionResult } from './types.js';

export type ProjectionRenderTarget = 'json' | 'markdown' | 'html';

export interface RenderedProjection {
  readonly target: ProjectionRenderTarget;
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly contentDigest: string;
}

export interface ProjectionRenderOptions {
  /** Members whose full typed payload is inlined; the rest are referenced. Never a membership cut. */
  readonly maxInlineMembers?: number;
}

function safeText(value: string): string {
  return value
    .replaceAll(String.fromCharCode(0), ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

const md = (value: string): string => safeText(value).replace(/([\\`*_[\]{}<>#])/g, '\\$1');

const html = (value: string): string =>
  safeText(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function line(member: ProjectionMember): string {
  return `${member.objectType} — ${member.classification} — ${member.objectId} (${member.contentDigest})`;
}

/** Deterministic Markdown. Every member of every section appears; content is budgeted, membership is not. */
export function renderProjectionMarkdown(
  result: ProjectionResult,
  options: ProjectionRenderOptions = {},
): string {
  let inlineLeft = options.maxInlineMembers ?? Number.POSITIVE_INFINITY;
  const out = [
    `# ${md(result.definition.id)} v${String(result.definition.version)} for ${md(result.source.personId)}`,
    '',
    `- Corpus digest: \`${result.source.corpusDigest}\``,
    `- Projection digest: \`${result.projectionDigest}\``,
    `- Members: \`${String(result.measurements.memberCount)}\``,
    ...(Object.keys(result.parameters).length > 0
      ? [`- Parameters: \`${canonicalize(result.parameters)}\``]
      : []),
    '',
  ];
  for (const section of result.sections) {
    out.push(`## ${md(section.title)}`, '');
    if (section.members.length === 0) out.push('_None._');
    for (const member of section.members) {
      out.push(`- **${md(member.title ?? member.objectType)}** — ${md(line(member))}`);
      if (member.itemState === 'withdrawn') {
        out.push(
          `  - Withdrawal: ${md(member.withdrawnAt ?? 'time not recorded')} — ${md(member.withdrawalReason ?? 'reason not recorded')}`,
        );
      }
      if (member.content !== undefined && Object.keys(member.content).length > 0) {
        if (inlineLeft > 0) {
          inlineLeft -= 1;
          out.push('  ```json', `  ${canonicalize(member.content)}`, '  ```');
        } else {
          out.push('  - full typed payload referenced, not inlined (inline ceiling reached)');
        }
      }
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** Escaped HTML. No member-controlled value is emitted as markup. */
export function renderProjectionHtml(
  result: ProjectionResult,
  options: ProjectionRenderOptions = {},
): string {
  let inlineLeft = options.maxInlineMembers ?? Number.POSITIVE_INFINITY;
  const sections = result.sections
    .map((section) => {
      const items = section.members
        .map((member) => {
          const hasContent = member.content !== undefined && Object.keys(member.content).length > 0;
          let payload = '';
          if (hasContent) {
            if (inlineLeft > 0) {
              inlineLeft -= 1;
              payload = `<details><summary>Full typed payload</summary><pre>${html(canonicalize(member.content))}</pre></details>`;
            } else {
              payload = '<div><em>full typed payload referenced, not inlined</em></div>';
            }
          }
          const withdrawal =
            member.itemState === 'withdrawn'
              ? `<div>Withdrawal: ${html(member.withdrawnAt ?? 'time not recorded')} — ${html(member.withdrawalReason ?? 'reason not recorded')}</div>`
              : '';
          return `<li><strong>${html(member.title ?? member.objectType)}</strong> — ${html(line(member))}${withdrawal}${payload}</li>`;
        })
        .join('');
      return `<section><h2>${html(section.title)}</h2>${items === '' ? '<p><em>None.</em></p>' : `<ul>${items}</ul>`}</section>`;
    })
    .join('');
  const head = `${html(result.definition.id)} v${String(result.definition.version)} for ${html(result.source.personId)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${head}</title></head><body><main><h1>${head}</h1><dl><dt>Corpus digest</dt><dd><code>${html(result.source.corpusDigest)}</code></dd><dt>Projection digest</dt><dd><code>${html(result.projectionDigest)}</code></dd><dt>Members</dt><dd>${String(result.measurements.memberCount)}</dd></dl>${sections}</main></body></html>\n`;
}

const MEDIA: Readonly<Record<ProjectionRenderTarget, string>> = {
  json: 'application/json',
  markdown: 'text/markdown',
  html: 'text/html',
};

/** One Result, any target. The JSON target is the canonical Result itself. */
export function renderProjection(
  result: ProjectionResult,
  target: ProjectionRenderTarget,
  options: ProjectionRenderOptions = {},
): RenderedProjection {
  const text =
    target === 'json'
      ? `${canonicalize(result)}\n`
      : target === 'markdown'
        ? renderProjectionMarkdown(result, options)
        : renderProjectionHtml(result, options);
  const bytes = Buffer.from(text, 'utf8');
  return { target, mediaType: MEDIA[target], bytes, contentDigest: digestBytes(bytes) };
}
