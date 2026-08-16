import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import type { VerifiedExecutable, VerifiedRuntimeFile } from './contracts.js';
import {
  boundedMessage,
  MAX_PREFLIGHT_RESPONSE_BYTES,
  PREFLIGHT_RESPONSE,
  PREFLIGHT_TIMEOUT_MS,
} from './limits.js';
import { killProcessTree } from './process-control.js';
import { sandboxArguments } from './sandbox.js';
import { closeVerifiedExecutable, verifyLiminalExecutable } from './executable.js';
import { closeRuntimeFiles, openRuntimeFiles } from './runtime-files.js';
import type { LiminalProcessConfig } from './options.js';

export async function performLiminalPreflight(config: LiminalProcessConfig): Promise<void> {
  await assertHostPreflightPaths(config);
  const probe = await verifyLiminalExecutable(config);
  let runtimeFiles: readonly VerifiedRuntimeFile[];
  try {
    runtimeFiles = await openRuntimeFiles(config);
  } catch (error: unknown) {
    await closeVerifiedExecutable(probe);
    throw error;
  }
  try {
    await runPreflightProbe(config, probe, runtimeFiles);
  } finally {
    await Promise.all([closeVerifiedExecutable(probe), closeRuntimeFiles(runtimeFiles)]);
  }
}

async function assertHostPreflightPaths(config: LiminalProcessConfig): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('Pinned Liminal execution requires Linux /proc file-descriptor support');
  }
  await access('/proc/self/fd', fsConstants.R_OK | fsConstants.X_OK);
  const [sandboxStat] = await Promise.all([
    stat(config.bubblewrapPath),
    access(config.bubblewrapPath, fsConstants.X_OK),
  ]);
  if (!sandboxStat.isFile()) throw new Error('bubblewrapPath must name a regular executable');
  if ((sandboxStat.mode & 0o022) !== 0) {
    throw new Error('bubblewrapPath must not be group- or world-writable');
  }
}

async function runPreflightProbe(
  config: LiminalProcessConfig,
  executable: VerifiedExecutable,
  runtimeFiles: readonly VerifiedRuntimeFile[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      config.bubblewrapPath,
      sandboxArguments(config.runtimeFilePaths, config.pathEnvironment, [
        '--protocol',
        config.identity.protocol,
        '--preflight',
      ]),
      {
        cwd: '/',
        detached: true,
        env: {},
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', ...runtimeFiles.map(({ file }) => file.fd)],
      },
    );
    const compilerInput = child.stdio[3] as Writable | null;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const diagnostics: Buffer[] = [];
    let diagnosticBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(new Error('Liminal sandbox preflight timed out'));
    }, PREFLIGHT_TIMEOUT_MS);
    if (compilerInput === null) {
      killProcessTree(child);
      finish(new Error('Liminal sandbox preflight did not expose verified-byte input'));
      return;
    }
    compilerInput.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        killProcessTree(child);
        finish(
          new Error(`Liminal sandbox preflight verified-byte transfer failed: ${error.message}`, {
            cause: error,
          }),
        );
      }
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_PREFLIGHT_RESPONSE_BYTES) {
        stdout.push(chunk);
        return;
      }
      killProcessTree(child);
      finish(new Error('Liminal sandbox preflight response exceeded exact contract'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.byteLength;
      if (diagnosticBytes <= config.maxDiagnosticBytes) diagnostics.push(chunk);
    });
    child.once('error', (error) =>
      finish(new Error(`Liminal sandbox preflight failed to start: ${error.message}`)),
    );
    child.once('close', (code, signal) => {
      if (code === 0) {
        const response = Buffer.concat(stdout).toString('utf8');
        if (response === PREFLIGHT_RESPONSE) finish();
        else finish(new Error('Liminal sandbox preflight response did not match exact contract'));
      } else {
        finish(
          new Error(
            `Liminal sandbox preflight exited ${String(code)}${
              signal === null ? '' : ` (${signal})`
            }: ${boundedMessage(diagnostics, 'no diagnostics')}`,
          ),
        );
      }
    });
    compilerInput.end(executable.bytes);
  });
}
