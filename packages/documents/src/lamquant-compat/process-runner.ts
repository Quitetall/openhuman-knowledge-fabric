import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_STDERR_BYTES,
  DEFAULT_MAX_STDOUT_BYTES,
  type LamQuantCommandResult,
  type LamQuantCommandRunner,
  type LamQuantCommandRunnerFailure,
  type NodeLamQuantCommandRunnerOptions,
} from './contracts.js';

function positiveCommandLimit(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return selected;
}

interface RunnerLimits {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxOutputBytes: number;
  readonly cleanupTimeoutMs: number;
}

function runnerLimits(options: NodeLamQuantCommandRunnerOptions): RunnerLimits {
  return {
    timeoutMs: positiveCommandLimit(options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, 'timeoutMs'),
    maxStdoutBytes: positiveCommandLimit(
      options.maxStdoutBytes,
      DEFAULT_MAX_STDOUT_BYTES,
      'maxStdoutBytes',
    ),
    maxStderrBytes: positiveCommandLimit(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      'maxStderrBytes',
    ),
    maxOutputBytes: positiveCommandLimit(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    ),
    cleanupTimeoutMs: positiveCommandLimit(
      options.cleanupTimeoutMs,
      DEFAULT_CLEANUP_TIMEOUT_MS,
      'cleanupTimeoutMs',
    ),
  };
}

interface CaptureState {
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  outputBytes: number;
}

function capturedOutput(state: CaptureState): Pick<LamQuantCommandResult, 'stdout' | 'stderr'> {
  return {
    stdout: Buffer.concat(state.stdout, state.stdoutBytes).toString('utf8'),
    stderr: Buffer.concat(state.stderr, state.stderrBytes).toString('utf8'),
  };
}

class NodeLamQuantProcessRun {
  private readonly supportsProcessGroups = process.platform !== 'win32';
  private readonly state: CaptureState = {
    stdout: [],
    stderr: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    outputBytes: 0,
  };
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private settled = false;
  private runnerFailure: LamQuantCommandRunnerFailure | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly limits: RunnerLimits,
    private readonly resolve: (result: LamQuantCommandResult) => void,
  ) {}

  start(executable: string, args: readonly string[], cwd: string): void {
    try {
      this.child = spawn(executable, [...args], {
        cwd,
        detached: this.supportsProcessGroups,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      this.finish({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.bindChild();
  }

  private bindChild(): void {
    const child = this.child;
    if (child === undefined) return;
    child.stdout.on('data', (chunk: Buffer) => this.capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.capture('stderr', chunk));
    child.once('error', (error) => this.onError(error));
    child.once('close', (exitCode, signal) => this.onClose(exitCode, signal));
    this.timeoutTimer = setTimeout(
      () => this.stopFor({ kind: 'timeout', timeoutMs: this.limits.timeoutMs }),
      this.limits.timeoutMs,
    );
  }

  private finish(result: LamQuantCommandResult): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timeoutTimer !== undefined) clearTimeout(this.timeoutTimer);
    if (this.cleanupTimer !== undefined) clearTimeout(this.cleanupTimer);
    this.resolve(result);
  }

  private finishRunnerFailure(
    exitCode: number | null = null,
    signal: NodeJS.Signals | null = null,
  ) {
    if (this.runnerFailure === undefined) return;
    this.finish({
      exitCode,
      signal,
      ...capturedOutput(this.state),
      runnerFailure: this.runnerFailure,
    });
  }

  private onError(error: Error): void {
    if (this.runnerFailure !== undefined) {
      this.finishRunnerFailure();
      return;
    }
    this.finish({
      exitCode: null,
      signal: null,
      ...capturedOutput(this.state),
      spawnError: error.message,
    });
  }

  private onClose(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.runnerFailure !== undefined) {
      this.finishRunnerFailure(exitCode, signal);
      return;
    }
    this.finish({ exitCode, signal, ...capturedOutput(this.state) });
  }

  private killTree(): void {
    const child = this.child;
    if (child === undefined) return;
    child.stdout.destroy();
    child.stderr.destroy();
    if (this.supportsProcessGroups && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
        return;
      } catch {
        // Process may have exited while descendants still held pipes; direct kill is fallback.
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Cleanup timer still bounds completion when target disappeared concurrently.
    }
  }

  private stopFor(failure: LamQuantCommandRunnerFailure): void {
    if (this.settled || this.runnerFailure !== undefined) return;
    this.runnerFailure = failure;
    this.killTree();
    this.cleanupTimer = setTimeout(() => this.finishRunnerFailure(), this.limits.cleanupTimeoutMs);
  }

  private capture(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (this.settled || this.runnerFailure !== undefined) return;
    const streamBytes = stream === 'stdout' ? this.state.stdoutBytes : this.state.stderrBytes;
    const streamLimit =
      stream === 'stdout' ? this.limits.maxStdoutBytes : this.limits.maxStderrBytes;
    const streamRemaining = streamLimit - streamBytes;
    const aggregateRemaining = this.limits.maxOutputBytes - this.state.outputBytes;
    const acceptedBytes = Math.min(chunk.byteLength, streamRemaining, aggregateRemaining);
    this.acceptOutput(stream, chunk, acceptedBytes);
    if (acceptedBytes === chunk.byteLength) return;
    this.stopFor(
      streamRemaining <= aggregateRemaining
        ? { kind: stream === 'stdout' ? 'stdout_limit' : 'stderr_limit', limitBytes: streamLimit }
        : { kind: 'aggregate_output_limit', limitBytes: this.limits.maxOutputBytes },
    );
  }

  private acceptOutput(stream: 'stdout' | 'stderr', chunk: Buffer, acceptedBytes: number): void {
    if (acceptedBytes <= 0) return;
    const accepted = acceptedBytes === chunk.byteLength ? chunk : chunk.subarray(0, acceptedBytes);
    if (stream === 'stdout') {
      this.state.stdout.push(accepted);
      this.state.stdoutBytes += acceptedBytes;
    } else {
      this.state.stderr.push(accepted);
      this.state.stderrBytes += acceptedBytes;
    }
    this.state.outputBytes += acceptedBytes;
  }
}

/**
 * Create a bounded process runner. POSIX children become process-group leaders so forced
 * termination reaches descendants retaining inherited output pipes. Windows falls back to
 * direct child termination because negative-PID process-group signalling is unavailable.
 */
export function createNodeLamQuantCommandRunner(
  options: NodeLamQuantCommandRunnerOptions = {},
): LamQuantCommandRunner {
  const limits = runnerLimits(options);
  return {
    run: async (request) =>
      new Promise((resolve) => {
        new NodeLamQuantProcessRun(limits, resolve).start(
          request.executable,
          request.args,
          request.cwd,
        );
      }),
  };
}

export const nodeLamQuantCommandRunner = createNodeLamQuantCommandRunner();
