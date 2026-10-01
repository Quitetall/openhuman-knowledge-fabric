# Retrieval runtime evidence — 2026-10-01

This records selected-VM compatibility probes. It is not a provider install
recipe, a commissioned service, a search-quality result or release acceptance.
The governing delivery sequence remains [Draft.9 implementation](../draft9-implementation.md).

## Engine candidate

The optimized engine was built from clean LAMU source
`a20e5154016c3fb7d98af1884ba54113bd20e3fb`, using Rust 1.89.0, the locked
dependencies, self-contained musl linking, baseline `x86-64`, static CRT and
the release profile. The compatibility library search contains only the empty
eight-byte `libdl.a`, SHA-256
`f0a17a43c74d2fe5474fa2fd29c8f14799e777d7d75a2cc4d11c20a6e7b161c5`;
the broad installed musl library directory is not used as a substitute.

The stripped static PIE has no ELF interpreter or dynamic dependencies.
Its SHA-256 is
`e02e3bf7e66443f411c823b1da4b54fb8a7523a7582205ade02f8019dfc93a33`.
Root-owned guest staging at `/opt/kf-engine-release-probe.lgKaWI/lamu`
verified the transport digest, then version and startup-key CLI help passed
as `kfadmin`. The binary reports `lamu 0.6.0 (git:a20e515)`.

Private copies, including LAMU's license, are retained at
`/mnt/4tb/kf-vm/engine-candidates/lamu-a20e515-musl-release` and
`/mnt/2tb/kf-preservation/engine-candidates/lamu-a20e515-musl-release`.
Both binary digests verified. They are artifact copies, not data backups.

KF's real-engine test command was:

```sh
LAMU_SETTINGS=/nonexistent/kf-contract-test-settings.toml \
KF_RETRIEVAL_ENGINE_BIN=<exact-optimized-candidate> \
pnpm exec vitest run packages/retrieval/src/real-engine.test.ts
```

All ten tests passed. The test itself declares its hash embedder; this is
protocol, mask, refusal and encrypted-storage evidence, not semantic search
qualification. The pinned default-member LAMU suite separately passed at
`10854d198d252d1247f33c67719c7df63fbe6ea2`: 1,571 passed, zero failed,
15 ignored across 61 executions. `a20e515` changes only documentation after
that source; do not report the default suite as run at `a20e515`.

## Public model and Python probe

The staged model is BAAI/bge-m3 at revision
`5617a9f61b028005a4858fdac845db406aefb181`, converted to float16 safetensors
using the existing [fixture loader](../../fixtures/veracier/stack/embed-server.py).
That fixture is not part of the sealed KF candidate `cf40e8e62246`, and
copying it into a probe does not turn it into a production module.

- Original checkpoint SHA-256:
  `b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38`.
- Safetensors SHA-256:
  `68440cc1b73b9af8ab85ecdc138b51877493ffbcec92a0a16e5d7e518eb22908`.
- Eight-entry model archive SHA-256:
  `ceb687c10dcaca8b01cf50b1985e0b693882489c25bc99ca29b2da130a612342`.
- Closed-file-set manifest SHA-256:
  `ab6184aae20a30f215160e7d5a9d231cd5a94323f62f4d3501a316aa66354f9a`.

The guest model is `/opt/kf-models/bge-m3-5617a9f61b02-f16`. All seven
content files, archive entry types and provenance pins verified before the
root-owned staged tree became readable. Archive and manifest copies verified
under the corresponding `models/bge-m3-5617a9f61b02-f16` directories on both
local preservation devices.

The disposable guest probe environment is `/var/tmp/kf-cpu-probe.qYxCNb`.
It uses Python 3.13.5, PyTorch `2.11.0+cpu`, Transformers 5.5.3,
Safetensors 0.7.0 and SentencePiece 0.2.1. The official CPU Torch wheel's
install-report SHA-256 is
`45025d7752dbc6b4c784c03afaee9c5f19730ce084b2e43fc9a2fe1677d9ff86`.
This mutable environment and the host build prerequisites are not an
immutable, closed provider release.

## Baseline NumPy correction

The minimal import failed twice because the upstream NumPy 2.5.3 wheel
requires `X86_V2`; the VM does not advertise that feature set. A same-version
source build requesting `SSE2` also failed: the downloaded source redirects
that older feature name to `X86_V2`. Neither disabling the CPU guard nor
changing the VM CPU was used.

The verified source archive has SHA-256
`df2d5874ff183595a4ba404edd04f6bd9b5505c1d7708573f6a6c17489a67563`.
With the guest's GCC, Python development headers and OpenBLAS installed, the
successful build command was:

```sh
env PIP_CONFIG_FILE=/dev/null CFLAGS=-march=x86-64 CXXFLAGS=-march=x86-64 \
  <probe-venv>/bin/python -m pip wheel --no-cache-dir --no-deps \
  --wheel-dir <owned-output-directory> \
  --config-settings=setup-args=-Dcpu-baseline=none \
  --config-settings=setup-args=-Dcpu-dispatch=none \
  --config-settings=compile-args=-j2 <verified-numpy-2.5.3.tar.gz>
```

The resulting `numpy-2.5.3-cp313-cp313-linux_x86_64.whl` has SHA-256
`7dce1d826d952ebbbc96430d1063f3a403c24da8471050fa17b6e531eb5a59d6`.
After a digest-checked, no-index, no-dependency replacement in the owned probe
venv, import reported version 2.5.3 and an empty CPU baseline; the matrix
product assertion passed. The source, wheel, license, install report, build
log and closed checksum list verified in
`/mnt/4tb/kf-vm/runtimes/numpy-2.5.3-baseline-probe` and
`/mnt/2tb/kf-preservation/runtimes/numpy-2.5.3-baseline-probe`.
These are probe artifacts, not a fully reproduced provider toolchain.

## Actual model result and remaining boundaries

The service-manager probe retained its five-GiB memory maximum, four-GiB
memory-high threshold, zero swap, 64 tasks, 300-second runtime limit,
read-only system and home protections, disabled core dumps and AF_UNIX-only
network family. A private mode-0700 `RuntimeDirectory` supplied temporary
cache space after the original read-only sandbox refused Python's temporary
directory lookup. It did not make the model or environment writable.

Two public English/French inputs produced finite, unit-normalized,
1,024-dimensional vectors. Identical batches repeated bitwise, as did
identical single inputs. Changing batch shape did not: maximum absolute
component difference `5.960464477539063e-08`, dot product
`0.9999999884897768`. The diagnostic used about 3,935 MiB peak RSS and
5.247 seconds for model loading and four short embedding calls. The
cross-batch exact-equality assertion still failed; no tolerance replaced it.
This measurement neither establishes batch-independent vector bytes nor
proves throughput, the full 8,192-token limit or ranking quality.

Before production startup, close the Python/wheel/native-library inventory,
ship a sealed provider module and service isolation, and test exact input
limits, bounded concurrency, refusal behaviour and text-free diagnostics.
The fixture silently truncates token overflow and is not a production
refusal gate. Prove the actual KF-held engine startup, permission masks,
recovery and reboot against the installed release. No listener, live index,
release promotion, backup, restore or qualification was created by these
probes; all five existing KF services remained active.
