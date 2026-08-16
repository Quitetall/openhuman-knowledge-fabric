import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { canonicalize } from '@kf/canonicalization';
import type { CompilationRequest, CompilerResponse } from '../compiler.js';
import type { VerifiedRuntimeFile } from './contracts.js';
import { boundedMessage } from './limits.js';
import type { LiminalProcessConfig } from './options.js';
import { killProcessTree } from './process-control.js';
import { sandboxArguments } from './sandbox.js';

export async function runLiminalCompiler(
  config: LiminalProcessConfig,
  executableBytes: Buffer,
  runtimeFiles: readonly VerifiedRuntimeFile[],
  request: CompilationRequest,
): Promise<CompilerResponse> {
  const input = Buffer.from(`${canonicalize(request)}\n`, 'utf8');
  if (input.byteLength > config.maxInputBytes) {
    throw new Error(`Liminal compiler input exceeded ${String(config.maxInputBytes)} bytes`);
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const result = await spawnCompiler(config, executableBytes, runtimeFiles, input, stdout, stderr);
  if (result.code !== 0) {
    throw new Error(
      `Liminal compiler exited ${String(result.code)}${
        result.signal === null ? '' : ` (${result.signal})`
      }: ${boundedMessage(stderr, 'no diagnostics')}`,
    );
  }
  return parseCompilerResponse(stdout);
}

async function spawnCompiler(
  config: LiminalProcessConfig,
  executableBytes: Buffer,
  runtimeFiles: readonly VerifiedRuntimeFile[],
  input: Buffer,
  stdout: Buffer[],
  stderr: Buffer[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let limitFailure: Error | undefined;
  return await new Promise((resolve, reject) => {
    const child = spawn(
      config.bubblewrapPath,
      sandboxArguments(config.runtimeFilePaths, config.pathEnvironment, [
        '--protocol',
        config.identity.protocol,
      ]),
      {
        cwd: '/',
        detached: true,
        env: {},
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', ...runtimeFiles.map(({ file }) => file.fd)],
      },
    );
    const childStdin = child.stdin;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const compilerInput = child.stdio[3] as Writable | null;
    if (
      childStdin === null ||
      childStdout === null ||
      childStderr === null ||
      compilerInput === null
    ) {
      child.kill('SIGKILL');
      reject(new Error('Liminal compiler did not expose required piped streams'));
      return;
    }
    let settled = false;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      stopFor(new Error(`Liminal compiler timed out after ${String(config.timeoutMs)} ms`));
    }, config.timeoutMs);
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    const stopFor = (error: Error): void => {
      if (limitFailure !== undefined) return;
      limitFailure = error;
      childStdin.destroy();
      childStdout.destroy();
      childStderr.destroy();
      killProcessTree(child);
      cleanupTimer = setTimeout(() => rejectOnce(error), config.cleanupTimeoutMs);
    };
    childStdout.on('data', (chunk: Buffer) => {
      if (limitFailure !== undefined) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > config.maxOutputBytes) {
        stopFor(
          new Error(`Liminal compiler output exceeded ${String(config.maxOutputBytes)} bytes`),
        );
        return;
      }
      stdout.push(chunk);
    });
    childStderr.on('data', (chunk: Buffer) => {
      if (limitFailure !== undefined) return;
      stderrBytes += chunk.byteLength;
      if (stderrBytes > config.maxDiagnosticBytes) {
        stopFor(
          new Error(
            `Liminal compiler diagnostics exceeded ${String(config.maxDiagnosticBytes)} bytes`,
          ),
        );
        return;
      }
      stderr.push(chunk);
    });
    child.once('error', (error) => {
      rejectOnce(new Error(`Liminal compiler failed to start: ${error.message}`, { cause: error }));
    });
    childStdin.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        stopFor(new Error(`Liminal compiler input failed: ${error.message}`, { cause: error }));
      }
    });
    compilerInput.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        stopFor(
          new Error(`Liminal verified-byte transfer failed: ${error.message}`, { cause: error }),
        );
      }
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (limitFailure !== undefined) {
        rejectOnce(limitFailure);
        return;
      }
      settled = true;
      clearTimers();
      resolve({ code, signal });
    });
    compilerInput.end(executableBytes);
    childStdin.end(input);
  });
}

function parseCompilerResponse(stdout: readonly Buffer[]): CompilerResponse {
  let output: string;
  try {
    output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(stdout),
    );
  } catch (error: unknown) {
    throw new Error('Liminal compiler returned invalid UTF-8', { cause: error });
  }
  if (output.startsWith('\ufeff')) {
    throw new Error('Liminal compiler returned a forbidden UTF-8 BOM');
  }
  const body = output.endsWith('\n') ? output.slice(0, -1) : output;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error: unknown) {
    throw new Error('Liminal compiler returned invalid JSON', { cause: error });
  }
  if (canonicalize(parsed) !== body) {
    throw new Error('Liminal compiler returned non-canonical JSON');
  }
  return parsed as CompilerResponse;
}
