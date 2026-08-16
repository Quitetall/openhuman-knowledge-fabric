import type { LamQuantCommandResult } from './contracts.js';

export function processFailure(result: LamQuantCommandResult): string {
  if (result.spawnError !== undefined) return result.spawnError;
  if (result.runnerFailure?.kind === 'timeout') {
    return `timed out after ${String(result.runnerFailure.timeoutMs)} ms`;
  }
  if (result.runnerFailure?.kind === 'stdout_limit') {
    return `stdout exceeded ${String(result.runnerFailure.limitBytes)} bytes`;
  }
  if (result.runnerFailure?.kind === 'stderr_limit') {
    return `stderr exceeded ${String(result.runnerFailure.limitBytes)} bytes`;
  }
  if (result.runnerFailure?.kind === 'aggregate_output_limit') {
    return `aggregate output exceeded ${String(result.runnerFailure.limitBytes)} bytes`;
  }
  if (result.signal !== null) return `terminated by ${result.signal}`;
  return `exited ${String(result.exitCode)}`;
}
