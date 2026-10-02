# Embedding runtime assembly and startup

This is an offline, host-bound retrieval runtime candidate, not a commissioned
service or an independent qualification. The assembler, inventory verifier and
launcher are separate auditable modules. Neither the database kernel nor the
business workflow layer needs to know how Python is packaged.

## Interface

Run assembly against already trusted public build artifacts on the selected
Linux host. No command here resolves packages, downloads a model, reads an
encrypted store or changes the live application release.

```sh
sudo node scripts/embedding/assemble-runtime.mjs \
  /usr/bin/python3.13 /usr/lib/python3.13 \
  /absolute/source/site-packages /opt/kf-runtimes/NEW_RUNTIME
```

The destination must not exist. An unsuccessful build stays at its explicitly
named destination for inspection; it has no successful manifest and is never
accepted as an installed runtime. The assembler copies the interpreter,
standard library and package tree, omitting generated Python bytecode. File
links are materialized; directory links and special files refuse. Modes and
file ownership are explicit, rather than inferred from a successful privileged
copy. Assembly performed by root creates the custody required at startup.

Every directory and regular file is recorded by relative path and mode; files
also carry size and SHA-256. Loadable ELF files have their dependency sets
recorded. Relocatable build objects remain inventoried, but are not treated as
executables. A no-dependency extension requires the absence of `DT_NEEDED`,
confirmed by `readelf`, rather than an unconditional interpretation of `ldd`'s
"statically linked" output. Unresolved or unfamiliar dependency output refuses.

Libraries within the runtime tree remain internal dependencies. External
libraries remain declared, root-protected **host dependencies** under approved
system library roots; their logical paths, resolved paths, modes, sizes and
digests are sealed. This is not a claim that the directory is a portable
self-contained Python distribution. Host-library updates require a fresh
runtime contract and test, not a silently relaxed digest.

The manifest format is `kf-embedding-runtime-v1`. Its SHA-256 is printed on
successful assembly. Supply that independently retained pin to verification;
never derive the expected pin from a candidate immediately before trusting it.

```sh
node scripts/embedding/verify-runtime.mjs /opt/kf-runtimes/NEW_RUNTIME EXPECTED_SHA256
node scripts/embedding/launch-runtime.mjs \
  /opt/kf-runtimes/NEW_RUNTIME EXPECTED_SHA256 \
  /opt/PROTECTED_KF_RELEASE/scripts/embedding /opt/PROTECTED_MODEL 8021
```

Verification checks the exact closed tree and each host file, and requires
root custody without writable or linked runtime ancestors. Extra or missing
files, changed bytes, changed modes, unsafe ownership and changed external
library targets refuse. The manifest is size-bounded, as are individual files,
the whole tree and the number of entries. Root may update a host library; that
does not silently authorize the new bytes.

The launcher verifies before executing Python. It uses `-I -S`, so inherited
Python configuration, the working directory, `.pth` hooks and `sitecustomize`
cannot supply imports. Only the inventoried package tree and the protected
provider directory are added explicitly. The child's environment is fixed and
offline; the workstation's secret environment is not forwarded. SIGTERM and
SIGINT are forwarded, and the provider's exit status propagates, including its
inference watchdog's nonzero abort. Production supervision remains systemd's
responsibility.

The provider separately verifies the pinned model before importing ML packages;
its input, inference and transport limits are unchanged. See the
[provider contract](embedding-provider.md).

## Selected-host candidate evidence — 2026-10-02

The candidate at
`/opt/kf-runtimes/python313-bge-cpu3-candidate-v1-20261002` has manifest SHA-256
`0c7f0c7ee64e46e2c64a55d37a98e34cc68297928149adc3db50231298492c30`:
22,123 tree entries, 207 loadable ELF files, 25 declared host library paths and
913,434,569 regular-file bytes. Python is 3.13.5, NumPy 2.5.3 (the retained
scalar-baseline source build), Torch 2.11.0+cpu and Transformers 5.5.3.

The actual copied interpreter imported those ML packages without the previous
virtual environment or host standard-library path. The root-custody verifier
accepted the corrected candidate as an ordinary user. Earlier assemblies
refused a valid setuptools data filename, a relocatable Python build object,
a no-DT_NEEDED extension and retained source ownership. Those observations
were not changed into successful builds. The filename regression failed
before its correction; a real compiled no-DT_NEEDED fixture and executable
assembly exercise are now part of the ordinary test suite.

The launcher started the real provider under a read-only, loopback-restricted,
resource-bounded temporary systemd unit using the existing probe user. An
explicit operator stop ended that first successful start with result `success`
and main status 0, before its fixed lifetime. This is an isolated candidate
lifecycle observation, not an installed service account or reboot proof.

A second temporary start passed the actual HTTP public-input probe with
`--full-token-limit`: 64 short inputs, exact canonical repeated vectors,
overflow/wrong-model refusals and a full 8,192-token input. The combined probe
completed in 120.197 seconds; this is not a per-input latency statistic or
mixed/long-batch capacity qualification. Its public-vector digest remained
`abda3c6e2bfd996a43f49c252d8019dc887e5ef4608536e21c0d33c16bf76dc3`.
The ordinary optimized LAMU client resolved the same CPU3 provider identity.
An explicit stop again returned result success and main status 0, before the
300-second lifetime. The existing five KF modules remained active and the
live release link remained unchanged. Two earlier probe invocations failed
at the caller (isolated-script import path, then an unsupported argument);
they did not run the HTTP assertions and are not counted as passes.

The actual root-owned candidate refused an added, unlisted public file with
verification status 1, then verified with status 0 after the file was moved
to the named fault-plant directory. Archive creation must follow completed
plants and a restored inventory: the first archive overlapped that plant,
reported a changing tree and failed. That archive is retained as
`runtime.failed-inventory-plant.tar.gz`, not used as the runtime candidate.
The serialized replacement archive contains the closed 22,125-member tree
(including its root directory and manifest).

## Remaining release work

Retain the public source/wheel reports and licenses with the runtime artifact,
bind its pin and recipe to the promoted release's inventory, and verify the
actual required runtime imports on installation. Native dependency inspection
is an ELF-linkage contract, not proof about every possible future `dlopen`,
optional package, hardware or application. Representative provider execution
and an explicit service configuration remain required.

Install dedicated provider/engine identities and persistent supervision; prove
actual KF-held key release, encrypted index, permission-mask integration,
retry behaviour, restart and reboot. Complete encrypted preservation and
restore, host commissioning, corpus relevance and independent qualification
separately. No backup, approval, authority grant or cutover is produced by an
assembly manifest.
