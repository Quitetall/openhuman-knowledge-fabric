#!/usr/bin/env bash
#
# Did every scheduled Knowledge Fabric timer actually fire recently enough?
#
# A timer that is stopped, disabled, or never enabled produces no failure: its service simply
# does not run, `OnFailure=` never fires, and the only trace is an absence. A backup timer that
# silently stops is indistinguishable from one that is working, right up until the restore.
# `systemctl list-timers` shows it, to whoever thinks to look.
#
# This looks. Each shipped `kf-*.timer` declares, in its own file, how long it may go without
# firing (`X-KF-MaxSilenceSec=` — systemd ignores `X-` keys, so the unit stays valid). This
# asks systemd when each one last triggered and fails, naming it, when any is inactive or has
# been silent longer than it declared.
#
# Usage: scripts/timer-liveness.sh [timer ...]
#   With no arguments, every kf-*.timer this release ships. kf-readiness.service runs it every
#   15 minutes; kf-alert-heartbeat.service runs it for kf-readiness.timer alone, so a stopped
#   readiness timer stops the daily heartbeat and is noticed at the far end by its absence.
#
# Environment:
#   KF_TIMER_UNIT_DIR   where the shipped timer files are (default: this release's deploy/systemd)
#   KF_NOW_EPOCH        override the clock, for tests only

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${KF_TIMER_UNIT_DIR:-$ROOT/deploy/systemd}"
NOW="${KF_NOW_EPOCH:-$(date +%s)}"

if [ "$#" -gt 0 ]; then
  TIMERS=("$@")
else
  mapfile -t TIMERS < <(cd "$UNIT_DIR" && ls -1 kf-*.timer 2>/dev/null | sort)
fi
if [ "${#TIMERS[@]}" -eq 0 ]; then
  echo "timer liveness: no kf-*.timer found in $UNIT_DIR, so nothing was checked" >&2
  exit 1
fi

# systemd prints `@<epoch>` with --timestamp=unix, and nothing for an event that never happened.
epoch_of() {
  local value="$1"
  if [[ "$value" =~ ^@([0-9]+)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

failures=0
for timer in "${TIMERS[@]}"; do
  if [[ ! "$timer" =~ ^kf-[A-Za-z0-9@._-]+\.timer$ ]] || [ ! -f "$UNIT_DIR/$timer" ]; then
    echo "FAIL $timer: not a timer this release ships" >&2
    failures=$((failures + 1))
    continue
  fi
  limit="$(sed -n 's/^X-KF-MaxSilenceSec=\([0-9][0-9]*\)$/\1/p' "$UNIT_DIR/$timer")"
  if [ -z "$limit" ]; then
    echo "FAIL $timer: declares no X-KF-MaxSilenceSec, so nothing can say it is late" >&2
    failures=$((failures + 1))
    continue
  fi

  state=""; last=""; since=""
  while IFS='=' read -r key value; do
    case "$key" in
      ActiveState) state="$value" ;;
      LastTriggerUSec) last="$(epoch_of "$value")" ;;
      ActiveEnterTimestamp) since="$(epoch_of "$value")" ;;
    esac
  done < <(systemctl show "$timer" --timestamp=unix \
    --property=ActiveState,LastTriggerUSec,ActiveEnterTimestamp)

  if [ "$state" != active ]; then
    echo "FAIL $timer: ${state:-unknown}, so its service is not being scheduled at all" >&2
    failures=$((failures + 1))
    continue
  fi
  if [ -n "$last" ]; then
    age=$((NOW - last))
    if [ "$age" -gt "$limit" ]; then
      echo "FAIL $timer: last fired ${age}s ago, allowed ${limit}s" >&2
      failures=$((failures + 1))
    else
      echo "ok   $timer: last fired ${age}s ago (allowed ${limit}s)"
    fi
    continue
  fi
  # Never fired. Fine for a timer enabled a moment ago; not fine for one enabled longer ago than
  # it may stay silent, which is what a timer whose schedule can never match looks like.
  if [ -z "$since" ]; then
    echo "FAIL $timer: active but systemd reports neither a trigger nor an activation time" >&2
    failures=$((failures + 1))
  elif [ $((NOW - since)) -gt "$limit" ]; then
    echo "FAIL $timer: active for $((NOW - since))s and has never fired, allowed ${limit}s" >&2
    failures=$((failures + 1))
  else
    echo "ok   $timer: not yet due (active $((NOW - since))s, allowed ${limit}s)"
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "timer liveness: $failures of ${#TIMERS[@]} timer(s) are not firing on schedule" >&2
  exit 1
fi
echo "timer liveness: all ${#TIMERS[@]} timer(s) fired within their declared interval"
