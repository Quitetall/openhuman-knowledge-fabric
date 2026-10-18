// One holder at a time: a lock file created with O_EXCL that names its holder by pid AND start
// time (field 22 of /proc/<pid>/stat), the identity fixtures/veracier/stack/pidfile.sh uses, so a
// pid the kernel has since reused is not mistaken for the holder. A lock whose holder is gone is
// stale and is taken over; a live holder's lock is never removed.

import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';

function startTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19];
  } catch {
    return undefined;
  }
}

/** The live holder `{ pid, data }` of `file`, or undefined. */
export function lockHolder(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const [pid, start, ...rest] = text.split('\n');
  if (!/^\d+$/.test(pid ?? '') || startTime(Number(pid)) !== start) return undefined;
  return { pid: Number(pid), data: rest.join('\n').trim() };
}

/**
 * Take `file` for this process, or return the live holder. `data` is stored after the identity
 * (the launcher server keeps nothing secret there).
 */
export function acquireLock(file, data = '') {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = lockHolder(file);
      if (holder !== undefined) return { acquired: false, holder };
      rmSync(file, { force: true });
      continue;
    }
    writeSync(fd, `${process.pid}\n${startTime(process.pid)}\n${data}\n`);
    closeSync(fd);
    return {
      acquired: true,
      release: () => {
        if (lockHolder(file)?.pid === process.pid) rmSync(file, { force: true });
      },
    };
  }
  const holder = lockHolder(file);
  return holder === undefined ? acquireLock(file, data) : { acquired: false, holder };
}
