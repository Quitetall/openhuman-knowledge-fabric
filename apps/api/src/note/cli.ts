/**
 * `kf note "<text>"` — record an observation in one gesture, over the API (ADR 0034, RQ-200/203).
 *
 * Over HTTP and not against the database, for the reason `kf master-record` gives: the API is the
 * one place a person is identified and an act is dispatched as them, and a capture surface with
 * a private path to storage is exactly what KF-SAS-RQ-203 forbids. This command reaches
 * `POST /capture/observation` — the same route the web capture form and agents use — and sends
 * the note and nothing about authority:
 *
 *   no acting role     unless you pass --acting-role; the server uses your only live assignment,
 *                      and refuses listing them if you hold several (422, printed as such)
 *   no idempotency key the server forms it from the gesture id and the note's digest. This
 *                      command sends no gesture id unless --gesture names one; the server
 *                      generates one and it is printed, so `--gesture <that id>` retries the SAME
 *                      gesture and replays instead of recording twice
 *   no version         a capture reads nothing first
 *
 * Identity is the person's own bearer token (`--token-file`, owner-only), or, on a development
 * stack only, the fixed development identity (`--identity dev`, as `kf ingest` takes it).
 */

import { readSecretFile } from '@kf/operations';

export class NoteCliError extends Error {}

export interface NoteCliArgs {
  readonly text: string;
  readonly identity: 'oidc' | 'dev';
  readonly apiOrigin?: string;
  readonly tokenFile?: string;
  readonly organizationId?: string;
  readonly actingRoleId?: string;
  readonly classification?: string;
  readonly tags: readonly string[];
  readonly subjects: readonly string[];
  readonly gestureId?: string;
  readonly observedAt?: string;
  readonly json: boolean;
}

export function noteUsage(): string {
  return [
    'kf note — record an observation in one gesture, through the API',
    '',
    '  kf note "<text>" --token-file <file> --organization <uuid> [--acting-role <uuid>] \\',
    '      [--tag <t>]... [--subject <object uuid>]... [--gesture <id>] [--observed-at <rfc3339>] \\',
    '      [--classification <id>] [--api <origin>] [--json]',
    '  kf note "<text>" --identity dev        (development stack; KF_DEV_ACTOR, KF_DEV_ORGANIZATION)',
    '',
    'No role, idempotency key or version is asked of you: the server forms them. Pass',
    '--acting-role only if you hold several assignments and the server asks which. The API origin',
    'comes from --api or KF_API_ORIGIN. A retry of the same gesture is `--gesture <printed id>`.',
  ].join('\n');
}

const REPEATABLE = new Set(['tag', 'subject']);
const KNOWN = new Set([
  'api',
  'token-file',
  'organization',
  'acting-role',
  'classification',
  'tag',
  'subject',
  'gesture',
  'observed-at',
  'identity',
]);

export function parseNoteArgs(argv: readonly string[]): NoteCliArgs {
  const values: Record<string, string> = {};
  const repeated: Record<string, string[]> = { tag: [], subject: [] };
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--help' || token === '-h') throw new NoteCliError(noteUsage());
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(token);
    if (match === null) throw new NoteCliError(`unexpected argument ${token}`);
    const name = match[1]!;
    if (!KNOWN.has(name)) throw new NoteCliError(`unknown option --${name}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new NoteCliError(`--${name} needs a value`);
    }
    if (REPEATABLE.has(name)) {
      repeated[name]!.push(value);
      continue;
    }
    if (values[name] !== undefined) throw new NoteCliError(`duplicate option --${name}`);
    values[name] = value;
  }
  if (positional.length !== 1 || positional[0]!.trim() === '') {
    throw new NoteCliError(
      positional.length === 0
        ? 'nothing to note: kf note "<text>"'
        : 'one note per gesture: quote the text as a single argument',
    );
  }
  const identity = values['identity'] ?? 'oidc';
  if (identity !== 'oidc' && identity !== 'dev') {
    throw new NoteCliError(`--identity must be oidc or dev, got ${identity}`);
  }
  const optional = (key: string, as: keyof NoteCliArgs) =>
    values[key] === undefined ? {} : { [as]: values[key] };
  return {
    text: positional[0]!,
    identity,
    tags: repeated['tag']!,
    subjects: repeated['subject']!,
    json,
    ...optional('api', 'apiOrigin'),
    ...optional('token-file', 'tokenFile'),
    ...optional('organization', 'organizationId'),
    ...optional('acting-role', 'actingRoleId'),
    ...optional('classification', 'classification'),
    ...optional('gesture', 'gestureId'),
    ...optional('observed-at', 'observedAt'),
  } as NoteCliArgs;
}

/** What `POST /capture/observation` answered. */
export interface NoteResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

type Fetch = typeof fetch;

/** The request this command sends: headers for identity, a body of the note and nothing else. */
export function noteRequest(
  args: NoteCliArgs,
  env: NodeJS.ProcessEnv,
): { readonly url: string; readonly init: RequestInit } {
  const origin = args.apiOrigin ?? env['KF_API_ORIGIN'];
  if (origin === undefined || origin.trim() === '') {
    throw new NoteCliError('no API origin: pass --api or set KF_API_ORIGIN');
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (args.identity === 'dev') {
    if (env['NODE_ENV'] !== 'development' || env['KF_ALLOW_FIXED_IDENTITY'] !== '1') {
      throw new NoteCliError(
        '--identity dev requires NODE_ENV=development and KF_ALLOW_FIXED_IDENTITY=1',
      );
    }
    const actor = env['KF_DEV_ACTOR'];
    const organization = args.organizationId ?? env['KF_DEV_ORGANIZATION'];
    if (actor === undefined || actor === '' || organization === undefined || organization === '') {
      throw new NoteCliError('--identity dev needs KF_DEV_ACTOR and KF_DEV_ORGANIZATION');
    }
    headers['x-kf-actor'] = actor;
    headers['x-kf-organization'] = organization;
  } else {
    if (args.tokenFile === undefined) throw new NoteCliError('--token-file is required');
    if (args.organizationId === undefined) throw new NoteCliError('--organization is required');
    // A bearer token is a credential: owner-only, as every other secret file here.
    let token: string;
    try {
      token = readSecretFile(args.tokenFile, '--token-file').trim();
    } catch (error: unknown) {
      throw new NoteCliError(error instanceof Error ? error.message : String(error));
    }
    if (token === '') throw new NoteCliError(`${args.tokenFile} is empty`);
    headers['authorization'] = `Bearer ${token}`;
    headers['x-kf-organization'] = args.organizationId;
  }
  // Named only when the person chose one; otherwise the server forms it (RQ-200).
  if (args.actingRoleId !== undefined) headers['x-kf-acting-role'] = args.actingRoleId;
  if (args.classification !== undefined) headers['x-kf-classification'] = args.classification;

  const body: Record<string, unknown> = { body: args.text };
  if (args.tags.length > 0) body['tags'] = [...args.tags];
  if (args.subjects.length > 0) body['subjects'] = [...args.subjects];
  if (args.gestureId !== undefined) body['gesture_id'] = args.gestureId;
  if (args.observedAt !== undefined) body['observed_at'] = args.observedAt;
  return {
    url: `${origin.replace(/\/+$/u, '')}/capture/observation`,
    init: { method: 'POST', headers, body: JSON.stringify(body) },
  };
}

export async function recordNote(
  args: NoteCliArgs,
  env: NodeJS.ProcessEnv,
  fetchImpl: Fetch = fetch,
): Promise<NoteResult> {
  const { url, init } = noteRequest(args, env);
  const response = await fetchImpl(url, init);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

function describeRefusal(result: NoteResult): string {
  const error = typeof result.body['error'] === 'string' ? result.body['error'] : 'refused';
  const message = typeof result.body['message'] === 'string' ? result.body['message'] : '';
  const lines = [
    `not recorded: ${String(result.status)} ${error}${message ? ` — ${message}` : ''}`,
  ];
  const assignments = result.body['assignments'];
  if (error === 'acting_assignment_ambiguous' && Array.isArray(assignments)) {
    lines.push('your live assignments here; pass one as --acting-role:');
    for (const a of assignments as Record<string, unknown>[]) {
      lines.push(
        `  ${String(a['assignmentId'])}  ${String(a['roleId'])}  scope ${String(a['scopeId'])}`,
      );
    }
  }
  return lines.join('\n');
}

export async function runNoteCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  output: NodeJS.WritableStream = process.stdout,
  errorOutput: NodeJS.WritableStream = process.stderr,
  fetchImpl: Fetch = fetch,
): Promise<number> {
  let args: NoteCliArgs;
  try {
    args = parseNoteArgs(argv);
  } catch (error: unknown) {
    errorOutput.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const result = await recordNote(args, env, fetchImpl);
    if (args.json) output.write(`${JSON.stringify(result.body)}\n`);
    if (result.status !== 200 && result.status !== 201) {
      errorOutput.write(`${describeRefusal(result)}\n`);
      return result.status === 422 || result.status === 400 ? 2 : 1;
    }
    if (!args.json) {
      const b = result.body;
      const verification = (b['verification'] ?? {}) as Record<string, unknown>;
      output.write(
        [
          `${result.status === 200 ? 'already recorded (gesture replayed)' : 'recorded'}: ` +
            `observation ${String(b['observationId'])}`,
          `  state        ${String(b['lifecycleState'])}`,
          `  verification ${String(verification['label'])}`,
          `  acting as    ${String(b['actingRoleId'])}`,
          `  act          ${String(b['actionId'])}`,
          `  gesture      ${String(b['gestureId'])}  (retry with --gesture ${String(b['gestureId'])})`,
        ].join('\n') + '\n',
      );
    }
    return 0;
  } catch (error: unknown) {
    errorOutput.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof NoteCliError ? 2 : 1;
  }
}
