# Pidfiles that name ONE process, not whatever later holds its number. Sourced by stack.sh.
#
# WHY. A pidfile used to hold a bare pid, and "running" meant `kill -0 <pid>` succeeded. After a
# reboot the kernel hands the same numbers out again: on 2026-10-06 run/embed.pid held 35684,
# which by then was a thread of an unrelated desktop application, so `up` reported "embed already
# running" and never started the embedder, and `down` would have sent SIGTERM to that
# application's process group. A pid is a name the kernel reuses; it is not an identity.
#
# WHAT IS RECORDED. `<pid> <start time> <boot id>`: the pid, the process's start time in clock
# ticks since boot (field 22 of /proc/<pid>/stat, which exec does not change), and the kernel's
# boot id. A process is the one that was started only if all three still match, so a reused
# number — after a reboot or within one — is told apart. The launched process writes the line
# about ITSELF before it execs (`pidfile_record`), so there is no window in which the record
# describes a parent or a stranger.
#
# A MISMATCH IS STALE, AND STALE IS NEVER SIGNALLED. `pidfile_alive` removes a pidfile that does
# not describe a live process it can verify, and says so; nothing in stack.sh signals a pid that
# `pidfile_alive` did not just verify.
#
# LEGACY PIDFILES (a bare pid, written by stack.sh before this file existed) carry no identity.
# One is accepted only while its process's command line still matches what stack.sh starts under
# that name (`pidfile_expected`), and is otherwise stale like any other; this keeps a stack that
# was started by the old script stoppable by the new one.

pidfile_boot_id() { cat /proc/sys/kernel/random/boot_id 2>/dev/null; }

# pidfile_start_time <pid>: field 22 of /proc/<pid>/stat. The command name (field 2) may hold
# spaces and parentheses, so the fields are counted from after its LAST closing parenthesis.
pidfile_start_time() {
  local stat rest
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  [ -n "$stat" ] || return 1
  rest="${stat##*) }"
  # shellcheck disable=SC2086  # deliberate splitting: the fields after the name are words
  set -- $rest
  # $1 is field 3 (state), so field 22 is the 20th word.
  [ "$#" -ge 20 ] || return 1
  printf '%s' "${20}"
}

# pidfile_record <pidfile>: run INSIDE the process being launched, before it execs. Writes
# `<pid> <start time> <boot id>` for $$ atomically (a reader never sees half a line).
pidfile_record() {
  local start boot
  start="$(pidfile_start_time $$)" || return 1
  boot="$(pidfile_boot_id)"
  printf '%s %s %s\n' "$$" "$start" "$boot" >"$1.tmp" && mv -f "$1.tmp" "$1"
}

# The command-line fragment each name's process carries, for LEGACY pidfiles only.
pidfile_expected() {
  case "$1" in
    embed) printf '%s' 'embed-server.py serve' ;;
    retrieval) printf '%s' 'kf-retrieval serve' ;;
    attestor) printf '%s' 'apps/attestor/dist/dev.js' ;;
    api) printf '%s' 'apps/api/dist/server.js' ;;
    worker) printf '%s' 'apps/worker/dist/main.js' ;;
    # `next start` renames itself next-server once it is up.
    web) printf '%s' 'next' ;;
    *) return 1 ;;
  esac
}

# pidfile_pid <pidfile>: the recorded pid (first field), or nothing.
pidfile_pid() {
  local pid
  [ -f "$1" ] || return 1
  read -r pid _ <"$1" 2>/dev/null || true
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s' "$pid"
}

# pidfile_alive <pidfile> [name]: 0 when the pidfile names the very process that was started and
# it is alive. Anything else removes the pidfile (reporting why on stderr) and returns 1; the
# process the stale number now belongs to is left alone.
pidfile_alive() {
  local file="$1" name="${2:-$(basename "$1" .pid)}" pid start boot actual expected cmdline
  [ -f "$file" ] || return 1
  read -r pid start boot <"$file" 2>/dev/null || true
  if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "  $name: pidfile $file is malformed; removed" >&2
    rm -f -- "$file"
    return 1
  fi
  if ! actual="$(pidfile_start_time "$pid")"; then
    rm -f -- "$file" # the process is gone: an ordinary stale pidfile, nothing to report
    return 1
  fi
  if [ -n "$start" ]; then
    if [ "$actual" = "$start" ] && [ "$boot" = "$(pidfile_boot_id)" ]; then return 0; fi
    echo "  $name: pid $pid is now another process (start time or boot differs); stale pidfile removed, process not signalled" >&2
    rm -f -- "$file"
    return 1
  fi
  # Legacy: no identity recorded. Accept only a command line that is still this name's.
  expected="$(pidfile_expected "$name")" || expected=''
  cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)" || cmdline=''
  if [ -n "$expected" ] && [[ "$cmdline" == *"$expected"* ]]; then return 0; fi
  echo "  $name: pid $pid (legacy pidfile) is not $name any more; stale pidfile removed, process not signalled" >&2
  rm -f -- "$file"
  return 1
}

# pidfile_stop <pidfile> [name] [wait-tenths]: SIGTERM the recorded process's group (each
# process leads its own session) only after verifying it, then wait for it to go. Returns 1 when
# there was nothing verified to stop. The pidfile is removed either way.
pidfile_stop() {
  local file="$1" name="${2:-$(basename "$1" .pid)}" limit="${3:-200}" pid waited=0
  if ! pidfile_alive "$file" "$name"; then
    rm -f -- "$file"
    return 1
  fi
  pid="$(pidfile_pid "$file")"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$limit" ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  rm -f -- "$file"
  return 0
}
