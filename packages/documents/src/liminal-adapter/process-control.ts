import type { ChildProcess } from 'node:child_process';

export function killProcessTree(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try {
      // detached:true makes bubblewrap the external process-group leader. Its PID namespace dies
      // with it, including descendants that called setsid().
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      child.kill('SIGKILL');
      return;
    }
  }
  child.kill('SIGKILL');
}
