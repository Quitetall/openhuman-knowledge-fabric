/**
 * `kf master-record` — compile and fetch one person's master record, over the API.
 *
 * Over HTTP and not against the database, on purpose. The master record is the reading a
 * person is authorized to have, and the API is the one place that reading is made: identity
 * from a verified token, clearance resolved, the corpus enumerated under row-level security, the
 * completeness claim recorded as an act. A command that reached past the API to the database
 * would be a second way of answering "what may this person see", and two ways is one too many.
 *
 * So this needs what any caller needs: the API origin, a bearer token for the person, the
 * organization and the role assignment they act under. It does three requests — compile, read
 * the claim, render the projection — and writes what came back, unmodified.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface MasterRecordCliArgs {
  readonly apiOrigin?: string;
  readonly tokenFile?: string;
  readonly organizationId?: string;
  readonly actingRoleId?: string;
  readonly classification?: string;
  readonly projection: string;
  readonly format: 'html' | 'markdown' | 'json';
  readonly out?: string;
  readonly reason?: string;
  readonly compile: boolean;
}

export class MasterRecordCliError extends Error {}

export function masterRecordUsage(): string {
  return [
    "kf master-record — compile and fetch a person's master record through the API",
    '',
    '  kf master-record --token-file <file> --organization <uuid> --acting-role <uuid> \\',
    '      [--classification <id>] [--api <origin>] [--projection master_sections] \\',
    '      [--format html|markdown|json] [--out <path>] [--reason <text>] [--no-compile]',
    '',
    "The API origin comes from --api or KF_API_ORIGIN. The token is the person's own bearer",
    "token (see scripts/deploy/login-token.sh); the record is theirs and nobody else's.",
    'Without --out the rendering is written to stdout, byte for byte as the API returned it.',
  ].join('\n');
}

export function parseMasterRecordArgs(argv: readonly string[]): MasterRecordCliArgs {
  const values: Record<string, string> = {};
  let compile = true;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--no-compile') {
      compile = false;
      continue;
    }
    if (token === '--help' || token === '-h') throw new MasterRecordCliError(masterRecordUsage());
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (match === null) throw new MasterRecordCliError(`unexpected argument ${token}`);
    const name = match[1]!;
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new MasterRecordCliError(`--${name} needs a value`);
    }
    if (values[name] !== undefined) throw new MasterRecordCliError(`duplicate option --${name}`);
    values[name] = value;
  }
  const known = new Set([
    'api',
    'token-file',
    'organization',
    'acting-role',
    'classification',
    'projection',
    'format',
    'out',
    'reason',
  ]);
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new MasterRecordCliError(`unknown option --${key}`);
  }
  const format = values['format'] ?? 'html';
  if (format !== 'html' && format !== 'markdown' && format !== 'json') {
    throw new MasterRecordCliError(`--format must be html, markdown or json, got ${format}`);
  }
  const apiOrigin = values['api'];
  const tokenFile = values['token-file'];
  const organizationId = values['organization'];
  const actingRoleId = values['acting-role'];
  const classification = values['classification'];
  const out = values['out'];
  const reason = values['reason'];
  return {
    ...(apiOrigin === undefined ? {} : { apiOrigin }),
    ...(tokenFile === undefined ? {} : { tokenFile }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(actingRoleId === undefined ? {} : { actingRoleId }),
    ...(classification === undefined ? {} : { classification }),
    projection: values['projection'] ?? 'master_sections',
    format,
    ...(out === undefined ? {} : { out }),
    ...(reason === undefined ? {} : { reason }),
    compile,
  };
}

export interface MasterRecordCompileOutcome {
  readonly status: number;
  readonly actionId?: string;
  readonly reused?: boolean;
}

export interface MasterRecordFetchResult {
  readonly compiled: MasterRecordCompileOutcome | undefined;
  readonly record: Record<string, unknown>;
  readonly rendering: {
    readonly bytes: Buffer;
    readonly mediaType: string;
    readonly projectionDigest: string;
    readonly corpusDigest: string;
  };
}

type Fetch = typeof fetch;

export async function fetchMasterRecord(
  args: MasterRecordCliArgs,
  env: NodeJS.ProcessEnv,
  fetchImpl: Fetch = fetch,
): Promise<MasterRecordFetchResult> {
  const origin = args.apiOrigin ?? env['KF_API_ORIGIN'];
  if (origin === undefined || origin.trim() === '') {
    throw new MasterRecordCliError('no API origin: pass --api or set KF_API_ORIGIN');
  }
  if (args.tokenFile === undefined) throw new MasterRecordCliError('--token-file is required');
  if (args.organizationId === undefined) {
    throw new MasterRecordCliError('--organization is required');
  }
  if (args.actingRoleId === undefined) throw new MasterRecordCliError('--acting-role is required');

  const token = (await readFile(args.tokenFile, 'utf8')).trim();
  if (token === '') throw new MasterRecordCliError(`${args.tokenFile} is empty`);

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'x-kf-organization': args.organizationId,
    'x-kf-acting-role': args.actingRoleId,
    ...(args.classification === undefined ? {} : { 'x-kf-classification': args.classification }),
  };
  const base = origin.replace(/\/+$/, '');

  let compiled: MasterRecordCompileOutcome | undefined;
  if (args.compile) {
    const day = new Date().toISOString().slice(0, 10);
    const idempotencyKey = createHash('sha256')
      .update(`kf-master-record:${args.organizationId}:${args.actingRoleId}:${day}`)
      .digest('hex');
    const response = await fetchImpl(`${base}/master-record/compile`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey,
        ...(args.reason === undefined ? {} : { reason: args.reason }),
      }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status !== 200 && response.status !== 201) {
      throw new MasterRecordCliError(`compile refused: ${response.status} ${JSON.stringify(body)}`);
    }
    compiled = {
      status: response.status,
      ...(typeof body['actionId'] === 'string' ? { actionId: body['actionId'] } : {}),
      ...(typeof body['reused'] === 'boolean' ? { reused: body['reused'] } : {}),
    };
  }

  const recordResponse = await fetchImpl(`${base}/master-record`, { headers });
  const record = (await recordResponse.json().catch(() => ({}))) as Record<string, unknown>;
  if (recordResponse.status !== 200) {
    throw new MasterRecordCliError(
      `no master record: ${recordResponse.status} ${JSON.stringify(record)}`,
    );
  }

  const rendered = await fetchImpl(
    `${base}/master-record/projections/${encodeURIComponent(args.projection)}?format=${args.format}`,
    { headers },
  );
  if (rendered.status !== 200) {
    const detail = await rendered.text().catch(() => '');
    throw new MasterRecordCliError(`projection refused: ${rendered.status} ${detail}`);
  }
  const bytes = Buffer.from(await rendered.arrayBuffer());
  return {
    compiled,
    record,
    rendering: {
      bytes,
      mediaType: rendered.headers.get('content-type') ?? '',
      projectionDigest: rendered.headers.get('x-kf-projection-digest') ?? '',
      corpusDigest: rendered.headers.get('x-kf-corpus-digest') ?? '',
    },
  };
}

export async function runMasterRecordCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  try {
    const args = parseMasterRecordArgs(argv);
    const result = await fetchMasterRecord(args, env);
    if (result.compiled !== undefined) {
      const reused = result.compiled.reused === true ? ' (corpus unchanged, claim reused)' : '';
      errorOutput.write(`compile: ${result.compiled.status}${reused}\n`);
    }
    errorOutput.write(`corpus digest:     ${result.rendering.corpusDigest}\n`);
    errorOutput.write(`projection digest: ${result.rendering.projectionDigest}\n`);
    if (args.out === undefined) {
      output.write(result.rendering.bytes);
    } else {
      const path = resolve(args.out);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, result.rendering.bytes);
      errorOutput.write(`wrote ${path} (${result.rendering.bytes.length} bytes)\n`);
    }
    return 0;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    errorOutput.write(`${detail}\n`);
    return error instanceof MasterRecordCliError ? 2 : 1;
  }
}
