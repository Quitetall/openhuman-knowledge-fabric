# Sandboxed self-hosted CI runner

GitHub-hosted runners are billed per minute; self-hosted runners are free. On 2026-08-20 CI
stopped running entirely — all four jobs died at job-start with _"recent account payments have
failed or your spending limit needs to be increased"_, the same failure that killed 38 runs
before the first green on 2026-08-18. This is the way off that dependency.

```sh
gh variable set RUNNER_LABEL --body kf-sandboxed    # point CI at this box
deploy/self-hosted-runner/run.sh --build            # build the image, then serve jobs
```

To go back to GitHub-hosted, `gh variable delete RUNNER_LABEL`. `runs-on` in `ci.yml` reads the
variable, so switching is a settings change and not a commit.

## Why the image is nearly empty

The obvious optimisation — pre-install everything the workflow needs so jobs are fast — would
destroy the only reason CI has been worth anything here.

The first real CI runs found **five host requirements unsatisfied on a clean machine**:
bubblewrap, unprivileged user namespaces, a PostgreSQL 18 client, `/usr/bin/node`, and pandoc.
Four were named in `docs/deployment/private-host.md` and had never been checked against a
machine. Pandoc was written down nowhere. `pnpm gate` had been green throughout, on a
workstation that happened to have all five.

A runner running bare on that same workstation would agree with it by construction and would
have found none of them. So the image is `ubuntu:24.04` plus the agent, and `ci.yml` installs
its own dependencies exactly as it does on a GitHub-hosted runner.

Verified on the built image — these are all **absent**, which is the point:

```
pandoc absent · bwrap absent · node absent · pnpm absent · psql absent
```

The property is live, not theoretical: this host does not currently have the PostgreSQL 18
client at `/usr/lib/postgresql/18/bin` that `ci.yml` provisions and pins.

## One fresh container per job

`--ephemeral` makes the agent deregister after a single job; `run.sh` then starts a new
container. A long-lived runner accumulates apt caches, a warm pnpm store and whatever the last
job left in `/tmp` — and a job that passes because of what the previous job installed is the
failure this arrangement exists to avoid.

Registration tokens last an hour, so `run.sh` mints a fresh one per job through `gh`. No
long-lived credential is stored on disk.

## Why a private docker daemon, not the host socket

The usual recipe mounts `/var/run/docker.sock` so Testcontainers can start PostgreSQL. That
hands every CI job control of the **host's** docker — and this host runs MinIO, Keycloak and a
development PostgreSQL. One `docker system prune` in a job and they are gone.

Instead a sibling `docker:29-dind` container runs an isolated daemon on the `kf-ci` network.
Measured: the host has 10 containers, and from inside the runner `docker ps -aq | wc -l` returns
**0**. CI cannot see them.

`TESTCONTAINERS_HOST_OVERRIDE=docker` is required, and `run.sh` sets it. Testcontainers
publishes ports on the _daemon's_ host, which here is the DinD container rather than localhost
inside the runner. Measured against a real `postgres:18-alpine`:

```
docker:32769      -> REACHABLE
localhost:32769   -> unreachable      <- what it would try without the override
```

Without it, every container Testcontainers starts is unreachable and the failure reads as a
test timeout rather than a wiring problem.

## The security boundary

**The inner daemon runs `--privileged`, which is root-equivalent on this machine.**

That is acceptable only because this repository is **private** and only its owner can push, so
the only code the runner executes is code the owner wrote.

**A fork pull request must never reach it.** Once this repository is public anyone can open
one, and that code would otherwise run as root here.

The usual control is a runner group restricted to selected workflows — an organization and
enterprise feature, and this repository belongs to a personal account, so it does not exist
here. The control that does exist is the **trigger**:

| Event                    | Runs on                 | Who can cause it    |
| ------------------------ | ----------------------- | ------------------- |
| `push` to `main`         | this runner             | write access only   |
| `pull_request`           | `ubuntu-latest`, always | anyone, once public |
| tag `v*` (`release.yml`) | this runner             | write access only   |

Routing pull requests to `ubuntu-latest` costs nothing on a public repository, where
GitHub-hosted minutes are free and unlimited. Fork PRs still get full CI, in a disposable VM
that is not someone's workstation.

`tests/deployment/host-provisioning-parity.test.ts` asserts every `ci.yml` job special-cases
`pull_request`, and that `release.yml` has no `pull_request` trigger. Add a workflow that both
uses this runner and can be triggered by a stranger, and that test is what stops you.

## Provenance

The agent tarball is pinned to v2.336.0 **and** to the SHA-256 GitHub publishes in that
release body, `04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d`, independently
recomputed from the download before being written here; the two agreed.

It is verified with `sha256sum --check`, which fails on mismatch. `sha256sum <file>` alone
prints a hash and exits 0 regardless, which is a check that cannot fail. Falsified by building
with a deliberately wrong hash: the build stops at that layer.

## Operating notes

|                                      |                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Stop serving jobs                    | Ctrl-C `run.sh`. The ephemeral agent deregisters itself.                               |
| Stop the inner daemon                | `docker rm -f kf-ci-dind`                                                              |
| Reclaim the image cache              | `docker volume rm kf-ci-dind-images`                                                   |
| Rebuild after editing the Dockerfile | `run.sh --build`                                                                       |
| Take exactly one job                 | `run.sh --once`                                                                        |
| What GitHub sees                     | `gh api /repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions/runners` |

`run.sh` runs in the foreground on purpose. Nothing here installs a systemd unit, because a
runner that starts at boot and nobody remembers is a machine quietly executing whatever lands
on `main`.

### Editing either file does nothing to a supervisor that is already running

A live `run.sh` holds its parsed loop, and the container it started holds the image it started
from. Neither notices an edit. So after changing `run.sh`, or after `docker build`, the change
does not take effect until the supervisor is restarted or the idle container is removed —
`docker rm -f <container>` is enough for an image change, because the loop resolves the tag
again on the next job.

Two things make this hard to see, and both cost time on 2026-08-21:

- The container is idle and **registered**, so GitHub will hand it the next job. Nothing looks
  wrong; the job simply runs against the old image and fails for a reason already fixed.
- Rebuilding the tag leaves the running container's image **untagged**, so `docker ps` prints a
  bare ID like `a7a391097818` instead of `kf-runner:2.336.0`. Filtering with
  `--filter ancestor=kf-runner:2.336.0` or grepping for the name then matches nothing, and the
  runner reads as gone when it is up and about to take work. Check with a plain `docker ps`.
