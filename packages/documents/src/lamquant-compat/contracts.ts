export const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;

export const REQUIRED_TOOL_PATHS = [
  'tools/doc_tree_lint.py',
  'tools/doc_tree_lint.allow',
  'tools/scripts/check_identifier_collisions.py',
  'tools/adr_lint.py',
  'tests/contracts/architecture/test_adr_governance.py',
  '.github/workflows/audit.yml',
  'tools/doc_compose.py',
  'tools/doc_views.py',
  'tools/doc_book.py',
  'tools/doc_fm.py',
  'tools/adr_model.py',
  'tools/adr_closure_debt.toml',
] as const;

export const CODE_PREFIXES: readonly (readonly [string, string])[] = [
  ['N/', 'codec-neural/lamquant_neural/'],
  ['B/', 'training/engine/python/lamquant/'],
  ['BLQ/', 'training/cookbooks/lamquant/python/lamquant/'],
];

export interface LamQuantManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly kind?: 'file' | 'symlink';
  readonly target?: string;
}

export interface LamQuantCompatibilityOptions {
  /** Local LamQuant repository containing `commitSha`; live worktree bytes are never trusted. */
  readonly checkoutPath: string;
  /** Full, lowercase Git object identity. Branches and abbreviated SHAs are refused. */
  readonly commitSha: string;
  /** Complete expected `docs/` tree after LamQuant's builders have run. */
  readonly expectedManifest: readonly LamQuantManifestEntry[];
  /** SHA-256 identity of `{ commitSha, expectedManifest }` from `lamQuantManifestIdentity`. */
  readonly expectedManifestDigest: string;
  readonly pythonExecutable?: string;
}

export interface LamQuantSubmodulePin {
  readonly path: string;
  readonly commitSha: string;
}

export interface LamQuantSourceIdentity {
  readonly rootCommitSha: string;
  readonly submodulePins: readonly LamQuantSubmodulePin[];
  readonly materialization: 'git_objects' | 'verified_clean_worktree';
}

export interface LamQuantCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface NodeLamQuantCommandRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  /** Aggregate bound across stdout and stderr. */
  readonly maxOutputBytes?: number;
  /** Hard upper bound after forced termination before returning failure evidence. */
  readonly cleanupTimeoutMs?: number;
}

export type LamQuantCommandRunnerFailure =
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | {
      readonly kind: 'stdout_limit' | 'stderr_limit' | 'aggregate_output_limit';
      readonly limitBytes: number;
    };

export interface LamQuantCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Exact UTF-8 decoding of the bytes captured from the child; never trimmed. */
  readonly stdout: string;
  /** Exact UTF-8 decoding of the bytes captured from the child; never trimmed. */
  readonly stderr: string;
  /** Present when the process could not be spawned. */
  readonly spawnError?: string;
  /** Present when the runner terminated a process at an explicit resource boundary. */
  readonly runnerFailure?: LamQuantCommandRunnerFailure;
}

export interface LamQuantCommandRunner {
  run(request: LamQuantCommandRequest): Promise<LamQuantCommandResult>;
}

export type LamQuantPathKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other';

/** Filesystem boundary used by the oracle; injectable without mocking its own logic. */
export interface LamQuantCompatibilityFileSystem {
  kind(path: string): Promise<LamQuantPathKind>;
  makeScratchDirectory(): Promise<string>;
  makeDirectory(path: string): Promise<void>;
  copyDirectory(source: string, destination: string): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  listFiles(root: string): Promise<readonly string[]>;
  readFile(path: string): Promise<Buffer>;
  readLink(path: string): Promise<string>;
  removeTree(path: string): Promise<void>;
}

export interface LamQuantCompatibilityDependencies {
  readonly commandRunner: LamQuantCommandRunner;
  readonly fileSystem: LamQuantCompatibilityFileSystem;
  /** Optional test/adapter seam. Production uses immutable local Git objects. */
  readonly materializeCheckout?: (
    options: LamQuantCompatibilityOptions,
    scratchPath: string,
    runner: LamQuantCommandRunner,
    fileSystem: LamQuantCompatibilityFileSystem,
  ) => Promise<LamQuantSourceIdentity>;
}

export type LamQuantCompatibilityRejectionReason =
  'unpinned' | 'dirty' | 'missing_input' | 'invalid_manifest' | 'unsupported_source_contract';

export class LamQuantCompatibilityRejected extends Error {
  readonly reason: LamQuantCompatibilityRejectionReason;

  constructor(reason: LamQuantCompatibilityRejectionReason, message: string) {
    super(message);
    this.name = 'LamQuantCompatibilityRejected';
    this.reason = reason;
  }
}

export type LamQuantGateName =
  | 'doc_tree_lint'
  | 'identifier_collisions'
  | 'adr_lint'
  | 'adr_governance'
  | 'doc_compose'
  | 'doc_views'
  | 'doc_book';

export interface LamQuantGateEvidence extends LamQuantCommandResult {
  readonly tool: LamQuantGateName;
  readonly executable: string;
  readonly args: readonly string[];
}

export interface LamQuantManifestMismatch {
  readonly path: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
}

export interface LamQuantManifestParity {
  readonly matched: boolean;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly mismatched: readonly LamQuantManifestMismatch[];
}

export type LamQuantSemanticDimension =
  | 'atom_membership'
  | 'parent_output'
  | 'topics'
  | 'ledger_bindings'
  | 'deprecation'
  | 'adr_inventory'
  | 'adr_views'
  | 'traceability'
  | 'book_order';

export interface LamQuantNamedDigest {
  readonly path: string;
  readonly sha256: string;
}

export interface LamQuantSemanticProjection {
  readonly atomMembership: readonly string[];
  readonly parentOutputs: readonly LamQuantNamedDigest[];
  readonly topics: readonly string[];
  readonly topicMembership: readonly string[];
  readonly ledgerBindings: readonly string[];
  readonly deprecations: readonly string[];
  readonly adrInventory: readonly string[];
  readonly adrViews: readonly string[];
  readonly traceability: readonly string[];
  readonly bookOrder: readonly string[];
}

export interface LamQuantSemanticMismatch {
  readonly dimension: LamQuantSemanticDimension;
  readonly path?: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface LamQuantSemanticEvidence {
  readonly matched: boolean;
  readonly source: LamQuantSemanticProjection;
  readonly generated: LamQuantSemanticProjection;
  readonly mismatches: readonly LamQuantSemanticMismatch[];
}

export interface LamQuantCompatibilityReport {
  readonly commitSha: string;
  readonly sourceIdentity: LamQuantSourceIdentity;
  readonly expectedManifestDigest: string;
  readonly generatedManifestDigest: string;
  readonly manifestDigest: string;
  readonly passed: boolean;
  readonly gates: readonly LamQuantGateEvidence[];
  readonly manifest: readonly LamQuantManifestEntry[];
  readonly parity: LamQuantManifestParity;
  readonly compatibility: LamQuantSemanticEvidence;
}

export function commandSucceeded(result: LamQuantCommandResult): boolean {
  return (
    result.exitCode === 0 &&
    result.signal === null &&
    result.spawnError === undefined &&
    result.runnerFailure === undefined
  );
}
