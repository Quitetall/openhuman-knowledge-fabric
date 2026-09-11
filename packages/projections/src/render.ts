import { canonicalize, digestBytes } from '@kf/canonicalization';
import type { ProjectionMember, ProjectionResult } from './types.js';

export type ProjectionRenderTarget = 'json' | 'markdown' | 'html';

export interface RenderedProjection {
  readonly target: ProjectionRenderTarget;
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly contentDigest: string;
}

/**
 * Where a rendered member points. Rendering concerns only: a link changes nothing about the
 * Result or its digest, and a renderer given no links emits none rather than guessing a host.
 */
export interface ProjectionLinks {
  /** The Object View for a member — every member has one. */
  readonly objectView: (member: ProjectionMember) => string | undefined;
  /** The bytes themselves, for members that have any (documents, artifacts). */
  readonly source?: (member: ProjectionMember) => string | undefined;
}

export interface ProjectionRenderOptions {
  /** Members whose full typed payload is inlined; the rest are referenced. Never a membership cut. */
  readonly maxInlineMembers?: number;
  readonly links?: ProjectionLinks;
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

/** `decision_record` reads as "decision record"; never a guess beyond the type's own name. */
function typeLabel(objectType: string): string {
  return objectType.replaceAll('_', ' ');
}

/**
 * Who the record is for, from the corpus itself: the person member whose id is the source.
 * When the corpus does not carry that member, the id is shown as it is — a name the reader
 * cannot verify is worse than an identifier they can.
 */
function subjectOf(result: ProjectionResult): { readonly name: string; readonly id: string } {
  const id = result.source.personId;
  for (const section of result.sections) {
    for (const member of section.members) {
      if (member.objectId === id && member.objectType === 'person' && member.title !== undefined) {
        return { name: member.title, id };
      }
    }
  }
  return { name: id, id };
}

function organizationOf(result: ProjectionResult): string | undefined {
  for (const section of result.sections) {
    for (const member of section.members) {
      if (member.objectType === 'organization' && member.title !== undefined) return member.title;
    }
  }
  return undefined;
}

/** Deterministic Markdown. Every member of every section appears; content is budgeted, membership is not. */
export function renderProjectionMarkdown(
  result: ProjectionResult,
  options: ProjectionRenderOptions = {},
): string {
  let inlineLeft = options.maxInlineMembers ?? Number.POSITIVE_INFINITY;
  const subject = subjectOf(result);
  const organization = organizationOf(result);
  const out = [
    `# ${md(subject.name)} — ${md(result.definition.id)} v${String(result.definition.version)}`,
    '',
    ...(organization === undefined ? [] : [`- Organization: ${md(organization)}`]),
    `- Person: \`${result.source.personId}\``,
    `- Corpus digest: \`${result.source.corpusDigest}\``,
    `- Projection digest: \`${result.projectionDigest}\``,
    `- Members: \`${String(result.measurements.memberCount)}\``,
    ...(Object.keys(result.parameters).length > 0
      ? [`- Parameters: \`${canonicalize(result.parameters)}\``]
      : []),
    '',
  ];
  for (const section of result.sections) {
    out.push(`## ${md(section.title)} (${String(section.members.length)})`, '');
    if (section.members.length === 0) out.push('_None._');
    for (const member of section.members) {
      const view = options.links?.objectView(member);
      const source = options.links?.source?.(member);
      const title = md(member.title ?? member.objectType);
      out.push(
        `- **${view === undefined ? title : `[${title}](${view})`}** — ${md(line(member))}` +
          (source === undefined ? '' : ` — [source](${source})`),
      );
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

/**
 * The page's own styles. Inline, so the bytes stand alone wherever they are saved or served;
 * no font, script or stylesheet is fetched. Tokens first, both themes, one accent.
 */
const STYLE = [
  ':root{color-scheme:light dark;--bg:#f7f6f2;--panel:#fff;--ink:#1c1b18;--muted:#5f5b52;--rule:#dedbd3;--accent:#8a4b1e;--chip:#efe9df;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  '@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#171613;--panel:#1f1d19;--ink:#ece8df;--muted:#a8a294;--rule:#37342d;--accent:#d99a5b;--chip:#2a2721}}',
  ':root[data-theme=dark]{--bg:#171613;--panel:#1f1d19;--ink:#ece8df;--muted:#a8a294;--rule:#37342d;--accent:#d99a5b;--chip:#2a2721}',
  'body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans)}',
  'main{max-width:64rem;margin:0 auto;padding:2.5rem 1.5rem 4rem}',
  'header{border-bottom:1px solid var(--rule);padding-bottom:1.25rem;margin-bottom:1.5rem}',
  'h1{font-size:1.75rem;line-height:1.2;margin:0 0 .25rem;text-wrap:balance}',
  '.sub{color:var(--muted);margin:0}',
  'dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:1rem 0 0;font-size:.85rem}',
  'dl.meta dt{color:var(--muted)}dl.meta dd{margin:0;font-family:var(--mono);font-size:.8rem;overflow-wrap:anywhere}',
  'nav.toc{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0 0}',
  'nav.toc a{color:var(--ink);text-decoration:none;background:var(--chip);border-radius:999px;padding:.2rem .7rem;font-size:.85rem}',
  'nav.toc a b{color:var(--accent)}',
  'section{margin:2rem 0}',
  'h2{font-size:1.15rem;margin:0 0 .75rem;padding-bottom:.35rem;border-bottom:1px solid var(--rule)}',
  'h2 small{color:var(--muted);font-weight:400;font-size:.85rem;margin-left:.5rem}',
  'ul.members{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}',
  'li.member{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:.7rem .9rem}',
  '.member .t{display:flex;flex-wrap:wrap;gap:.35rem .6rem;align-items:baseline}',
  '.member .t a,.member .t strong{color:var(--ink);text-decoration:none;font-weight:600}',
  '.member .t a:hover{text-decoration:underline;color:var(--accent)}',
  '.chip{display:inline-block;font-size:.72rem;letter-spacing:.02em;text-transform:uppercase;background:var(--chip);color:var(--muted);border-radius:4px;padding:.05rem .4rem}',
  '.chip.c-public{color:#2f6b3a}.chip.c-internal{color:#5a5a8c}.chip.c-confidential{color:#8a4b1e}.chip.c-restricted{color:#9c2b2b}',
  '.member .id{font-family:var(--mono);font-size:.74rem;color:var(--muted);margin-top:.25rem;overflow-wrap:anywhere}',
  '.member .id a{color:var(--accent)}',
  '.member .w{color:#9c2b2b;font-size:.85rem;margin-top:.25rem}',
  'details{margin-top:.4rem}summary{cursor:pointer;color:var(--muted);font-size:.8rem}',
  'pre{background:var(--chip);border-radius:4px;padding:.6rem;overflow-x:auto;font:.76rem/1.45 var(--mono);margin:.4rem 0 0}',
  'p.none{color:var(--muted);margin:0}',
  'footer{margin-top:3rem;color:var(--muted);font-size:.8rem;border-top:1px solid var(--rule);padding-top:1rem}',
  '@media(max-width:40rem){main{padding:1.5rem 1rem 3rem}dl.meta{grid-template-columns:1fr}}',
].join('');

/** Escaped HTML. No member-controlled value is emitted as markup. */
export function renderProjectionHtml(
  result: ProjectionResult,
  options: ProjectionRenderOptions = {},
): string {
  let inlineLeft = options.maxInlineMembers ?? Number.POSITIVE_INFINITY;
  const subject = subjectOf(result);
  const organization = organizationOf(result);
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
              payload = '<div class="id"><em>full typed payload referenced, not inlined</em></div>';
            }
          }
          const withdrawal =
            member.itemState === 'withdrawn'
              ? `<div class="w">Withdrawn ${html(member.withdrawnAt ?? 'time not recorded')} — ${html(member.withdrawalReason ?? 'reason not recorded')}</div>`
              : '';
          const view = options.links?.objectView(member);
          const source = options.links?.source?.(member);
          const title = html(member.title ?? member.objectType);
          const heading =
            view === undefined
              ? `<strong>${title}</strong>`
              : `<a href="${html(view)}">${title}</a>`;
          const bytes = source === undefined ? '' : ` · <a href="${html(source)}">source</a>`;
          const classification = html(member.classification);
          return (
            `<li class="member">` +
            `<div class="t">${heading}<span class="chip">${html(typeLabel(member.objectType))}</span>` +
            `<span class="chip c-${classification}">${classification}</span></div>` +
            `<div class="id">${html(member.objectId)} · ${html(member.contentDigest.slice(0, 16))}…${bytes}</div>` +
            `${withdrawal}${payload}</li>`
          );
        })
        .join('');
      const count = String(section.members.length);
      return (
        `<section id="${html(section.id)}"><h2>${html(section.title)}<small>${count}</small></h2>` +
        `${items === '' ? '<p class="none">None.</p>' : `<ul class="members">${items}</ul>`}</section>`
      );
    })
    .join('');
  const toc = result.sections
    .map(
      (section) =>
        `<a href="#${html(section.id)}">${html(section.title)} <b>${String(section.members.length)}</b></a>`,
    )
    .join('');
  const title = `${subject.name} — master record`;
  const parameters =
    Object.keys(result.parameters).length > 0
      ? `<dt>Parameters</dt><dd>${html(canonicalize(result.parameters))}</dd>`
      : '';
  const subtitle =
    `${organization === undefined ? '' : `${html(organization)} · `}` +
    `${html(result.definition.id)} v${String(result.definition.version)} · ` +
    `${String(result.measurements.memberCount)} members`;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${html(title)}</title><style>${STYLE}</style></head><body><main>` +
    `<header><h1>${html(subject.name)}</h1><p class="sub">${subtitle}</p>` +
    `<dl class="meta"><dt>Person</dt><dd>${html(subject.id)}</dd>` +
    `<dt>Corpus digest</dt><dd>${html(result.source.corpusDigest)}</dd>` +
    `<dt>Projection digest</dt><dd>${html(result.projectionDigest)}</dd>${parameters}</dl>` +
    `<nav class="toc">${toc}</nav></header>${sections}` +
    `<footer>Every member above is exactly what this person is authorized to read at the time ` +
    `of compilation; nothing is summarized or omitted. The digests identify the corpus and ` +
    `this reading of it.</footer></main></body></html>\n`
  );
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
