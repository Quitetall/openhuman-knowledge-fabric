#!/usr/bin/env bash
# Supervise an ephemeral self-hosted runner: one fresh container per job, forever.
#
#   deploy/self-hosted-runner/run.sh            # run in the foreground
#   deploy/self-hosted-runner/run.sh --once     # take a single job and stop
#   deploy/self-hosted-runner/run.sh --build    # rebuild the image first
#
# WHY THIS EXISTS. GitHub Actions is billed per minute on GitHub-hosted runners. Self-hosted
# runners are free. This one is containerised rather than bare so that "CI is green" keeps
# meaning "green on a machine that is not my workstation" — see the Dockerfile for the five
# host requirements that claim earned.
#
# ── THE SECURITY BOUNDARY, STATED PLAINLY ───────────────────────────────────────────────────
#
# The inner docker daemon runs `--privileged`, which is root-equivalent on this host. That is
# acceptable ONLY because this repository is PRIVATE and only its owner can push to it, so the
# only code the runner executes is code the owner wrote.
#
# IT STOPS BEING ACCEPTABLE THE MOMENT THE REPOSITORY IS PUBLIC. A pull request from a fork
# would then run attacker-controlled code as root on this machine. Before making the repository
# public: delete the runner, or restrict it to a runner group that no fork-PR workflow can
# reach. `scripts/publish-public.sh` publishes to a SEPARATE repository precisely so this one
# can stay private; if that ever changes, this file has to change with it.
#
# ── WHY A PRIVATE DAEMON RATHER THAN THE HOST SOCKET ────────────────────────────────────────
#
# The usual recipe mounts /var/run/docker.sock so Testcontainers can start PostgreSQL. That
# gives every CI job control of the HOST's docker, and this host is running MinIO, Keycloak and
# a development PostgreSQL. One `docker system prune` in a job, or a reaper with a broad label
# filter, and they are gone. A sibling DinD daemon costs one container and an image cache
# volume, and CI containers simply cannot see the host's.
set -euo pipefail

REPO="${KF_RUNNER_REPO:-Quitetall/openhuman-knowledge-fabric}"
IMAGE="${KF_RUNNER_IMAGE:-kf-runner:2.336.0}"
LABELS="${KF_RUNNER_LABELS:-self-hosted,linux,x64,kf-sandboxed}"
NET="kf-ci"
DIND="kf-ci-dind"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

once=false
build=false
for arg in "$@"; do
  case "$arg" in
    --once)  once=true ;;
    --build) build=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "runner: $*" >&2; exit 1; }

command -v docker >/dev/null || die 'docker is not installed'
command -v gh >/dev/null ||
  die 'the gh CLI is required — it mints a fresh registration token for every job, so no
     long-lived credential has to be stored anywhere on disk.'
gh auth status >/dev/null 2>&1 || die 'gh is not authenticated (gh auth login)'

if [ "$build" = true ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "runner: building $IMAGE"
  docker build \
    --build-arg "DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)" \
    -t "$IMAGE" "$HERE"
fi

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

# The inner daemon is long-lived on purpose: it holds the image cache, so postgres:18-alpine is
# pulled once rather than once per job. It is still isolated from the host daemon — nothing in
# it can see the host's containers, which is the property being bought.
if ! docker inspect -f '{{.State.Running}}' "$DIND" 2>/dev/null | grep -q true; then
  echo "runner: starting the isolated inner docker daemon"
  docker rm -f "$DIND" >/dev/null 2>&1 || true
  docker run -d --name "$DIND" --privileged \
    --network "$NET" --network-alias docker \
    -e DOCKER_TLS_CERTDIR= \
    -v kf-ci-dind-images:/var/lib/docker \
    docker:29-dind --host=tcp://0.0.0.0:2375 >/dev/null
fi

echo "runner: repo=$REPO image=$IMAGE labels=$LABELS"
echo "runner: one fresh container per job. Ctrl-C to stop."

while :; do
  # A registration token is valid for one hour, so it is minted per job rather than stored.
  token="$(gh api -X POST "/repos/${REPO}/actions/runners/registration-token" --jq .token)" ||
    die 'could not mint a registration token — does this account have admin on the repo?'

  docker run --rm \
    --network "$NET" \
    -e DOCKER_HOST=tcp://docker:2375 \
    `# Testcontainers publishes ports on the DAEMON's host, which here is the DinD container,` \
    `# not localhost inside the runner. Without this override every container it starts is` \
    `# unreachable and the failure reads as a timeout in the test rather than a wiring problem.` \
    -e TESTCONTAINERS_HOST_OVERRIDE=docker \
    -e RUNNER_REPO_URL="https://github.com/${REPO}" \
    -e RUNNER_TOKEN="$token" \
    -e RUNNER_LABELS="$LABELS" \
    -e RUNNER_NAME="kf-ephemeral-$$-$(date +%s)" \
    "$IMAGE" || echo "runner: container exited non-zero; restarting"

  [ "$once" = true ] && break
  sleep 2
done
