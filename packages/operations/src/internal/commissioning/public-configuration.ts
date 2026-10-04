import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { CommissioningStatus } from './contracts.js';

const ROLES = ['api', 'worker', 'attestor', 'checkpoint', 'storage', 'readiness'] as const;
type Role = (typeof ROLES)[number];
interface Fields {
  readonly public: readonly string[];
  readonly required: readonly string[];
}
type Catalog = Readonly<Record<Role, Fields>>;
function refuse(): never {
  throw new Error('public configuration refused');
}
export function publicConfigurationRole(unit: string, path: string): Role | null {
  return (
    ROLES.find(
      (role) => unit === `kf-${role}.service` && path === `/etc/kf/application-public/${role}.env`,
    ) ?? null
  );
}
/** Bounded, no-follow file read. Called only for declared public data, never secret paths. */
async function publicFile(path: string): Promise<Record<string, unknown>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 65536) refuse();
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (
      length > 65536 ||
      length !== after.size ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino ||
      before.dev !== after.dev
    )
      refuse();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    return {
      text,
      uid: after.uid,
      mode: after.mode,
      nlink: after.nlink,
      regular: after.isFile(),
      size: after.size,
    };
  } finally {
    await file.close();
  }
}
export const observePublicConfiguration = publicFile;

/** Same data atom the fixed application launcher imports; never load arbitrary JS here. */
export async function publicConfigurationCatalog(shippedDirectory: string): Promise<Catalog> {
  const file = await publicFile(join(shippedDirectory, 'application-public-fields.json'));
  const parsed: unknown = JSON.parse(file.text as string);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify([...ROLES].sort())
  )
    refuse();
  for (const role of ROLES) {
    const spec = (parsed as Record<string, unknown>)[role];
    if (
      typeof spec !== 'object' ||
      spec === null ||
      JSON.stringify(Object.keys(spec).sort()) !== '["public","required"]'
    )
      refuse();
    const fields = spec as Record<string, unknown>;
    for (const key of ['public', 'required']) {
      const names = fields[key];
      if (
        !Array.isArray(names) ||
        names.length > 64 ||
        new Set(names).size !== names.length ||
        names.some((name) => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name))
      )
        refuse();
    }
    if ((fields.required as string[]).some((name) => !(fields.public as string[]).includes(name)))
      refuse();
  }
  return parsed as Catalog;
}
function publicValue(name: string, value: string): void {
  if (!value.length || value.length > 8192 || /[^\x20-\x7e]/.test(value)) refuse();
  if (
    name.endsWith('_ENDPOINT') ||
    name.endsWith('_URL') ||
    name.endsWith('_ORIGIN') ||
    name === 'OIDC_ISSUER' ||
    name === 'OIDC_JWKS_URI'
  ) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    )
      refuse();
  }
  if (name.endsWith('_SOCKET') || name.endsWith('_PATH') || name.endsWith('_KEY_DIR')) {
    if (
      !isAbsolute(value) ||
      resolve(value) !== value ||
      value === '/' ||
      /[^\x21-\x7e]/.test(value)
    )
      refuse();
  }
}
/** Closed systemd EnvironmentFile subset: no escapes, continuations, duplicates or unknowns. */
export function publicConfigurationVerdict(
  value: unknown,
  role: Role,
  catalog: Catalog,
): { status: CommissioningStatus; reason: string } {
  try {
    if (typeof value !== 'object' || value === null) refuse();
    const v = value as Record<string, unknown>;
    if (
      typeof v.text !== 'string' ||
      v.text.length > 65536 ||
      !Number.isSafeInteger(v.uid) ||
      !Number.isSafeInteger(v.mode) ||
      !Number.isSafeInteger(v.size)
    )
      refuse();
    if (v.uid !== 0 || ((v.mode as number) & 0o7022) !== 0 || v.nlink !== 1 || v.regular !== true)
      return {
        status: 'unsatisfied',
        reason:
          'public configuration must be root-owned, single-link, regular and not writable beyond root',
      };
    if (Buffer.byteLength(v.text) !== v.size) refuse();
    const fields = catalog[role];
    const found = new Set<string>();
    for (const line of v.text.split('\n')) {
      if (!line.trim() || /^\s*[#;]/.test(line)) continue;
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!match || !fields.public.includes(match[1]!) || found.has(match[1]!)) refuse();
      const name = match[1]!;
      let content = match[2]!;
      if (/^['"]/.test(content)) {
        if (content.at(-1) !== content[0]) refuse();
        content = content.slice(1, -1);
      }
      // Deliberately stricter than shell syntax, and equivalent to the systemd subset used here.
      if (/[\\'"\r\t]/.test(content) || content !== content.trim()) refuse();
      publicValue(name, content);
      found.add(name);
    }
    if (fields.required.some((name) => !found.has(name))) refuse();
    return { status: 'satisfied', reason: 'closed public field contract checked' };
  } catch {
    return {
      status: 'unverifiable',
      reason: 'public configuration or closed field contract could not be established',
    };
  }
}
