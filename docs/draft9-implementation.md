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
