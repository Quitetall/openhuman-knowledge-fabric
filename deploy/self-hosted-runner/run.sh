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

# ── CLEANING UP AFTER OURSELVES ─────────────────────────────────────────────────────────────
#
# Ctrl-C does NOT propagate into `docker run` reliably, so without this the container survives
# the supervisor and stays registered with GitHub — idle, invisible, and eligible to be handed
# the next job. That is worse than an absent runner: it took a job with the OLD configuration
# and failed for a reason that had already been fixed, which is a very confusing hour.
#
# GitHub also keeps listing a runner as `online` for a while after its container dies, so a
# forced removal leaves a phantom registration that would silently swallow a job. Both halves
# are cleaned up here: the container, then any registration without a container behind it.
CONTAINER="kf-runner-$$"

cleanup() {
  echo
  echo "runner: stopping"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # Delete registrations that no longer have a live container. Matching on our own PID-derived
  # name keeps this from touching a runner someone else started on this machine.
  gh api "/repos/${REPO}/actions/runners" --jq '.runners[] | "\(.id) \(.name)"' 2>/dev/null |
    while read -r id name; do
      case "$name" in
        "kf-ephemeral-$$-"*)
          gh api -X DELETE "/repos/${REPO}/actions/runners/${id}" >/dev/null 2>&1 &&
            echo "runner: deregistered $name"
          ;;
      esac
    done
}
trap cleanup EXIT INT TERM

echo "runner: repo=$REPO image=$IMAGE labels=$LABELS"
echo "runner: one fresh container per job. Ctrl-C to stop."

while :; do
  # A registration token is valid for one hour, so it is minted per job rather than stored.
  token="$(gh api -X POST "/repos/${REPO}/actions/runners/registration-token" --jq .token)" ||
    die 'could not mint a registration token — does this account have admin on the repo?'

  # ── WHY TWO SECURITY RELAXATIONS, AND ONLY TWO ──────────────────────────────────────────
  #
  # `packages/documents/src/liminal-adapter/sandbox.ts` runs the document compiler under
  # bubblewrap with `--unshare-all --unshare-user --disable-userns`, and ci.yml refuses to take
  # a job unless that works. A default docker container cannot do it, for two independent
  # reasons — the first run on this runner failed on exactly this, which is the containerised
  # runner doing its job.
  #
  # Measured, on this image:
  #
  #   (nothing)                                  fails: no permissions to create new namespace
  #   --security-opt systempaths=unconfined      fails: no permissions to create new namespace
  #   --security-opt seccomp=unconfined          fails: /proc/sys/user/max_user_namespaces ro
  #   seccomp=unconfined + cap-add SYS_ADMIN     fails: /proc/sys/user/max_user_namespaces ro
  #   seccomp=unconfined + systempaths=unconfined      WORKS
  #   --privileged                                     WORKS
  #
  # So both are needed and neither alone suffices. SYS_ADMIN is NOT the missing piece, which is
  # worth knowing: the reflex to reach for a capability would not have fixed it.
  #
  # This is deliberately NOT `--privileged`. Capabilities stay dropped, no host devices are
  # exposed, no host namespaces are shared. What is given up is syscall filtering and a
  # read-only /proc/sys — enough for bubblewrap to create a user namespace and no more.
  #
  # bubblewrap on Debian/Ubuntu reads /proc/sys/user/max_user_namespaces at startup, which is
  # why the read-only mount blocks it even once seccomp allows the clone.
  docker run --rm --name "$CONTAINER" \
    --network "$NET" \
    --security-opt seccomp=unconfined \
    --security-opt systempaths=unconfined \
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
