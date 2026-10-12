# Retrieval installation

How a host gets semantic search on its own CPU (ADR 0039 decision 5), and what a person must still
supply. The startup this installs is the [composed retrieval startup](retrieval-startup.md); the
index key's custody is [retrieval key release](retrieval-key-release.md), unchanged.
[`provision-host.sh`](../../scripts/deploy/provision-host.sh) runs the installer,
[`provision-retrieval.sh`](../../scripts/deploy/provision-retrieval.sh), on every run, and
`--check` reports it like everything else: what provisioning will do, and what only a person can
supply.

## What it installs, and from what

Every piece comes from bytes a pin in [`deploy/retrieval/`](../../deploy/retrieval/) names, and is
refused when its digest differs. Every fetch happens at installation; the units run with no
network but the provider/engine private loopback.

| Piece             | Installed at                                    | From                                                                                                                                                                                                                                                                                                                                                   | Accepted when                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LAMU engine       | `/usr/local/lib/kf-retrieval/lamu` (0755 root)  | `/var/lib/kf/retrieval-supply/lamu`, placed by a person, or `LAMU_URL_amd64` if one is ever pinned                                                                                                                                                                                                                                                     | its sha256 is `LAMU_SHA256_amd64`, and, asked as `kf-retrieval`, its `kf-retrieval serve --help` lists every option `scripts/retrieval/config.mjs` passes                                          |
| Python runtime    | `/opt/kf-runtimes/embedding-<lock>-<time>`      | Debian 13's `/usr/bin/python3.13` and exactly the wheels [`embed-requirements-cpu.txt`](../../deploy/retrieval/embed-requirements-cpu.txt) pins, installed by pip as `kf-embedding` (`--require-hashes --only-binary=:all: --no-deps`), from the indexes the lock names or from `/var/lib/kf/retrieval-supply/wheels`                                  | it assembles ([assembler](embedding-runtime.md)), imports `numpy`, `safetensors`, `tokenizers`, `torch` and `transformers` as `kf-embedding`, and verifies against the digest its assembly printed |
| bge-m3 model      | `/opt/kf-models/bge-m3-5617a9f61b02-f16` (root) | a prepared directory in `/var/lib/kf/retrieval-supply/bge-m3-f16`; else the six Hub files at the pinned revision, from `/var/lib/kf/retrieval-supply/bge-m3` or fetched, each checked against [`bge-m3.sources`](../../deploy/retrieval/bge-m3.sources), converted by [`prepare-model.py`](../../scripts/embedding/prepare-model.py) as `kf-embedding` | its `SHA256SUMS` hashes to `MODEL_MANIFEST_SHA256`, the digest [`model.py`](../../scripts/embedding/model.py) refuses anything else than at startup                                                |
| Key broker policy | `/etc/kf/retrieval-key-release.json` (0644)     | `kf-retrieval`'s uid, the canonical release directory, and the manifest digest `install-release.sh` verified (`/opt/.kf-install/<release>.verified`)                                                                                                                                                                                                   | always rendered from those; re-rendered when the release changes                                                                                                                                   |
| Startup contract  | `/etc/kf/retrieval-runtime.json` (0644)         | all of the above, the model identity and port the pins name, and `kf-api`'s and `kf-worker`'s uids                                                                                                                                                                                                                                                     | rendered only when every piece above is installed, and only as `parseConfig` accepts it                                                                                                            |

The units (`kf-embedding.service`, `lamu-retrieval.service`, `kf-retrieval-key.socket`,
`kf-retrieval-key@.service`, `kf-retrieval-credentials.path`) are installed with every other unit.
Enabling them is the [runbook](first-host-runbook.md)'s step, as for every service.

A new release changes the release digest, so the next `provision-host.sh` re-renders both
contracts; until it does, the startup refuses the new release (`startup_release_mismatch`) rather
than run the old pins against it. A runtime that stops verifying (a host library updated under it)
is reported, not rebuilt in place: move it aside and re-run, and a fresh one is built.

## What a person supplies, and why

- **The LAMU engine**, in `/var/lib/kf/retrieval-supply/lamu`. LAMU publishes no release artifact,
  so there is nothing to fetch by digest; the person copies the build the pin names from where it
  was built, and provisioning checks it. If LAMU ever publishes one, its URL goes in
  `LAMU_URL_amd64` and this item disappears.
- **The index key**, at `/run/kf-workstation-credentials/current/retrieval-index-key`, at every
  boot, by the workstation credential handoff. It is never generated or stored on the host
  ([retrieval key release](retrieval-key-release.md)); `kf-retrieval-credentials.path` starts the
  engine when it arrives.
- **Python 3.13 with pip** (`apt-get install python3 python3-pip`), when the host lacks it.

The model and the wheels are **not** person-supplied by default. Both are public, both are pinned
by sha256 (each wheel by the lock, each Hub file by `bge-m3.sources`, and the converted directory
by the provider's own manifest digest), so fetching them at installation and refusing a mismatch
gives the same assurance as a person copying them, with one fewer hand step and one fewer place to
copy the wrong file from. A host that must install offline supplies them instead
(`/var/lib/kf/retrieval-supply/wheels`, `.../bge-m3` or `.../bge-m3-f16`) and the same digests are
checked. The conversion was reproduced on the workstation on 2026-10-11 with the CPU lock's wheels
(Python 3.13.14, `torch 2.11.0+cpu`, `transformers 5.5.3`, `numpy 2.5.4`): its `SHA256SUMS` hashed
to `ab6184aa…54f9a`, the provider's pin.

## The engine pin, and why it is refused today

The pin is LAMU `26923afb` (sha256 `c45c672f…6e962`), the build KF-WAR-0002 pinned and the fixture
stacks run; KF's real-engine suite passes against it (10 of 10, re-run 2026-10-11). It has no
`--key-release-socket` or `--kf-release-sha256`: the KF key-release client is on LAMU's
`kf/startup-key-release` branch, whose build (`a20e515`, sha256 `e02e3bf7…c93a33`) has the client but
fails 7 of KF's 10 real-engine tests against the current KF client (every request answers
`unavailable`; re-run 2026-10-11). No LAMU build has both, so the installer refuses `26923afb` with
the options it lacks, renders no contract, and `--check` says so. Pinning a build that carries both
is the owner's decision: change `LAMU_COMMIT` and `LAMU_SHA256_amd64` in
[`retrieval.release`](../../deploy/retrieval/retrieval.release) and the KF-WAR pins together.

## Evidence

`tests/deployment/provision-host.test.ts` ("semantic search on the host") runs the real installer
in a fake root with public stand-ins for the engine, the interpreter and the runtime assembler: a
full install renders a contract `parseConfig` accepts and leaves `--check` listing only the index
key; an engine that is not the pinned bytes, a pinned engine lacking a startup option, a converted
model that is not the pinned directory, a Hub file that is not the pinned one, wheels that fail
their hashes and a runtime that stops verifying are each refused. Each refusal was falsified: with
its check removed, its test fails. `tests/deployment/retrieval-installation.test.ts` holds the
pins equal to the code that enforces them. Neither is a host install: no VM was available on
2026-10-11, and installation on a host, the real key release, restart and reboot remain the proof
[retrieval startup](retrieval-startup.md) lists.
