# Self-hosted GitHub Actions runner — deliberately almost empty.
#
# WHY THIS IMAGE INSTALLS SO LITTLE.
#
# The obvious thing to do with a self-hosted runner is to pre-install everything the workflow
# needs, so jobs are fast. That would destroy the only reason CI was worth anything here.
#
# On 2026-08-18 the first real CI runs found FIVE host requirements that were unsatisfied on a
# clean machine: bubblewrap, unprivileged user namespaces, a PostgreSQL 18 client, /usr/bin/node
# and pandoc. Four were named in docs/deployment/private-host.md and had never been checked
# against a machine; pandoc was written down nowhere. `pnpm gate` had been green throughout, on
# a workstation that happened to have all five. A runner pre-loaded with the same five would
# have agreed with that workstation and found nothing.
#
# So this image is a bare ubuntu-24.04 plus what is needed to *be* a runner and nothing else.
# `.github/workflows/ci.yml` installs its own dependencies exactly as it does on a GitHub-hosted
# runner, and those steps stay under test.
FROM ubuntu:24.04

ARG RUNNER_VERSION=2.336.0
# The host's docker group GID. The runner user joins it so it can reach the inner daemon's
# socket. Overridable because it differs per machine — `stat -c %g /var/run/docker.sock`.
ARG DOCKER_GID=30002

ENV DEBIAN_FRONTEND=noninteractive

# Runner prerequisites and nothing more. `sudo` is here because ci.yml uses it to install its
# own dependencies, which is the behaviour being preserved.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      ca-certificates curl git jq sudo tar unzip gnupg lsb-release iproute2 \
      libicu74 \
 && rm -rf /var/lib/apt/lists/*

# The GitHub CLI is PLATFORM tooling, not a project dependency, and that distinction is the
# whole rule this image runs on.
#
# `release.yml` attaches the SBOM with `gh release create` / `gh release upload`. On its second
# real run it died with `gh: command not found`, because a GitHub-hosted `ubuntu-latest` ships
# the CLI preinstalled and a bare `ubuntu:24.04` does not.
#
# It would be consistent-looking to say "then the workflow should install it, like pandoc" — and
# it would be wrong. bubblewrap, pandoc, python3 and the PostgreSQL client are things the
# PRODUCT needs, so a workflow installing them is the host contract being written down and
# tested, which is exactly why they belong there. `gh` is how a job talks to Actions and
# Releases: it is part of being a runner, like `git` and the agent itself, both already here.
# Pushing it into the workflow would make ci.yml install a tool to compensate for this image not
# being the thing it claims to substitute for.
#
# Keyring-pinned, same as docker-ce-cli below. `apt-key`-style unsigned repositories are how a
# build host gets its packages replaced.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli.gpg \
 && chmod a+r /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install --yes --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Docker CLI only — no daemon. The daemon runs in a sibling DinD container so CI containers are
# isolated from the host's, and the CLI talks to it over TCP. See run.sh for why.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install --yes --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

# The runner refuses to execute as root, and it is right to. Give it passwordless sudo because
# the workflow needs it, and put it in the docker group so it can reach the daemon.
RUN groupadd -g "${DOCKER_GID}" hostdocker 2>/dev/null || true \
 && useradd -m -s /bin/bash runner \
 && usermod -aG "${DOCKER_GID}" runner \
 && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
 && chmod 0440 /etc/sudoers.d/runner

USER runner
WORKDIR /home/runner

# Pinned by version AND by the SHA-256 GitHub publishes in the release body for v2.336.0
# (`<!-- BEGIN SHA linux-x64 -->04cf0be1…<!-- END SHA linux-x64 -->`). Independently recomputed
# from the download before being written here, and the two agreed.
#
# An unpinned `latest` would be arbitrary code execution holding a registration token. The
# checksum is checked with `--check`, which FAILS on mismatch — `sha256sum <file>` alone prints
# a hash and exits 0 no matter what, which is a check that cannot fail.
ARG RUNNER_SHA256=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d
RUN curl -fsSL -o runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
 && echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum --check --status \
 && tar xzf runner.tar.gz \
 && rm runner.tar.gz

# `installdependencies.sh` pulls the .NET runtime libraries the agent needs. Run as root, then
# drop back — the agent itself never runs as root.
USER root
RUN /home/runner/bin/installdependencies.sh && rm -rf /var/lib/apt/lists/*
USER runner

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
ENTRYPOINT ["/home/runner/entrypoint.sh"]
