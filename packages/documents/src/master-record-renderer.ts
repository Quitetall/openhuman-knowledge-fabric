import { spawn } from 'node:child_process';
import { digestBytes } from '@kf/canonicalization';
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

function renderMemberMarkdown(member: PermissionMember): string {
  const title = member.title === undefined ? member.objectType : member.title;
  return `- **${markdownText(title)}** — ${classificationLine(member)}`;
}

function renderMembersMarkdown(title: string, members: readonly PermissionMember[]): string[] {
  const sorted = [...members].sort(memberSort);
  return [
    `## ${title}`,
    '',
    ...(sorted.length === 0 ? ['_None._'] : sorted.map(renderMemberMarkdown)),
    '',
  ];
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
export function renderMasterRecordMarkdown(input: MasterRecordCompilation): string {
  assertRenderingCompleteness(input);
  const { manifest } = input;
  const lines = [
    `# Master record for ${markdownText(manifest.personId)}`,
    '',
    `- Format: \`${manifest.format}\``,
    `- Organization: \`${markdownText(manifest.organizationId)}\``,
    `- Compiled at: \`${markdownText(manifest.compiledAt)}\``,
    `- Permission digest: \`${manifest.permissionDigest}\``,
    '',
    ...renderMembersMarkdown('Your record', input.relevant),
    ...renderMembersMarkdown('Organization view', input.organizationView),
    ...renderMembersMarkdown('Withdrawn', manifest.withdrawn),
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

function htmlMember(member: PermissionMember): string {
  const title = member.title === undefined ? member.objectType : member.title;
  return `<li><strong>${htmlText(title)}</strong> — ${htmlText(member.objectType)} — ${htmlText(member.classification)} — <code>${htmlText(member.objectId)}</code> <small>${htmlText(member.contentDigest)}</small></li>`;
}

function htmlSection(title: string, members: readonly PermissionMember[]): string {
  const body = [...members].sort(memberSort).map(htmlMember).join('');
  return `<section><h2>${htmlText(title)}</h2>${body === '' ? '<p><em>None.</em></p>' : `<ul>${body}</ul>`}</section>`;
}

/** Escaped HTML projection. No caller-controlled value is emitted as markup. */
export function renderMasterRecordHtml(input: MasterRecordCompilation): string {
  assertRenderingCompleteness(input);
  const manifest = input.manifest;
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
    withheldItems || thirdParty
      ? `<ul>${withheldItems}${thirdParty}</ul>`
      : '<p><em>None.</em></p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Master record ${htmlText(manifest.personId)}</title></head><body><main><h1>Master record for ${htmlText(manifest.personId)}</h1><dl><dt>Format</dt><dd><code>${htmlText(manifest.format)}</code></dd><dt>Organization</dt><dd><code>${htmlText(manifest.organizationId)}</code></dd><dt>Compiled at</dt><dd><code>${htmlText(manifest.compiledAt)}</code></dd><dt>Permission digest</dt><dd><code>${htmlText(manifest.permissionDigest)}</code></dd></dl>${htmlSection('Your record', input.relevant)}${htmlSection('Organization view', input.organizationView)}${htmlSection('Withdrawn', manifest.withdrawn)}<section><h2>Withheld</h2>${withheld}</section></main></body></html>\n`;
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
  const markdown = renderMasterRecordMarkdown(input);
  const bytes =
    target === 'markdown'
      ? Buffer.from(markdown, 'utf8')
      : target === 'html'
        ? Buffer.from(renderMasterRecordHtml(input), 'utf8')
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
