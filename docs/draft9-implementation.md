# Draft.9 implementation

Basis: [KF SAS 0.1.0-draft.9](sas/KF_Software_Architecture_Specification.md), proposed source
digest `d0dccd75bc0b8dcda54688a5d2bcfa4be760ff883da556614b40696e81f4c32f`.
Implementation starts from `e6f67fe66e3e34237f67c8ab76c176d822a7232e` in a separate worktree.

The owner requested implementation on 2026-09-30, selected the existing KF VM, and confirmed
that KF releases the retrieval encryption key at startup. The owner selected
`/mnt/2tb/kf-preservation`, on `/dev/sda`, independently of the VM's `/dev/nvme0n1`.
These instructions authorize implementation; they do not create signed acceptance,
schema-pack approval, an identifier allocation or a cutover record.

## Delivery order

1. Restore clean-machine startup (§100.40): build the pinned MinIO releases from verified public
   source, retaining the same provider and shared build recipe. Exercise bucket initialization,
   object versioning and read-back on an isolated stack.
2. Complete the correctness and scale pass: restore invalidates retrieval masks (§100.29);
   context and master-record reads avoid unnecessary full-manifest reads (§100.43); embedding
   runs with bounded concurrency and retryable claims (§100.44). Keep search-quality figures
   visible (§100.45), and treat ranking changes as measured proposals.
3. Implement KF key release (§100.39), with an authenticated local startup seam and no plaintext
   persistent key file owned by the retrieval engine. Prove refusal with a wrong peer, a stopped
   broker and an invalid release. Keys never enter source, command arguments or logs.
4. Promote the tested release onto the existing VM. Exercise the installed services, private
   TLS, identity, checkpoint isolation, off-device encrypted backup, restore, alert delivery and
   reboot; record every commissioning result. Human observations and acceptance remain pending
   until actually received. Qualification follows hosting and the correctness pass (§24A).
5. Build qualification (ADR 0038, §100.41, RQ-254–261): two governed object types, explicit pack
   composition, pinned requirements and revisions, exact evidence modes, credit during work
   acceptance, computed currency, organization blockers, declared action requirements and a
   confidential Start Here projection. Roles remain pack data; qualification grants no authority.
6. Exercise CEO and aero-engineer Véracier packs and every ADR 0038 planted case through the
   same dispatcher, then run the repository gate. Rebuild ontology, preservation inventory and
   measured documentation. Report implementation evidence separately from human release acts.

## Completion evidence

- A clean checkout starts its declared dependency stack without an unavailable image.
- A real authorized user admits a document, finds it by words and requested meaning, reads its
  source and projection, and receives uniform refusals for unauthorized records.
- The selected VM passes commissioning against the exact promoted release after reboot.
- A qualification pack added for a new role requires no code change. Exact evidence and affected
  behavioural revisions change eligibility; permissions remain governed by ordinary grants.
- Full repository gate passes on the resulting implementation. Provider, host, alert-recipient,
  signing and acceptance evidence is claimed only when observed.

## Implementation checkpoint — 2026-09-30

The following is local implementation evidence, not release acceptance or host commissioning:

- The pinned-source object-store smoke test passed bucket initialization, versioning on all
  four declared buckets and exact object read-back. Its isolated stack was removed afterward.
- Embedding requests now run with a validated, bounded concurrency setting, outside database
  transactions. The integration tests demonstrate overlap within the requested bound and
  refusal of invalid settings before any claim is taken.
- The ntfy/Healthchecks provider and guarded systemd drop-ins are implemented. The owner
  confirmed the workstation dispatcher's generic notification on the iPhone; see
  [phone alerts](deployment/phone-alerts.md) for the remaining real-host tests.
- A real Pandoc reader difference exposed an unrecorded source transformation: GFM can replace
  NUL before returning its AST. A failing minimal reproduction and regression tests preceded
  the fix. Text-input replacements now record original byte ranges and retain the original
  source digest; binary inputs are untouched. The regression projection matched on workstation
  and VM Pandoc versions.
- Compatible dependency updates cleared the security audit, including removal of the obsolete
  Vitest exception. The full `pnpm gate` exited successfully: 2,844 tests passed, 24 opt-in tests
  skipped, no known dependency vulnerabilities, generated files unchanged and production build
  successful. The gate still reports six existing fixture lint warnings and 83 ontology
  warnings; neither skipped checks nor a successful gate demonstrate runtime qualification.

The owner subsequently selected workstation encrypted-store custody. A digest-versioned host
bootstrap now supplies only the two alert endpoints into private guest tmpfs, over pinned SSH,
without a persistent plaintext copy or guest decrypting key. Its enabled workstation timer
restored both credentials automatically after a real VM reboot; the previous five KF modules
returned active. A systemd credential-copy probe passed; the ordinary guest account could not
read the root-only source. See [phone alerts](deployment/phone-alerts.md) for exact evidence and
scope. This does not complete the separate retrieval-key release requirement.

The source changes are in `implement/draft9`, not a promoted application release. The VM still
uses its earlier application release; the ntfy/Healthchecks alert drop-ins remain uninstalled.
The remaining correctness pass, retrieval-key release, real-host
commissioning and qualification remain open in the delivery order above. The selected second
drive is independent-device storage, not an off-site copy.

## Recovery checkpoint — 2026-10-01

The [live recovery procedure](backup-and-restore/README.md#live-recovery-stop-permission-cache-holders-first)
now has an executable, persistent interlock. It stops the API, worker and every explicitly
declared external cache-holder unit, refuses starts while held even after reboot, and only
requests fresh processes after the operator confirms recovery verification. Its scope must
include every host using the restored database; undeclared or unmanaged processes are not covered.
It does not mutate the restored snapshot or manufacture a recovery-verification receipt.

Seven coordination tests cover stopping, retry, list retention, unsafe files and names, missing
units, control-group stopping and refusal to resume surviving processes. An opt-in test against
the real workstation user-systemd manager demonstrated that a synthetic cache-holder PID dies,
cannot restart while held, and reads changed classification in a fresh process even though the
restored version token repeats. The existing retrieval and restore-verifier/drill regressions
also passed. No production database was restored and no VM recovery or reboot commissioning is
claimed. Deployment and exact-host recovery proof remain outstanding.

## Read-path checkpoint — 2026-10-01

The master-record GET, whole-corpus projection routes and AI planner now share the existing
database currency proof instead of always re-enumerating every permitted content payload. A
stale claim is refused before loading its full-record response. Full-record GET retains its
manifest wire contract; v3 projections read validated item payloads rather than the full manifest.
Legacy members and exact withdrawn-member facts retain the manifest fallback. Budgets still
refuse rather than truncate and are checked before projection payload reads. Current verification
labels remain live, under row security and current grants.

The context source and claim header read `manifest_format`, a stored generated column derived
from the immutable manifest. It cannot be independently authored and is not added to canonical
export rows; restored archives recompute it. A rolled-back synthetic physical-layout probe
measured 138 shared buffers for the previous JSON format extraction and 2 for the header. This
is a database read-cost regression proof, not an organization-scale latency qualification.

Item-backed reading exposed a missing guard: the existing statement check accepted a title or
classification different from its manifest. Two planted regressions reproduced that acceptance.
The replacement checks both fields as well as the existing content identity, once per statement;
its migration refuses pre-existing contradictions rather than silently rewriting claims. This is
forward-only hardening (`20261001000200_item_metadata_matches_the_manifest`), moving the rollback
floor and requiring a freshly rehearsed receipt for the next sealed release. No live database
has been migrated by this work.

Preservation import disables user triggers while restoring rows. It now checks item identity,
title, classification, digest and payload against the immutable manifest explicitly before
accepting the restored database. Two altered archives, authenticated by an ephemeral trusted
test key, were accepted before the fix and are now refused. Failed restores roll back the rows
and trigger state; untouched archives still restore and recompute their generated format header.

Thirteen focused real-database tests cover header derivation, query shape, byte-identical projection
results, budget/parameter refusal before payload reads, measured TOAST avoidance, contradictory
item/import refusals and refusal to migrate contradictory historical data. Existing format-compatibility,
projection and Object View regressions also passed. Whole repository gating and real-host
qualification are separate evidence; neither this checkpoint nor a header optimization qualifies
search ranking, key release or the hosted application.

The full `pnpm gate` subsequently passed: 295 test files passed, four opt-in files skipped,
2,873 tests passed and 25 skipped. Dependency audit reported no known vulnerabilities,
generated outputs remained current and the production build succeeded. Six existing fixture
lint warnings and 83 ontology warnings remain. The batch is local implementation only: no
application release was promoted and no host or search-quality qualification is claimed.

## Retrieval-key broker checkpoint — 2026-10-01

The KF side of startup key release is implemented as a socket-activated, single-connection
broker with a small Linux kernel-credential atom. It admits one configured UID, requires the
request's exact release-manifest digest, authenticates executable inputs before invoking the
whole-tree release verifier, and only then reads its own private tmpfs credential. It refuses
active swap, unsafe files and malformed keys; key bytes go only to the accepted socket. The
broker has a separate unprivileged identity and no database or document authority.

Nine connected-socket and declaration tests cover exact release, wrong UID, stale/extra framing,
drifted verifier/data bytes, unsafe credentials, active swap, a stopped listener, non-socket
stdin and packaging/contract alignment. They use a public fixture key, the compiled helper,
real packaged dbmate and the existing release verifier. The successful fixture injects an empty
swap table because this workstation has active zram; the deployed CLI does not. The native unit
declarations pass `systemd-analyze verify`, not an execution or commissioning proof.

Provisioning originally copied only services and timers. A planted test demonstrated that the
new socket unit was silently absent; provisioning now copies socket units too and creates the
separate broker identity. No host account or installed unit was changed by these tests.

The [broker contract](deployment/retrieval-key-release.md) pins its request/response framing and
remaining integration: LAMU's authenticated client, the fixed workstation retrieval-key handoff,
the selected engine account and exact-release policy, real service-manager identities, startup
and reboot proof. The existing two-alert-credential host bootstrap is unchanged, no real retrieval
key was provisioned and §100.39 remains open until that complete path is observed.

The full `pnpm gate` passed after this broker batch, including dependency audit, current
generated outputs and production build. Existing fixture/ontology warnings and opt-in skips
remain separate from runtime qualification. No release was promoted onto the VM.

## Joint startup-seam checkpoint — 2026-10-01

LAMU's Linux client now authenticates the root-owned listener and kernel peer before sending
the exact KF release pin. It refuses malformed or oversized responses and requires EOF under
one whole-operation deadline; its fixed receive buffer is erased on success, refusal and
cancellation. CLI key-source options are mutually exclusive, with no file fallback after a
broker refusal. Invalid startup cannot create an index or listener.

The real selected-VM fixture exposed a custody mismatch: systemd 257 supplies root-owned,
read-only copies with a service-UID ACL, not a service-owned `0400` file. A separate sealed
Linux custody atom now checks exact ownership, modes, ACL and read-only tmpfs mount flags
without reading key contents. It refuses widened rights and incorrect identities. A shared
builder supports target-compatible static musl: workstation glibc CRT artifacts carried an
x86-64-v3 floor and were refused by the VM before application code ran.

The unchanged production broker and actual LAMU client passed through PID 1's root listener,
an unprivileged broker and a separate client UID on the selected VM. Wrong client UID, altered
sealed release data and a stopped broker all refused. The fixture used only a known public
key and temporary units/directories, which were removed; no installed account, live key,
production alert, database or index was changed. See the
[broker contract](deployment/retrieval-key-release.md) for the executable proof and limits.
The three-credential encrypted-store handoff, installed engine and exact policy, promoted
release and startup/reboot commissioning still remain; §100.39 is not closed.

The embedding observer also had a false-positive race: it counted a different consumer's
legitimate completion transaction as a transaction held across inference. The regression now
delays that completion deterministically and samples only when all consumers are awaiting
inference. Planting a real transaction held across inference still failed the assertion.
Worker production code is unchanged by that test correction.

The full `pnpm gate` passed on this batch: 297 test files passed, four opt-in
files skipped, 2,888 tests passed and 25 skipped; dependency audit found no known
vulnerabilities, generated outputs stayed current and the production build passed.
Six existing fixture lint warnings and 83 ontology warnings remain. This does not
promote a release or establish hosted qualification.

## Fixed three-credential handoff checkpoint — 2026-10-01

Source `workstation-credentials.mjs` now uses a distinct v2 bundle for exactly the two alert
endpoints and `KF_RETRIEVAL_INDEX_KEY_HEX`. Missing or malformed keys and v1 bundles refuse;
an alerts-only generation cannot satisfy v2 readiness. All three are published atomically in
root-only tmpfs and bound to the guest boot. Refused updates preserve the prior generation.
SSH retains its clean child environment, pinned host/receiver bytes and bounded framing.
Owned bundle/chunk buffers are erased after use; runtime string copies are not guaranteed
erased. Persistent plaintext storage or whole-store export is not introduced.

Two failing regression tests preceded the change. Eleven handoff tests then passed, and the
selected VM fixture composed the public bundle's root-only key source, PID 1 credential copy,
production broker and actual LAMU client. Wrong UID, sealed release drift and a stopped broker
still refused. This is public-fixture integration evidence only. The installed v1 bootstrap,
encrypted secret store and live VM credentials were not changed. Provisioning the selected
key, digest-versioned upgrade and actual startup/reboot evidence remain open.

The full `pnpm gate` passed afterward: 2,890 tests passed, 25 opt-in tests skipped,
dependency audit clear, generated outputs current and production build successful.
The existing fixture/ontology warnings remain; the gate is not hosted qualification.

## Actual encrypted-store delivery checkpoint — 2026-10-01

The selected key is now held in the workstation's encrypted store and the digest-versioned
v2 bootstrap is installed on workstation and guest. The actual timer-driven delivery passed
receiver readiness for all three credentials. Root-only guest tmpfs custody, ordinary-user
key refusal and a value-aware startup-journal secrecy check passed. No key value was written
to persistent plaintext, an argument or a log. No existing index was rotated. See
[phone alerts](deployment/phone-alerts.md#actual-three-credential-delivery--2026-10-01)
for the exact artifact and observed scope. The real engine, exact policy, application release
promotion, v2 reboot proof and host alert/commissioning tests still remain.

A fresh sealed-release build stopped at a test that assumed its repository directory was
disk-backed. The disposable checkout is on `/tmp`, which is tmpfs on this workstation;
the production handoff correctly accepted that destination. The named test reproduced in
that checkout and passed in the disk-backed implementation tree. Its negative fixture now
selects and asserts an actual non-tmpfs mount and verifies refusal creates no runtime root.
All eleven handoff tests passed in both locations. Production custody checks are unchanged;
the stopped build is not a release artifact or a successful full gate.

The full `pnpm gate` then passed in the implementation tree: 2,890 tests passed and 25
opt-in tests skipped, dependency audit clear, generated outputs current and production
build successful. The existing six fixture lint warnings and 83 ontology warnings remain.
The approved `/mnt/2tb/kf-preservation/releases` directory was created privately after
confirming `/dev/sda` is separate from the VM's `/dev/nvme0n1`. No artifact replica or
encrypted backup has been written there yet, and it is not an off-site destination.

## Sealed candidate staging checkpoint — 2026-10-01

The clean disposable release build at `cf40e8e622469b4758ff5dedbeb57bbff6e779b3`
passed the full gate, packaged all runtime trees and sealed 36,302 files. The archive
`knowledge-fabric-cf40e8e62246.tar.gz` has SHA-256
`6ad7849a9e5cb481238fe946e6ed704884817c5de27c1b71e31a8e3a5a3bab90`;
its `SHA256SUMS` digest is
`bc243e78968bae036eb6f3b644f1aa50bbb2b018b0cc4dd76eeff504c57cebe1`.
Both private archive copies verified on `/mnt/4tb/kf-vm/releases` and the independent
`/mnt/2tb/kf-preservation/releases`. This is artifact replication, not encrypted data backup
or an off-site copy.

The archive was extracted as root into
`/opt/kf-releases/knowledge-fabric-cf40e8e62246` on the selected VM without changing
`/opt/kf`. The packaged whole-tree release verifier passed against the exact manifest,
root ownership and packaged dbmate 2.35.0; Bash measured 4.855 seconds. An initial timing
wrapper stopped before verification because `/usr/bin/time` was absent; no re-extraction
was attempted, and the successful retry used Bash's built-in timer. Native helpers are
baseline static musl, not workstation glibc CRT artifacts.

The live link still names `637677e2c5e1`. Its five main services remain active; the database
has 91 applied migrations through `20260911000200`. No production migration, release
switch, rehearsal receipt, backup, restore, engine installation or reboot was performed by
this staging. The candidate records tested Node 24.21.0; the installed VM runtime is
24.18.1, so the tested-runtime commissioning comparison also needs reconciliation before
promotion. The full target-compatible LAMU engine build and post-watcher-fix default suite
are separate running jobs, not inferred from this KF gate.

## Tested Node runtime reconciliation — 2026-10-01

The selected VM now has `/usr/bin/node` version 24.21.0, matching the staged
candidate's sealed `BUILD-METADATA`. The official Linux x64 archive was checked
against its clear-signed checksum message using the Node release keyring at
commit `481637f813e912c4aa3622d7964ab426c97b8e8d`. GPG reported a valid signature
by fingerprint `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`. Its warning says the
separate checksum file is not independently signed; the extracted checksums
were also compared with the signed message payload, apart from the signature
separator newline. This follows the
[upstream binary-verification procedure](https://github.com/nodejs/node#verifying-binaries).

The archive's SHA-256 is
`fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6`;
its extracted `bin/node` digest is
`7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.
The public archive, signed checksums, extracted checksums and pinned keyring
are retained privately under `runtimes/node-v24.21.0-linux-x64` in both
`/mnt/4tb/kf-vm` and `/mnt/2tb/kf-preservation`; both archive copies verified.
These are runtime artifact copies, not database backups or an off-site copy.

Transport bytes were checked again before root-owned guest extraction into
`/opt/kf-runtimes/node-v24.21.0-linux-x64`. The baseline guest ran its version,
crypto and in-memory SQLite probes as `kfadmin`. After those passed, the old
root-owned regular `/usr/bin/node` was retained at
`/opt/kf-runtimes/node-v24.18.1-root-binary/node`, with unchanged SHA-256
`f3432a45b03b2da0d270095fdd8813dc34cbea73f5fc8b18c7a384b7cf9b333a`.
The new executable was verified and atomically renamed into place. The
pre-existing unprivileged `/opt/node-v24.18.1-linux-x64` tree was not used as
the trusted rollback copy.

All five live KF services stayed active. A new workstation credential-delivery
oneshot succeeded with exit zero, its timer remained active and the guest v2
receiver reported ready under the new runtime. No application service was
restarted, `/opt/kf` was not switched, and no database migration, restore or
reboot occurred. The API, web and worker still hold the old executable; runtime
parity for those running services must be proved after the guarded release
promotion and restart. Installed Node parity alone does not commission the host.

## Retrieval runtime checkpoint — 2026-10-01

The previously running LAMU jobs have terminal results. The pinned Rust 1.89.0
default-member suite passed at clean source `10854d1`: 1,571 passing tests,
zero failures and 15 ignored tests across 61 test executions. This is a new
full-suite result; the earlier CLI deadline failures remain historical evidence.
No deadline was enlarged. The corrected isolated-`libdl` baseline musl debug
build also finished and passed a public loader probe on the selected VM.

An optimized, baseline x86-64, self-contained musl engine was then built at
clean LAMU source `a20e5154016c3fb7d98af1884ba54113bd20e3fb`. This is a
documentation-only successor to the full-suite source. Its SHA-256 is
`e02e3bf7e66443f411c823b1da4b54fb8a7523a7582205ade02f8019dfc93a33`.
The selected VM verified those bytes and ran its version and startup-key CLI
help as an ordinary user. KF's real-engine suite passed all ten tests against
this binary with an explicitly absent developer settings file. Those tests
use the hash embedder: they establish protocol, masks, refusals and encrypted
storage, not semantic ranking quality or real-key startup.

The pinned BGE-M3 public model is staged under `/opt/kf-models` after archive,
closed-file-set, per-file and source-provenance checks. An actual CPU model
probe exposed NumPy 2.5.3's incompatible `X86_V2` wheel baseline. A source
build of the same version with `cpu-baseline=none` and `cpu-dispatch=none`
passed import and matrix checks without changing the VM CPU or disabling its
guard; the `SSE2` build did not. Its source, wheel, license, install report and
build log have verified copies on both local devices.

Under the resource-limited service-manager probe, the real model produced
finite, normalized 1,024-dimensional vectors. Repeating an identical batch
and an identical single input was bitwise exact, but changing batch shape was
not: the maximum component difference was `5.960464477539063e-08`. The
cross-batch exact-equality assertion remains failed; it was not replaced with
a tolerance. [Retrieval runtime evidence](deployment/retrieval-runtime-evidence.md)
records the recipe, artifacts and scope boundaries.

This remains a probe, not a commissioned provider. A sealed Python/provider
closure, service isolation, input-limit refusals, the actual KF-held engine
startup, recovery and reboot proof remain open. All five existing KF services
stayed active and `/opt/kf` still selects `637677e2c5e1`. No live index, release
promotion, backup, restore, qualification or human approval was created.

## Composed provider checkpoint — 2026-10-02

The local embedding provider now has separate model-verification/input-policy,
bounded HTTP transport and CLI orchestration atoms. It retains the existing
LAMU embedding interface, refuses token overflow rather than truncating, and
uses an explicitly distinct CPU3 canonical-single-input model identity.
[Provider contract and evidence](deployment/embedding-provider.md) states the
limits and remaining production inventory work.

The ordinary gate executes 18 Python interface tests through Vitest without
ML dependencies. Isolated owned-copy plants admitting one extra token,
echoing an arbitrary refusal and failing to abort inference were each caught
by named tests. The initial full gate found a real connection-admission race;
the same delayed header/body regression failed before the bounded half-close
and drain correction and passed afterward. The next full gate passed:
2,891 tests, 25 skipped; 298 files passed, four skipped. Audit, ontology,
generated-output and production build steps passed with the existing fixture
lint and ontology warnings. These are local implementation checks, not an
independent verification or a release approval.

On the selected VM, the full 8,192-token public input completed in 149.928
seconds with three inference threads, under unchanged memory and time limits.
The one-thread timeout and original fixture's cross-batch difference remain
historical evidence. The final HTTP CLI separately passed 64 short inputs,
exact canonical repeatability and overflow/wrong-model refusals, and the
ordinary optimized LAMU client resolved its new identity. No real key,
index or KF record was used. After the tests, the transient provider reached
its fixed 300-second probe lifetime and the supervisor stopped it as a timeout;
the subsequent explicit stop found the unit already collected. Its runtime
directory disappeared and the existing five KF modules remained active. This
does not prove an operator-initiated normal stop or production restart.

The provider's complete sealed Python/native runtime, dedicated installation,
actual KF-controlled engine startup and reboot proof remain open. No live
application release, backup, restore, qualification or human act was promoted
by these checks. Hosting and correctness still precede qualification.

## Host-bound embedding runtime checkpoint — 2026-10-02

The offline assembler, closed-tree/native-library verifier and isolated Python
launcher now exist as separate atoms. The selected VM built a root-protected
candidate with 22,123 tree entries, 207 loadable ELF files and 25 declared host
library paths. Its retained manifest digest is
`0c7f0c7ee64e46e2c64a55d37a98e34cc68297928149adc3db50231298492c30`.
The copied interpreter imported NumPy, Torch and Transformers without the old
virtual environment or host standard-library import path. Verification accepted
the corrected candidate before real model startup. An explicit stop ended the
first successful temporary provider unit with result success and main status 0,
not the earlier diagnostic unit's lifetime timeout.

A second temporary start passed the actual HTTP probe including the full
8,192-token input, 64 short inputs, canonical repeatability and refusals;
the combined probe took 120.197 seconds. The ordinary LAMU client resolved
the same recipe. An explicit stop again returned success and main status 0.
This is not mixed/long-batch capacity, a persistent account or a reboot proof.

Failed intermediate assemblies remain distinct evidence. The filename guard
was observed rejecting actual setuptools data with spaces and parentheses;
its regression failed before the correction. Python build objects and
no-DT_NEEDED extensions are now distinguished from unresolved dependencies.
Source-user ownership survived some initial copies and was correctly refused
by startup; assembly now sets ownership explicitly without relaxing custody.
See the [runtime contract](deployment/embedding-runtime.md) for bounds and
remaining integration. This host-bound runtime still requires production
release inventory, dedicated installation, actual key/index integration,
preservation/recovery, reboot and host commissioning. Qualification remains
after those proofs; neither a manifest nor a candidate lifecycle is acceptance.

## Composed startup checkpoint — 2026-10-02

The [startup contract](deployment/retrieval-startup.md) now separates the fixed
non-secret configuration, bounded readiness and orchestration from the existing
runtime and engine. Root custody and pinned recipe bytes precede child execution;
the only engine key source is the authenticated KF broker. Dedicated identities,
shared private network, event-only credential activation and the existing recovery
holder name are declared. A planted provisioning test first failed because the
new identities/path unit were absent; provisioning now includes them and the
explicit API/worker filesystem group, without generating a retrieval key.

Public native-unit tests on the selected VM passed private-network isolation,
the full model interface under the syscall filter, actual LAMU identity,
credential presence/event/recovery-guard behaviour and recipe-drift refusal.
They exposed a real provider restart failure: an old TCP connection's `TIME_WAIT`
blocked binding. The minimal Linux lifecycle regression failed before enabling
address reuse, then passed while a second live listener still refused. The real
provider restarted with the peer PID and namespace unchanged after that fix.

The production orchestrator started the real provider from a pinned public
fixture. Against a ready provider but missing broker, the actual engine refused
before creating its store or socket. Earlier unsupported caller arguments,
a disconnected public harness and an omitted private-temporary-directory probe
setting remain recorded failures, not successful startup evidence. The corrected
provider stopped explicitly with success/status 0; the peer's fixed probe
lifetime ended separately as a timeout. Probe activations are stopped and their
temporary installed unit links are retained outside the service manager's search
path. No live application release, database or actual retrieval index changed.

Fresh sealed-release construction, installed real-key startup and permission-mask
integration, migration rehearsal/promotion, recovery/reboot commissioning,
encrypted preservation, off-site backup and qualification remain in the delivery
order above. New service accounts and source declarations do not close §100.39.

## Fresh startup release staging — 2026-10-02

Exact source `bdbe15e937183b3bd02788782a0e3abe5e67997c` passed `pnpm gate` in
both the implementation tree and a fresh disposable release checkout: 2,935 tests
passed, 25 skipped, 300 files passed and four skipped. Audit, generated-output
checks and production builds passed; existing fixture and ontology warnings remain.

The clean build sealed 36,319 files, including the startup modules, under Node
24.21.0 and pnpm 11.21.0, with dbmate 2.35.0 and baseline static musl helpers.
Archive `knowledge-fabric-bdbe15e93718.tar.gz` has SHA-256
`a80a1fad73fad115f8c0081e562448bc12ea4544d5c021dd5e8bbfd3bdc096d1`;
its independently retained manifest digest is
`d65546b87e20b61b2c2325a42e7e75b8270386d7714eb78346dbc5ee077ca94d`.
The archive copies verified on both `/mnt/4tb/kf-vm/releases` and
`/mnt/2tb/kf-preservation/releases`. These are local artifact replicas, not
encrypted database backups or an off-site copy.

The VM's root-owned extraction at
`/opt/kf-releases/knowledge-fabric-bdbe15e93718` passed the packaged whole-release
verifier against that manifest, expected root custody and packaged dbmate.
`/opt/kf` still selects `637677e2c5e1`, and the five existing modules remain active.
The staging applied no production migration, generated no migration rehearsal
receipt, installed no permanent engine/broker policy and used no actual retrieval
key. Promotion, actual startup, encrypted preservation/recovery and commissioning
remain open before qualification. The gate and replica do not supply human acts.

## Migration custody checkpoint — 2026-10-02

The [migration credential adapter](deployment/migration-credential-custody.md)
now reuses the existing native metadata checker for three explicitly named,
bounded migration credentials. The retrieval broker's default index-key interface
is unchanged. Ordinary group-readable files remain refused; systemd custody
requires the actual root-owned read-only tmpfs mount and exact service-UID ACL.
The PostgreSQL password temporary file must be service-private unswapped tmpfs,
not the disk-backed directory that `PrivateTmp` may supply.

New refusal cases failed before implementation and passed after it. The selected
VM's public native-unit proof admitted the named credentials, removed passwords
from connection arguments and proved exit cleanup. Oversized/short/unknown
credentials, outside paths and incorrectly owned/writable helpers refused; the
positive proof passed again after helper custody was restored. No actual key,
database connection, migration, receipt or release promotion was used.

Inspection also found a real existing password exposure: the raw file-loaded
database URL was exported briefly before escaping, so parsing children inherited
its password. A public child-environment observer reproduced it and passed after
keeping the raw value local until password removal. Existing private-file,
receipt authenticity and retrieval-broker regressions passed (83 focused tests).

The first full gate failed on four existing database fixture deadlines (two
startup hooks and two preservation tests), not on a credential assertion. All
four files passed unchanged in a narrower run: 21 tests, original deadlines.
The full-suite bounded-worker experiment and the resulting complete gate are
still pending; neither the focused tests nor native custody proof substitutes
for that gate.

The existing rehearsal database contains 80 applied migrations, so it is not the
empty target required by the current rehearsal. It is retained, not reset. A
separate bounded encrypted-store migration handoff and fresh disposable target
remain next, before a new authenticated receipt and guarded promotion. Backup
custody/off-site choices and hosting, qualification and human release acts remain
open in the original delivery order.

## Test fixture budget checkpoint — 2026-10-02

The complete bounded-worker experiment passed all 304 files in its collected
manifest: 300 passed, four opt-in files skipped; 2,940 tests passed and 25 skipped.
It used four workers and unchanged fixture/test deadlines. The earlier default
run's four deadline failures are retained, not recategorized as passes.

The ordinary local/CI configuration now caps fixture workers at four, with a
regression holding that budget, file parallelism and the unchanged 30-second
default test/60-second hook deadlines. Every real PostgreSQL fixture and each
within-file concurrency case is retained. The ordinary full gate on this resulting
configuration was then run separately; the command-line experiment was not used
as a substitute. `pnpm gate` passed: 301 files passed and four opt-in files skipped;
2,941 tests passed and 25 skipped. Dependency audit found no known vulnerabilities,
generated outputs stayed current and the production build passed. Existing fixture
lint/ontology warnings remain. This is local implementation evidence, not a
promoted application release or host qualification.

The selected VM now has a fresh empty target on its separate port-5433 rehearsal
cluster: `kf_rehearsal_20261002_custody_v1`, owned by the existing rehearsal login,
with PostgreSQL's builtin `C.UTF-8` locale provider and UTF8 encoding. The exact
reserved/nonempty-target query used by the migration module returned `empty`.
The old `kf_rehearsal` remained at 80 migrations, highest `20260901000100`.
No production database, credential, role grant, migration or restore changed.
Bounded encrypted-store delivery, a new authenticated rehearsal receipt, guarded
promotion and the original commissioning/qualification/release acts remain open.

## Separate migration handoff checkpoint — 2026-10-02

The [migration credential interface](deployment/migration-credential-custody.md)
now has its own fixed protocol, environment names, guest tmpfs root and
workstation timer. It shares transport/custody atoms with startup delivery but
does not expand the startup bundle or expose an arbitrary secret exporter.
Connection validation refuses redirected or swapped targets, reserved database
names, encoded credentials and shared production/rehearsal credentials. The
receipt key's 64 ASCII hex bytes are preserved exactly for the existing raw-byte
HMAC contract.

The public selected-VM proof passed both realms and the refusal/preservation
cases. Nine new tests and existing custody, migration and broker regressions
passed. The full `pnpm gate` passed: 2,950 tests, 25 opt-in skips, 302 passed test
files and four skipped files; dependency audit clear, generated outputs current
and production build successful. Existing fixture/ontology warnings remain.

The real migration connections and a separate random deployment receipt key
are now in the workstation encrypted store. Actual pinned delivery succeeded,
the guest root-only tmpfs generation is ready, and the new enabled recovery
timer's oneshot exited zero. The rehearsal connection targets the fresh empty
port-5433 database; neither the old rehearsal database nor production was
migrated. Legacy guest connection files remain for existing consumers.

The working alert/retrieval v2 bootstrap and its generation are unchanged.
`/opt/kf` still selects `637677e2c5e1`, with all five existing modules active.
The new handoff has not yet been proved across a real reboot. Next are a fresh
sealed release, actual authenticated rehearsal receipt and guarded promotion;
preservation/recovery, hosted retrieval, commissioning, qualification and human
release acts remain open. This checkpoint is implementation/delivery evidence,
not authority or acceptance.

## Backup destination and custody selection — 2026-10-02

The owner selected Backblaze B2 and an owner-held Bitwarden recovery copy.
[The deployment contract](deployment/backup-custody.md) distinguishes that
selection from actual account creation, saved-key custody, transfer and restore
evidence. Existing OpenPGP encryption and Ed25519 preservation signatures remain
the contracts; neither receipt credentials nor another project's keys are reused.

The current off-site module is rsync-based. A B2 transport and matching restore
download path still need implementation and verification. Nothing was uploaded,
no provider account or bill was created, and no off-site readiness was granted
by this selection. These are no longer undecided choices, but their deployment
and the actual human recovery-key save remain open.

## Release permissions and authenticated rehearsal — 2026-10-02

[The migration checkpoint](deployment/migration-credential-custody.md#authenticated-rehearsal-checkpoint--2026-10-02)
records the failures and corrections, not just the final receipt. A restrictive
build umask exposed unreadable generated bytes and six permission-fixture
failures. Commit `6be020cc` fixes the secret-free creation and pre-seal mode
policy; its fresh exact release passed the full gate (2,954 tests, 25 opt-in
skips), was verified on the VM and copied onto the independent device.

The first real credential-backed rehearsal applied all 152 migrations but
failed at ontology seeding: the disposable owner did not match ADR 0026's
non-superuser `BYPASSRLS` contract. Production already matches it. The failed
target is preserved; only the isolated migration owner's attribute was
reconciled, and a new empty v2 target was supplied through the encrypted-store
handoff. Forced-RLS policies and application privileges were not changed.

The new native rehearsal passed and produced an authenticated v3 receipt for
the sealed `6be020ccff53` release. A separate verifier checked the actual
database, ontology, raw-byte HMAC and temporary-directory cleanup. All 152
migrations remain at floor `20261001000200`; zero down migrations ran because
the newest migration is itself forward-only. This is not full reversibility,
independent acceptance or readiness qualification.

The live link remains `637677e2c5e1`, with all five modules active. Production
migration and promotion still await preservation/recovery work; B2 transfer,
real restore, hosted retrieval/reboot commissioning, qualification and human
release acts remain open. The owner starts B2 setup at signup through the
prepared human-only helper; an account or saved recovery key is not claimed.

## B2 transport implementation — 2026-10-02

The [shared ciphertext transport](deployment/b2-ciphertext-transport.md) now
provides bounded upload/read-back and download of an exact historical version.
The small preservation interface composes contract, file/streaming and SDK atoms;
manifest authentication, encryption and the copy ledger keep their existing owners.
Controlled responses and an owned HTTP server exercise the actual pinned SDK,
including refusal, truncation, version/digest mismatch and cancellation. Public
framing fixtures are not an encryption or provider qualification.

This does not wire the rsync-based live scripts, record cloud copy identities in
the database, deliver B2 credentials to the VM, upload a real backup or restore
one. The owner starts the existing helper at signup; account/MFA and Bitwarden
recovery-key storage remain human actions. Production and the sealed release
remain unchanged. The ledger/CLI/restore integration is the next implementation
slice; hosting, qualification and release acceptance remain open.

## B2 caller and ledger integration — 2026-10-02

The [CLI and caller contract](deployment/b2-ciphertext-transport.md#cli-copy-ledger-and-restore-callers)
now connects source-authenticated backup copying, exact provider identities in
the existing append-only copy ledger, preservation export/import, and version-pinned
restore drills. Cloud URI confusion, historical-version retries, transfer failure,
conflicting history and optional physical-domain approval have explicit refusal
tests. The shipped append/retry SQL also runs against an isolated PostgreSQL 18
through a backup-role login, not just the shell fixture's fake database client.

Public native PID 1 credential probes on the selected VM admitted the four B2
purpose-specific names and refused empty/oversized credentials, index-key confusion,
inline fallback and unsafe helpers. The first fixture copy preserved a non-root
source owner and was correctly refused; the driver now explicitly installs its
copied helper as root. No installed production helper or real credential was changed.

The new forward-only migration moves the candidate floor to `20261002000100`.
The earlier sealed release and its authenticated receipt remain evidence of that
earlier tree; a newly sealed candidate needs a fresh empty rehearsal target and
receipt. Real B2 account/credentials, volatile delivery to the actual backup
consumers, encryption/recovery custody, cloud upload/read-back, isolated recovery,
production promotion, retrieval/reboot commissioning and qualification remain open.

## Separate B2 credential handoff — 2026-10-02

The [B2 custody interface](deployment/b2-credential-custody.md) now adds a third
closed realm to the existing pinned handoff module, without changing either
installed alert/retrieval or migration pair. Its payload contains only endpoint,
bucket, application-key ID and key. Separate timer templates recover volatile
custody, not backups or migration. Refusal and rotation tests preserve both
other realms. The public native VM proof also runs the actual receive/status
commands in a private mount namespace, never the real credential roots.

This does not claim account creation, real encrypted-store/SSH delivery, installed
B2 timer or PID 1 consumer activation. Production remains on its 91-migration
baseline. Baseline preservation/recovery must precede candidate migration;
consumer database/signing/decryption custody, Bitwarden recovery, live B2 copy
and restore, fresh release/rehearsal, guarded promotion, retrieval/reboot
commissioning and qualification remain open.

## Preservation consumer key adapter — 2026-10-02

The [preservation caller custody adapter](deployment/backup-custody.md#preservation-caller-custody-adapter)
adds two bounded credential purposes to the native guard. The backup stages its
native-checked signing input as an owner-only volatile file without relaxing the
export CLI's file contract. The drill validates the recovery credential through
that guard and requires its keyring/decrypted work to use the private, unswapped
runtime directory. Ordinary standalone owner-only inputs remain supported.

The focused shell/native-predicate checks passed, and the extended selected-VM
PID 1 fixture demonstrated admission, purpose/bounds refusals, exact volatile
signing-copy metadata and cleanup. Public fixtures are not cryptographic key
custody, an actual backup, a restore or production activation. Consumer delivery
and drop-ins, nested restore-verifier credential handoff, baseline recovery,
real B2 access, promotion, commissioning and qualification remain open.

## Preservation child credential handoff — 2026-10-02

The [child handoff interface](deployment/backup-custody.md#database-and-object-reader-child-handoff)
now gives the backup export child an admitted owner-only volatile database
input and gives the built-in object reader its separate admitted input. The
restore verifier binds re-export and checkpoint verification to the requested
scratch target, not an inherited production database file. Explicit systemd
custody distinguishes the private runtime target from the native ledger input,
and the nested verifier owns a fresh password file.

The public native proof found subshell exit-hook registration inheriting cleanup
for the parent's password file. Registration and owned-copy cleanup now use
process ownership, with a direct failing-then-passing regression. The corrected
focused set passed 71 tests across seven files; all 14 real PostgreSQL
backup/restore tests passed, including inherited-production-file isolation. The
extended selected-VM PID 1 fixture passed using the actual ordinary secret
loader, without admitting arbitrary group-readable files or changing installed
production credentials. Failed initial runs are retained as development evidence.

Actual consumer delivery/drop-ins, preservation of and recovery from the old
91-migration baseline, real B2 authentication/copy/recovery, Bitwarden key
custody, a fresh sealed release/rehearsal receipt, guarded promotion, retrieval
and reboot commissioning, qualification and human acceptance remain open.

## Purpose-separated preservation delivery — 2026-10-02

The [delivery interface](deployment/preservation-credential-delivery.md) adds
closed backup, offsite and drill realms alongside the existing three protocols.
Backup holds database/signing inputs, offsite only its ledger input, and drill
its ledger/recovery/object-reader inputs. Multiline keys use explicit canonical
base64 store names because the actual workstation secret command accepts one
line. Guest files preserve decoded key bytes; larger recovery framing does not
widen other realms' or files' bounds. Independent timer templates recover only
custody, never execute preservation or migration.

The focused handoff suites and selected-VM public native proof exercise field
sets, rotation/refusal isolation, actual receive/status commands and the maximum
recovery input. Public armor is deliberately not a valid GPG recovery key; these
checks do not establish decryption, real custody, grants, SSH delivery or consumer
activation. Distinct consumer drop-ins, baseline preservation/recovery, actual
key capture and Bitwarden recovery, B2 access, fresh release/rehearsal, guarded
promotion, commissioning, qualification and human release acts remain open.

## Native preservation consumer binding — 2026-10-03

The [selected binding](deployment/preservation-consumer-binding.md) adds three
fixed commands and optional overrides above unchanged preservation scripts.
They bind exact PID 1 file sets after environment-file loading, require private
unswapped runtime custody and trusted code/public routing, and invoke only a
fixed callee with a clean environment. Backup has no recovery input; drill has
no signer. The drill template deliberately requires a separate reader-key
source, not the uploader's key. That delivery interface was still missing in
this slice; the following section records its implementation, not activation.

Public native fixtures exercise actual binding, refusals, child status and
cleanup before runtime deletion. Removing the clean-environment guard fails
the native proof on an inherited password file. This is not actual SQL,
cryptographic preservation, provider operation or installed-unit proof.
Distinct live identities, grants, real keys/Bitwarden custody, the reader
handoff, baseline recovery, fresh release/rehearsal/promotion, hosted retrieval
and reboot commissioning, qualification and human acts remain open.

## Dedicated B2 drill-reader delivery — 2026-10-03

The [reader delivery interface](deployment/drill-b2-credential-delivery.md)
adds exactly two fixed encrypted-store names, its own root/protocol and
recovery templates. It does not export or fall back to uploader credentials.
Shared public endpoint/bucket routing stays separate. Existing six protocols
and pinned installed pairs are preserved; the new pair is not installed.

Nine new interface tests first reported eight missing-feature failures and
one existing generic-command refusal pass. The first implementation's inventory
check changed missing-file semantics; moving its new-reader-only check after
named reads corrected that regression. Focused checks now pass 48 tests across
five delivery files. The selected-VM public native proof passes root custody,
all-six-prior-realm isolation and actual private-namespace reader commands.
These are development proofs, not real provider access or qualification.

A deliberate uploader-token substitution made the same native proof fail at
`reader-source`; restoring the source returned it to PASS with matching local
and guest hashes. The fixture never installs or changes the live sender,
receiver or real credential generations.

The joined native consumer proof publishes the reader pair through the actual
handoff function in an owned private generation, then exercises PID 1 loading
and drill binding under the fixture UID. All 15 cases pass; deliberately using
the uploader source refuses with status `98`. This covers the integration seam,
not actual SSH delivery, provider permissions, encryption, SQL or recovery.

Actual reader-key creation/capture, provider read-only capabilities, SSH/PID 1
consumer activation, old baseline preservation/recovery, off-site exact-version
copy/read-back/downloaded restore, Bitwarden recovery, fresh release/rehearsal,
guarded promotion, retrieval/reboot commissioning, qualification and human
authority remain open. No production credential, route or acceptance is changed.

## Restored-owner migration finding — 2026-10-03

The packaged `4c285e13` candidate upgraded an authenticated restored 91-migration baseline
to 153 migrations as an isolated administrator, preserving all existing rows in eleven core
and artifact tables and passing candidate export/read-back. That did not prove the installed
migrator's permission path: its portable dump omitted privileges.

A second real signed/encrypted baseline includes database creation metadata, ownership,
grants and a password-free security inventory. It was retained and checksum-verified on
the workstation and `/mnt/2tb/kf-preservation`. In a fresh socket-only clone, the inventory
matched across roles, memberships, schemas, relations, routines, types, default grants,
extensions and the database. Bootstrap restoration was separate from migration. The actual
OS account `kf-migrator` then invoked the exact gated candidate apply path as the restored
non-superuser `kf_migrator_login`, with its declared `BYPASSRLS` and `CREATEROLE`, but without
`CREATEDB`. No production password was copied; the isolated clone used a closed peer map.

That apply refused with SQLSTATE `42501` in
[`20260924000200`](../database/migrations/20260924000200_row_security_is_forced_everywhere.sql):
it tried to force row security on the separately worker-owned `graphile_worker` queue. Those
tables enable row security without policies and rely on their ordinary owner's exemption.
The later [`20260926000200`](../database/migrations/20260926000200_the_job_queue_schema_is_declared.sql)
already declares this private queue outside KF's governed-record reconciliation; the earlier
upgrade did not respect that boundary. Granting the migrator ownership or granting the worker
`BYPASSRLS` would obscure the defect and is not the correction.

The [row-security regression](../tests/database/row-security-forced.test.ts) reproduced the
same schema-permission refusal under an ordinary KF owner beside a separately owned queue.
The source correction excludes exactly `graphile_worker` from this migration. The test
requires a governed-table positive control to become forced, the queue to remain unforced
and writable by its non-bypass owner, and an undeclared separately owned queue schema to
remain a refusal. Before the correction, one of five row-security tests failed at the actual
migration call; afterward all five and all 29 readiness tests passed.

The existing `4c285e13` archive and rehearsal receipt remain unchanged and do not attest these
new source bytes. They cannot be promoted as the corrected candidate. A new exact release,
repository gate and rehearsal, followed by the real-role restored-baseline upgrade, are
required. Production remains on `637677e2c5e1` with 91 migrations; this finding grants no
new authority and creates no approval, cutover, commissioning or qualification record.

## Restored-owner backup-grant finding — 2026-10-03

The exact sealed `38700842` candidate passed its complete repository gate, release
file checks and fresh 153-migration authenticated rehearsal. Its new real-role
restored-baseline apply passed the previous queue RLS boundary but refused in
[`20260925130000`](../database/migrations/20260925130000_the_backup_login_reaches_every_schema.sql)
with SQLSTATE `42501`: the ordinary KF migration owner cannot grant SELECT on the
separately worker-owned queue's sequences. The preserved ownership/security
inventory matched before apply. The later export and post-upgrade row probes were
not reached. Production release and database remained unchanged.

The [queue-owner interface](deployment/worker-queue-backup.md) now commissions
read-only queue backup access using its actual ordinary owner. Worker startup and
a no-argument CLI share that interface and credential policy. The KF migration
checks the read contract and excludes exactly that queue from its own grant loop;
it does not silently discard queue rows. It does not transfer ownership, widen
worker authority, or change queue RLS flags.

The real-library fixture proves owner provisioning, migration ordering, denied
backup writes and idempotence. Two additional tests exposed column-level UPDATE
and MAINTAIN grants missing from the first guard; both now refuse. The complete
backup-only-login drill restores a real queue job payload. These are local
implementation checks, not an upgraded VM. The `38700842` archive and receipt are
unchanged historical evidence and cannot attest the new bytes. A new exact
release, repository gate, fresh rehearsal and real-role restored-baseline apply
are required before considering guarded promotion; off-site recovery, key
custody, commissioning, qualification and human authority remain open.

## Loaded-system-manager commissioning (2026-10-04)

The mandatory `systemd_loaded_units` check now supplements file provenance.
It observes the local system manager through a fixed, bounded machine interface;
the CLI cannot select a fixture or remote bus. It compares concrete and template
instances against reviewed fragments, drop-ins, identities, alert targets,
pending-reload/transient state and declared no-new-privileges/swap/core limits.
See [the exact scope and limitations](deployment/commissioning-manager.md).

The original twenty regressions failed on the filesystem-only verifier. All
fourteen loaded-property plants also failed when the comparison was bypassed;
restoring it restores detection. The original sixty-case battery still passes
with a controlled library observation, alongside forty-five supplementary cases.
Their paths and hashes are guarded, not merely cited in qualification prose.
This is local candidate fault-detection evidence, not independent or human
qualification.

Three public PID1 cases passed on the existing VM: concrete/template/inactive
instance agreement, refusal of an unreviewed instance override, and a pending
reload despite matching installed/shipped bytes. The initial load-only reload
plant was invalid because inactive metadata can be collected and loaded afresh;
the corrected proof briefly activates a public `/usr/bin/true` oneshot with
`RemainAfterExit`, then stops it. Exact fixture files/directories were removed.
No production service, schema, credential, release link or manager reload changed.

Loaded metadata is not startup/reboot or running-process custody evidence.
Native secret posture, real encrypted-store delivery, owner B2 signup/key capture
and Bitwarden recovery, preservation/recovery of the 91-migration baseline,
fresh sealing/rehearsal, guarded promotion and final qualification/acceptance
remain open. Do not cite this check or its local qualification as KF 1.0.

## Actual drill identity: retained baseline recovery (2026-10-04)

The actual `kf-drill` account (UID 978) decrypted the retained signed
91-migration baseline, authenticated its backup root and export, restored it
into a private socket-only PostgreSQL 18 cluster, and re-exported it byte for
byte using the matching historical `637677e2c5e1` exporter. Its separate
read-only working-store credential measured and matched all fifteen requested
objects. The recovery key, GnuPG keyring, decrypted bundle, database and
temporary re-export key remained in private unswapped guest tmpfs. The owned
cluster stopped and its runtime and PID 1 credential mount disappeared. No
production ledger credential or preservation signing key was delivered.

The first real invocation exposed an operational caller defect: the adapter
staged owner-only child inputs but inherited `KF_SECRET_CUSTODY=systemd`, so
the actual child loader correctly rejected them as non-PID-1 files. The
[caller adapter](deployment/backup-custody.md#database-and-object-reader-child-handoff)
now switches only validated ordinary-file children to their existing contract,
without relaxing native parent admission. Root-manifest signing uses the same
explicit boundary with no database binding. The current built native-reader
fixture now includes its internal dependency and proves the real default
child environment, parent custody retention, cleanup and refusal cases.

The corrected probe is an **unsealed diagnostic overlay**, not a promoted or
qualified release. The `bc7084b3` exporter cannot re-export that older schema:
its additional columns require the candidate migrations. Historical recovery
therefore uses the historical exporter, while candidate backup/restore still
needs a new exact-release proof on its 153-migration schema. A diagnostic
symlink prevented the object-verifier CLI entrypoint from running; using its
actual compiled main file corrected the fixture and yielded fifteen measured
objects, rather than credit for an empty proof.

The retained backup carries no historical checkpoint verification keys. The
shipped verifier therefore correctly reports `partial` and exits nonzero:
database and object recovery pass, checkpoint trust is not verified. No
checkpoint key, checkpoint record, off-site copy, restore ledger row, human
approval or acceptance was fabricated. This is local retained-baseline
recovery evidence, not a fresh scheduled backup or a B2-downloaded restore.
Production remains on `637677e2c5e1` at 91 migrations with its original running
services. Fresh gating/sealing, candidate-schema recovery, independent copies,
Bitwarden recovery, B2 access, guarded promotion, commissioning and final
qualification remain open.

## Real backup producer exposed a missing migration-ledger grant — 2026-10-04

The sealed `8ffa16f5` candidate passed its retained-baseline upgrade, but its
packaged backup producer did not pass. Under the actual `kf-backup` OS identity
and an isolated non-superuser, non-BYPASSRLS backup login, `pg_dump` refused
`public.schema_migrations`. The clone retained the original owner-only dbmate
table; the previous test harness applied SQL without creating that table, so
its all-table backup-access check never examined it.

The harness now creates dbmate's migration ledger and records each applied
version in the same transaction as its SQL. The backup test failed specifically
on the missing `public.schema_migrations` privilege before the fix.
Migration `20261004000100` grants only SELECT to `kf_backup`, with an explicit
REVOKE in its down section. It changes no ownership, migration history or write
permission. The test also requires the operational dump to retain the ledger,
compares its restored version rows, and proves the backup login cannot DELETE.
All fourteen real PostgreSQL backup/restore tests then passed.

The complete suite then reported two related gaps (321 files passed, two failed):
the separate fresh-install model also omitted dbmate's table, and the closed
canonical preservation inventory had not classified it. The fresh-install model
now records each version atomically, and a separate bare-container test invokes
the actual dbmate executable with no application schema pre-created. The grant's
down/up probe proves read access is reversible, while the real runner proves
there is no backup write privilege and that a second install changes no history.

Canonical export explicitly excludes only `public.schema_migrations`, not its
whole schema: software versions belong to the already migrated import target.
Operational dumps still retain the source ledger for same-release recovery.
The extended round-trip test gives the target a distinct test-only version and
proves canonical import leaves that ledger unchanged. All fifteen focused
fresh-install, extended-preservation and transient-observation tests passed.

The corrected complete suite passed 323 files and 3,315 tests, with four files
and 25 tests skipped. The full gate then stopped at its generated-drift check:
`measurements:build` correctly changed the migration count from 153 to 154.
That generated output must accompany the migration; this stopped gate is not
a successful sealed build. Fresh exact-commit gating and packaging remain required.

The isolated producer attempts also measured a workspace issue: the VM's `/run`
tmpfs was smaller than the backup's unchanged default free-space reserve.
A private 2 GiB tmpfs nested under the service runtime exposed the required
capacity; mounting it at the runtime root was hidden by systemd's directory
binding. A public, key-free native probe demonstrated both layouts. The nested
layout passed the space gate and exposed the actual table-permission failure.
No reserve, custody guard or backup completeness requirement was relaxed.

The VM has no checkpoint public-key set. Deployed-profile backup correctly
refuses that absence; the producer exploration explicitly used development
mode and establishes neither deployed backup commissioning nor a full restore.
No replacement historical key, checkpoint, approval or production backup record
was fabricated. All three owned clone attempts stopped, and their temporary
credential copies were removed while shared generations were preserved.

This new migration changes the candidate migration set. The earlier sealed
153-migration release and receipt are retained evidence, not authority to promote
these changed sources. Full repository verification, a fresh sealed release and
authenticated rehearsal, the real-role producer/restore rerun, checkpoint trust,
B2 delivery, independent key recovery, hosting and final qualification remain open.

## Clean-build fixture boundary — 2026-10-04

Commit `4a8098e0` retains the migration-ledger correction and its generated
inventory. Its clean-worktree release build did not pass: 322 files and 3,314
tests passed, but the off-site-copy SQL test reached its 30-second deadline;
four files and 25 tests were skipped. The unchanged failed case passed alone
in the same clean checkout in four seconds. Measured workstation I/O pressure
was substantial during the failed run; that correlation does not establish
which await consumed the deadline.

That case charged a fresh container and all migrations to the same test budget
as its copy/retry checks. The real SQL boundary now prepares the database in a
scoped `beforeAll` and closes it in `afterAll`, like the other database suites.
The existing 60-second hook and 30-second test limits, four-worker cap, actual
backup-role SQL, immutable history, retry identity and refusal assertions are
unchanged. All 37 focused off-site-copy, cloud-ledger and resource-budget tests
passed. This is a fixture lifecycle correction, not a production latency result
or a successful release gate. No source from that failed build was sealed or
promoted; another exact-commit clean build remains required.
