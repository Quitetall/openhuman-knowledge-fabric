import { spawn } from 'node:child_process';
import { canonicalize, digestBytes } from '@kf/canonicalization';
import type {
  MasterRecordCompilation,
  MasterRecordManifest,
  PermissionMember,
} from './master-record.js';

export type MasterRecordRenderTarget = 'markdown' | 'html' | 'pdf' | 'docx';

export interface RenderedMasterRecord {
  readonly target: MasterRecordRenderTarget;
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly contentDigest: string;
}

export interface MasterRecordRenderOptions {
  /** Injectable for tests and pinned host runtimes; defaults to the `pandoc` on PATH. */
  readonly pandocExecutable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Maximum number of members whose full payload is inlined. Membership is never reduced. */
  readonly maxInlineMembers?: number;
}

function manifestMeasurements(
  manifest: MasterRecordManifest,
  input: MasterRecordCompilation,
): NonNullable<MasterRecordManifest['measurements']> {
  return (
    manifest.measurements ?? {
      permissionMemberCount: manifest.included.length,
      relevantMemberCount: input.relevant.length,
      organizationViewMemberCount: input.organizationView.length,
      relevanceFanoutByPropagationClass: {},
    }
  );
}

const MEDIA_TYPES: Readonly<Record<MasterRecordRenderTarget, string>> = {
  markdown: 'text/markdown',
  html: 'text/html',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const DEFAULT_PANDOC_TIMEOUT_MS = 30_000;
const DEFAULT_PANDOC_OUTPUT_BYTES = 64 * 1024 * 1024;

function memberSort(left: PermissionMember, right: PermissionMember): number {
  return `${left.objectId}\u0000${left.objectType}\u0000${left.contentDigest}`.localeCompare(
    `${right.objectId}\u0000${right.objectType}\u0000${right.contentDigest}`,
    'en',
    { sensitivity: 'variant' },
  );
}

function safeText(value: string): string {
  return value
    .replaceAll(String.fromCharCode(0), ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function markdownText(value: string): string {
  return safeText(value).replace(/([\\`*_[\]{}<>#])/g, '\\$1');
}

function htmlText(value: string): string {
  return safeText(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

function classificationLine(member: PermissionMember): string {
  return `${markdownText(member.objectType)} — ${markdownText(member.classification)} — ${markdownText(member.objectId)} (${markdownText(member.contentDigest)})`;
}

function renderMemberMarkdown(member: PermissionMember, inlineContent: boolean): string[] {
  const title = member.title === undefined ? member.objectType : member.title;
  const lines = [`- **${markdownText(title)}** — ${classificationLine(member)}`];
  if (member.withdrawnAt !== undefined || member.withdrawalReason !== undefined) {
    lines.push(
      `  - Withdrawal: ${markdownText(member.withdrawnAt ?? 'time not recorded')} — ${markdownText(member.withdrawalReason ?? 'reason not recorded')}`,
    );
  }
  if (inlineContent && member.content !== undefined && Object.keys(member.content).length > 0) {
    lines.push('  ```json', `  ${canonicalize(member.content)}`, '  ```');
  }
  return lines;
}

function renderMembersMarkdown(
  title: string,
  members: readonly PermissionMember[],
  budget: { remaining: number; readonly limit: number },
): { readonly lines: string[]; readonly referenced: PermissionMember[] } {
  const sorted = [...members].sort(memberSort);
  const lines = [`## ${title}`, ''];
  const referenced: PermissionMember[] = [];
  if (sorted.length === 0) {
    lines.push('_None._');
  } else {
    for (const member of sorted) {
      const inline = budget.remaining > 0;
      if (inline) budget.remaining -= 1;
      else referenced.push(member);
      if (inline) {
        lines.push(...renderMemberMarkdown(member, true));
      } else {
        lines.push(
          `- **${markdownText(member.title ?? member.objectType)}** — referenced because inline ` +
            `ceiling ${String(budget.limit)} was reached — ${classificationLine(member)}`,
        );
      }
    }
  }
  lines.push('');
  return { lines, referenced };
}

function assertRenderingCompleteness(input: MasterRecordCompilation): void {
  const included = new Set(input.manifest.included.map((member) => member.objectId));
  const rendered = new Set([
    ...input.relevant.map((member) => member.objectId),
    ...input.organizationView.map((member) => member.objectId),
  ]);
  if (
    rendered.size !== included.size ||
    [...included].some((objectId) => !rendered.has(objectId)) ||
    [...rendered].some((objectId) => !included.has(objectId))
  ) {
    throw new Error('master-record rendering sections do not cover every included member');
  }
}

/** Deterministic human-readable projection. Membership is never reduced for presentation. */
export function renderMasterRecordMarkdown(
  input: MasterRecordCompilation,
  options: Pick<MasterRecordRenderOptions, 'maxInlineMembers'> = {},
): string {
  assertRenderingCompleteness(input);
  const maxInlineMembers = options.maxInlineMembers ?? Number.POSITIVE_INFINITY;
  if (
    maxInlineMembers !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxInlineMembers) || maxInlineMembers < 0)
  ) {
    throw new Error('master-record inline member ceiling must be a non-negative integer');
  }
  const budget = { remaining: maxInlineMembers, limit: maxInlineMembers };
  const yourRecord = renderMembersMarkdown('Your record', input.relevant, budget);
  const organizationView = renderMembersMarkdown(
    'Organization view',
    input.organizationView,
    budget,
  );
  const withdrawn = renderMembersMarkdown('Withdrawn', input.manifest.withdrawn, budget);
  const referenced = [
    ...yourRecord.referenced,
    ...organizationView.referenced,
    ...withdrawn.referenced,
  ];
  const { manifest } = input;
  const measurements = manifestMeasurements(manifest, input);
  const lines = [
    `# Master record for ${markdownText(manifest.personId)}`,
    '',
    `- Format: \`${manifest.format}\``,
    `- Organization: \`${markdownText(manifest.organizationId)}\``,
    `- Compiled at: \`${markdownText(manifest.compiledAt)}\``,
    `- Permission digest: \`${manifest.permissionDigest}\``,
    `- Permission members: \`${String(measurements.permissionMemberCount)}\``,
    `- Relevance members: \`${String(measurements.relevantMemberCount)}\``,
    ...(Number.isFinite(maxInlineMembers)
      ? [
          `- Inline content ceiling: \`${String(maxInlineMembers)}\`; referenced members retain full content in the manifest.`,
        ]
      : []),
    '',
    ...yourRecord.lines,
    ...organizationView.lines,
    ...withdrawn.lines,
    ...(referenced.length > 0
      ? [
          '## Referenced content',
          '',
          ...referenced.map(
            (member) =>
              `- ${classificationLine(member)} — full typed payload remains in the manifest`,
          ),
          '',
        ]
      : []),
    '## Withheld',
    '',
  ];
  if (
    manifest.withheld.items.length === 0 &&
    Object.keys(manifest.withheld.thirdPartyCounts).length === 0
  ) {
    lines.push('_None._', '');
  } else {
    for (const item of manifest.withheld.items) {
      lines.push(
        `- **${markdownText(item.reasonClass)}** — ${markdownText(item.reason)} — ${markdownText(item.objectId)} — authorizer ${markdownText(item.authorizer)} — ${markdownText(item.withheldAt)}`,
      );
    }
    for (const [reason, count] of Object.entries(manifest.withheld.thirdPartyCounts).sort(
      ([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'variant' }),
    )) {
      lines.push(`- **${markdownText(reason)}** — ${String(count)} item(s)`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function htmlMember(member: PermissionMember, inlineContent: boolean): string {
  const title = member.title === undefined ? member.objectType : member.title;
  const content =
    inlineContent && member.content !== undefined && Object.keys(member.content).length > 0
      ? `<details><summary>Full typed payload</summary><pre>${htmlText(canonicalize(member.content))}</pre></details>`
      : '';
  const withdrawal =
    member.withdrawnAt !== undefined || member.withdrawalReason !== undefined
      ? `<div>Withdrawal: ${htmlText(member.withdrawnAt ?? 'time not recorded')} — ${htmlText(member.withdrawalReason ?? 'reason not recorded')}</div>`
      : '';
  return `<li><strong>${htmlText(title)}</strong> — ${htmlText(member.objectType)} — ${htmlText(member.classification)} — <code>${htmlText(member.objectId)}</code> <small>${htmlText(member.contentDigest)}</small>${withdrawal}${content}</li>`;
}

function htmlSection(
  title: string,
  members: readonly PermissionMember[],
  budget: { remaining: number; readonly limit: number },
): { readonly html: string; readonly referenced: PermissionMember[] } {
  const referenced: PermissionMember[] = [];
  const body = [...members]
    .sort(memberSort)
    .map((member) => {
      const inline = budget.remaining > 0;
      if (inline) budget.remaining -= 1;
      else referenced.push(member);
      return inline
        ? htmlMember(member, true)
        : `<li><strong>${htmlText(member.title ?? member.objectType)}</strong> — referenced because inline ceiling ${String(budget.limit)} was reached — ${htmlText(member.objectType)} — <code>${htmlText(member.objectId)}</code> <small>${htmlText(member.contentDigest)}</small></li>`;
    })
    .join('');
  return {
    html: `<section><h2>${htmlText(title)}</h2>${body === '' ? '<p><em>None.</em></p>' : `<ul>${body}</ul>`}</section>`,
    referenced,
  };
}

/** Escaped HTML projection. No caller-controlled value is emitted as markup. */
export function renderMasterRecordHtml(
  input: MasterRecordCompilation,
  options: Pick<MasterRecordRenderOptions, 'maxInlineMembers'> = {},
): string {
  assertRenderingCompleteness(input);
  const maxInlineMembers = options.maxInlineMembers ?? Number.POSITIVE_INFINITY;
  if (
    maxInlineMembers !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxInlineMembers) || maxInlineMembers < 0)
  ) {
    throw new Error('master-record inline member ceiling must be a non-negative integer');
  }
  const budget = { remaining: maxInlineMembers, limit: maxInlineMembers };
  const yourRecord = htmlSection('Your record', input.relevant, budget);
  const organizationView = htmlSection('Organization view', input.organizationView, budget);
  const withdrawn = htmlSection('Withdrawn', input.manifest.withdrawn, budget);
  const referenced = [
    ...yourRecord.referenced,
    ...organizationView.referenced,
    ...withdrawn.referenced,
  ];
  const manifest = input.manifest;
  const measurements = manifestMeasurements(manifest, input);
  const withheldItems = manifest.withheld.items
    .map(
      (item) =>
        `<li><strong>${htmlText(item.reasonClass)}</strong> — ${htmlText(item.reason)} — <code>${htmlText(item.objectId)}</code> — ${htmlText(item.withheldAt)}</li>`,
    )
    .join('');
  const thirdParty = Object.entries(manifest.withheld.thirdPartyCounts)
    .sort(([a], [b]) => a.localeCompare(b, 'en', { sensitivity: 'variant' }))
    .map(
      ([reason, count]) =>
        `<li><strong>${htmlText(reason)}</strong> — ${String(count)} item(s)</li>`,
    )
    .join('');
  const withheld =
    withheldItems.length > 0 || thirdParty !== ''
      ? `<ul>${withheldItems}${thirdParty}</ul>`
      : '<p><em>None.</em></p>';
  const referencedHtml =
    referenced.length === 0
      ? ''
      : `<section><h2>Referenced content</h2><ul>${referenced
          .map(
            (member) =>
              `<li>${htmlText(member.objectType)} — <code>${htmlText(member.objectId)}</code> — full typed payload remains in the manifest</li>`,
          )
          .join('')}</ul></section>`;
  const ceiling = Number.isFinite(maxInlineMembers)
    ? `<dt>Inline content ceiling</dt><dd>${String(maxInlineMembers)}; referenced members retain full content in the manifest</dd>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Master record ${htmlText(manifest.personId)}</title></head><body><main><h1>Master record for ${htmlText(manifest.personId)}</h1><dl><dt>Format</dt><dd><code>${htmlText(manifest.format)}</code></dd><dt>Organization</dt><dd><code>${htmlText(manifest.organizationId)}</code></dd><dt>Compiled at</dt><dd><code>${htmlText(manifest.compiledAt)}</code></dd><dt>Permission digest</dt><dd><code>${htmlText(manifest.permissionDigest)}</code></dd><dt>Permission members</dt><dd>${String(measurements.permissionMemberCount)}</dd><dt>Relevance members</dt><dd>${String(measurements.relevantMemberCount)}</dd>${ceiling}</dl>${yourRecord.html}${organizationView.html}${withdrawn.html}${referencedHtml}<section><h2>Withheld</h2>${withheld}</section></main></body></html>\n`;
}

function pandocOutput(
  markdown: string,
  target: 'pdf' | 'docx',
  options: MasterRecordRenderOptions,
): Promise<Buffer> {
  const executable = options.pandocExecutable ?? 'pandoc';
  const timeoutMs = options.timeoutMs ?? DEFAULT_PANDOC_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PANDOC_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('master-record Pandoc timeout must be a positive integer'));
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(
      new Error('master-record Pandoc output limit must be a positive integer'),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--from=gfm', `--to=${target}`, '--standalone'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`pandoc ${target} conversion timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (error: Error | undefined, bytes?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(bytes!);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new Error(`pandoc ${target} output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', (error) =>
      finish(new Error(`pandoc ${target} could not start`, { cause: error })),
    );
    child.once('close', (code) => {
      if (code !== 0) {
        finish(
          new Error(
            `pandoc ${target} exited ${String(code)}: ${Buffer.concat(errors).toString('utf8').trim()}`,
          ),
        );
        return;
      }
      finish(undefined, Buffer.concat(output));
    });
    child.stdin.end(markdown, 'utf8');
  });
}

/** Render one canonical compilation to any plan-approved target. */
export async function renderMasterRecord(
  input: MasterRecordCompilation,
  target: MasterRecordRenderTarget,
  options: MasterRecordRenderOptions = {},
): Promise<RenderedMasterRecord> {
  const markdown = renderMasterRecordMarkdown(input, options);
  const bytes =
    target === 'markdown'
      ? Buffer.from(markdown, 'utf8')
      : target === 'html'
        ? Buffer.from(renderMasterRecordHtml(input, options), 'utf8')
        : await pandocOutput(markdown, target, options);
  return { target, mediaType: MEDIA_TYPES[target], bytes, contentDigest: digestBytes(bytes) };
}

/** Build a compilation shell from a persisted manifest when a renderer runs outside compiler code. */
export function compilationFromManifest(manifest: MasterRecordManifest): MasterRecordCompilation {
  const yourRecord = new Set(manifest.sections.yourRecord);
  const organizationView = new Set(manifest.sections.organizationView);
  const assigned = new Set([...yourRecord, ...organizationView]);
  if (
    assigned.size !== manifest.included.length ||
    manifest.included.some((member) => !assigned.has(member.objectId))
  ) {
    throw new Error('master-record manifest sections do not cover every included member');
  }
  return {
    manifest,
    relevant: manifest.included.filter((member) => yourRecord.has(member.objectId)),
    organizationView: manifest.included.filter((member) => organizationView.has(member.objectId)),
  };
}
