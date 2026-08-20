#!/usr/bin/env bash
# Configure this container as a one-shot runner, take exactly one job, exit.
#
# `--ephemeral` is the whole point. The agent deregisters itself after a single job, the
# container exits, and `run.sh` starts a fresh one. A long-lived runner accumulates state —
# apt caches, a warm pnpm store, whatever the last job left in /tmp — and a job that passes
# because of what the previous job installed is the failure this arrangement exists to avoid.
set -euo pipefail

: "${RUNNER_REPO_URL:?RUNNER_REPO_URL is required}"
: "${RUNNER_TOKEN:?RUNNER_TOKEN is required}"
RUNNER_NAME="${RUNNER_NAME:-kf-ephemeral-$(hostname)}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,linux,x64,kf-sandboxed}"

# Wait for the sibling docker daemon. Testcontainers is the first thing the test job reaches
# for, and a race here reads as a mysterious connection refused ten minutes into a run.
if [ -n "${DOCKER_HOST:-}" ]; then
  printf 'waiting for the inner docker daemon at %s' "$DOCKER_HOST"
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      printf ' ok\n'
      break
    fi
    printf '.'
    sleep 1
  done
  if ! docker info >/dev/null 2>&1; then
    printf '\n'
    echo "the inner docker daemon never came up at ${DOCKER_HOST}." >&2
    echo "Testcontainers cannot start PostgreSQL without it, so refusing to take a job" >&2
    echo "rather than failing the suite for a reason that looks like a test bug." >&2
    exit 1
  fi
fi

cleanup() {
  # Best effort. An ephemeral runner that took a job has already deregistered itself; this
  # only matters when the container is killed before or between jobs.
  ./config.sh remove --token "${RUNNER_TOKEN}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

./config.sh \
  --unattended \
  --ephemeral \
  --replace \
  --url "${RUNNER_REPO_URL}" \
  --token "${RUNNER_TOKEN}" \
  --name "${RUNNER_NAME}" \
  --labels "${RUNNER_LABELS}" \
  --work /home/runner/_work

exec ./run.sh
