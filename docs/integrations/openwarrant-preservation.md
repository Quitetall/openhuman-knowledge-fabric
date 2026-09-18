# OpenWarrant preservation integration

Shared implementation contract:
[OW-WAR-0111](https://github.com/Quitetall/OpenWarrant/tree/1a1048d/docs/warrants/OW-WAR-0111).
This document records the KF side of that scope, not a separate Warrant.

`tests/database/warrant-preservation.test.ts` exercises the public dispatcher and
preservation APIs against two independent PostgreSQL 18 containers. It creates
four fixture Warrants, resolves three, supersedes one, disputes two and annuls
one of the disputed results. Export retains six immutable contract revisions,
action history and audit receipts. The test stops the source container before
importing into the empty migrated target. Re-export must preserve every
manifest-listed section's exact content and the database snapshot digest.

The export uses an ephemeral Ed25519 fixture key. An import without that trusted
key must fail and leave the target without Warrants. These fixture actions and
keys authorize no real project work and confer no OpenWarrant assurance mark.

Run:

```sh
pnpm exec tsc --build
pnpm exec vitest run tests/database/warrant-preservation.test.ts
pnpm exec tsc -p tsconfig.test.json
pnpm exec eslint tests/database/warrant-preservation.test.ts
```

The same test stores source-archive bytes in a real, versioned MinIO service and links
its immutable content version to a Warrant artifact through the public dispatcher.
It stops the object store, copies its data into a separate Docker volume, removes
the source container and starts a new service from that retained copy. The shipped
SDK reconnects the restored database record to the exact original version bytes.
An incorrect expected digest is refused. Replacing the current key does not replace
the pinned version; deleting that exact version yields a missing-object refusal
and no served bytes. The fixture uses pinned images matching Compose and cleans
up only the containers, volumes and backup directory it created.

This proves the stated provider database and local MinIO recovery scenario. It
covers all 15 current Warrant section families but does not exhaust their field
values, historical combinations or complete OW-WAR-0111. Provider
database preservation and the experimental OpenWarrant byte archive remain
distinct formats. The combined reconstruction observation below adds producer
validation; full required-category inventory remains incomplete.

## Producer source reconstruction

The opaque object is now an actual experimental OpenWarrant source archive,
created by `war init --program` and `war archive export` in a disposable directory.
That source directory was removed. Byte-identical fixtures come from OpenWarrant
revision `f51b016434c7baeb822dd3557fe6f9fd81fdfca7`, under
`conformance/fixtures/preservation/kf-source-{archive,identity}.json`.
The identity sidecar records archive digest, exact IR, producer source revision
and producer binary digest. The archive is excluded from formatting because its
canonical bytes are part of its contract.

The database fixture uses the source Warrant UUID, canonical IR, contract digest
and compilation-basis digest. It checks both retained contract revisions against
the producer input after restore. KF treats the archive as opaque artifact bytes;
it does not claim to implement the OpenWarrant parser.

For cross-repository proof, choose a new output path and run:

```sh
OW111_RESTORED_ARCHIVE=/absolute/new/restored.json pnpm exec vitest run tests/database/warrant-preservation.test.ts -t "preserves kf-source"
```

The optional output contains only the bytes recovered through the SDK. It is
created exclusively; an existing path refuses overwrite. All CI assertions still
run without this output setting. From an empty directory, run the producer's
`war archive inspect /absolute/new/restored.json --json`. Require exit zero,
`source_reconstructed: true` and `authority_activated: false`; also compare the
restored file's SHA-256 with the fixture sidecar. This inspection reconstructs
IR from retained source atoms and compares it with the archived IR.

The combined local run passed on 2026-09-18. Evidence lives in the shared OW111
implementation directory. This establishes the stated cross-system fixture;
complete category assembly, stable format adoption and independent qualification
remain open.

## Populated record-family inventory

The fixture populates every current `warrant*` section in
`PRESERVATION_IMPORT_TARGETS`: identity, contract revisions, preflights, dispatches,
runtime receipts, submissions, blockers, deviations, discovered gaps, artifacts,
evidence, gate runs, inferences, judgments and resolution requests. A newly added
family fails until its fixture is populated. Each exported row's columns must
match the live migrated database catalogue, so an exporter that drops the same
column before and after restoration cannot pass by symmetry alone.

For every family, removing its file from the signed package must refuse import.
After all refusals the target must still contain no Warrants. The intact package
then restores successfully, preserving all exact section contents. Judgment and
gate records here are explicitly disposable fixture data, not independent verdicts
or human acceptance of OW-WAR-0111.

## Offline runtime evidence reader (OW-WAR-0111)

`@kf/export` exposes `readWarrantRuntimeEvidence(package, warrantId, trustedKeys, dispatchPackets?)`.
It authenticates the complete v2 snapshot with the existing preservation verifier,
then selects the exact Warrant, contract revisions, dispatches and runtime receipt
rows. It checks unique revision/digest identities and receipt-to-dispatch-to-contract
bindings. Missing trust, missing sections or broken bindings refuse.

The result includes manifest and database snapshot digests. Retain the original
signed package and historical trust keys alongside this projection. All row
columns survive; PostgreSQL JSONB preservation wrappers remain exact text, so the
reader does not round large JSON numbers or reinterpret native runtime bodies.
Failed and historical attempts are preserved. `dispatchesWithoutReceipts` lists
provider dispatch digests without any retained receipt row, independently of stage
packet mappings. An empty list means only that every selected dispatch has a
receipt; it does not mean successful execution or complete stage coverage. A
listed digest does not establish that execution never occurred. Nothing is
activated or written.

This reader does not establish runtime success, actor permissions, native receipt
semantics, complete stage coverage or Warrant assurance. The current provider
dispatch table does not supply a general stage mapping. OpenWarrant archive
integration must keep that unresolved binding visible rather than infer it.

Validation uses the real PostgreSQL/MinIO preservation fixture after source
shutdown, plus signed-package negative tests for broken contract/dispatch links
and duplicate receipts. Shared scope: OpenWarrant OW-WAR-0111.

The optional fourth argument carries exact OpenWarrant stage dispatch packets.
The reader recomputes the existing `oh.war/dispatch/v1` domain digest with the
packet digest field empty, then checks the provider dispatch digest, Warrant,
authorized contract revision and contract digest. Successful bindings preserve
the full packet; `unmappedDispatchDigests` names provider dispatches without a
supplied matching packet. Duplicate, altered or cross-Warrant packets refuse.
This mapping does not prove that all project stages have been dispatched or that
native receipt semantics are valid. It is not an assurance or permission grant.

The cross-language vector is compiled by the OpenWarrant CLI from OW-WAR-0075,
STAGE-001. `ow75-dispatch-identity.json` records the observed producer and packet
identity. Compiling this vector did not launch any work or fabricate a receipt.

For non-TypeScript callers, the same offline reader is available through:

```sh
kf-export runtime-evidence ./export --trust-store ./historical-public-keys \
  --warrant-id UUID --dispatch-file ./dispatch.json
```

Repeat `--dispatch-file` for additional attempts (at most 256 files, 1 MiB each,
16 MiB combined). Output is one canonical JSON object on stdout. No database,
network service, signing key or import is needed. Public keys must come from the
operator's external historical trust store, not from the exported package.
Unsigned legacy input and signing/restore flags refuse. Packet inputs must be
regular files; invalid UTF-8 and changed files refuse. No output is emitted until
all package, trust and binding checks succeed.

The CLI test also launches the built `dist/cli.js` in a separate Node process
with an unusable database URL and compares its canonical JSON with the SDK result.
This proves offline command execution for the signed fixture; it does not assert
production runtime qualification.

Set `OW111_RUNTIME_PACKAGE` to a new directory when running the database
preservation test to retain its signed export, public fixture key and Warrant ID.
The directory is created exclusively with private permissions; no private key is
written. This optional output does not skip normal restore assertions. It supports
source-detached CLI/archive integration experiments. These are disposable fixture
records and keys, never project authorization or assurance.

## Producer contract identity correction

The original source-complete provider fixture supplied the IR composition digest
as its contract digest. Those digests have different meanings in OpenWarrant.
The old round trip proved that the supplied value survived storage; it did not
prove a correct producer contract binding.

The fixture now consumes `kf-source-runtime-basis.json`, produced by
`war archive runtime-basis` from the exact retained source archive. Its sidecar
records producer revision, binary digest and archive bytes. The test checks the
archive domain digest and Warrant subject before using the recomputed contract
digest for submit, authorize, artifact provenance and restored-row comparison.
A red run reproduced the old composition-versus-contract mismatch after database
restoration. Earlier retained observations remain historical; no signed source
archive or authority record is rewritten by this correction.

This fixture still stores a second provider revision with the same source IR.
That is provider history preservation, not proof that a second distinct local
source revision or a real execution exists. Full archive/runtime reconciliation
must preserve this distinction.

### Reconcile archive source identities with provider runtime records

`readArchiveRuntimeBinding(package, basis, trustedKeys, dispatchPackets?)` and
`kf-export runtime-evidence ... --archive-basis basis.json` compare the exact
`result` from OpenWarrant's experimental `war archive runtime-basis` command with
an authenticated provider snapshot. The CLI also requires the explicit Warrant
ID to match the basis. It reads at most 1 MiB from a regular, non-symlink file;
FIFO inputs are refused without blocking. No database or model call is made.

Matching requires both OpenWarrant source contract revision and contract digest.
KF `revision_no` is a separate ledger counter: proposal and authorization can
create two provider rows for one source contract. Source revision comes from the
retained canonical IR, never from that provider counter. A digest mismatch
for the same revision is refused. The result separately lists matched contracts,
provider revisions without retained sources, and source revisions without
provider records. Equal digests across different revisions do not establish a
match. Conflicting source identities for one revision are refused.

The caller must obtain the basis by reconstructing the source archive. KF checks
its shape and compares its claims; it does not authenticate the source archive.
The result explicitly reports `sourceBasisAuthenticated: false`. Provider trust
still comes from externally configured manifest keys. Missing dispatch packets,
missing receipts and unsuccessful attempts remain present in nested `evidence`.
This comparison never activates authority, grants qualification, or establishes
stage/runtime coverage.

The corrected real database round-trip fixture has provider records 1 and 2 for
source contract 1. Both match that retained source identity. An earlier adapter
mistook provider record 2 for source contract 2 and reported a false history gap.
The native-service round trip exposed that error. `providerContractBindings` now
reports both counters explicitly; `providerContractsWithoutSourceIdentity` reports
rows whose canonical IR cannot identify a supported source contract. No fallback
to the ledger counter occurs. An actual distinct source revision still needs its
own retained source identity.

### Source stage membership

When the producer basis includes `stage_inventory`, archive reconciliation also
reports `sourceStageBindings`. A current-revision dispatch matches only when a
current declaration contains its stage and its named milestone references that
stage. The result retains the exact declaration path and source digest. A missing
inventory, missing membership, or a historical dispatch without a graph bound to
that contract revision stays unresolved. Duplicate matching declarations and
malformed inventory envelopes are refused.

This is membership comparison, not a stage execution verdict. It does not verify
executor behavior, receipt semantics, all-stage coverage or graph authenticity.
The existing externally authenticated provider bindings are checked first; source
reconstruction remains the OpenWarrant caller's responsibility. Historical graphs
are never silently treated as current declarations.

The retained OW75 source basis and real dispatch packet exercise matching contract,
stage and milestone identities. Provider rows in that regression are synthetic;
its missing receipt remains visible. This does not prove OW75 execution occurred.

### Native service receipt round trip

`warrant-native-runtime.test.ts` uses the actual OW66 service dispatch and sealed
gate receipt produced in an isolated OpenWarrant clone. The command was `true`:
it establishes the service execution seam, not feature correctness. Provider
permissions and export signing keys are disposable test identities. The test
stops the source database, reads the authenticated package, restores an empty
provider, and checks identical runtime-receipt and dispatch exports plus identical
database snapshot digest. Missing trust refuses import. Provider JSONB receipt text stays byte-identical across export, restore and
re-export; its parsed value equals the original native receipt. This is separate from
receipt authenticity, output-artifact restoration, stage coverage and production
authorization. Original output bytes remain in the retained OpenWarrant archive.

## Populated local service archive

The same PostgreSQL and MinIO restore test now runs against a second producer
fixture, `local-runtime`. This archive contains two actual local service attempts,
including their dispatches, submissions, run records, receipts and stdout/stderr.
OpenWarrant producer b223fc24 reported runtime retention, then its temporary source
repository was removed before local import and byte-identical re-export.

The KF test restores that populated archive after provider source shutdown. The
recovered object was then imported and re-exported by OpenWarrant, with SHA-256
`99161d9b3d3131f3ca51e2028615b5929270377436f08bee7e5a2c1b67bc54fb` unchanged.
This establishes archive transport through KF. The provider action rows created
by this test remain synthetic fixture records; it does not ingest the archive's
native attempts as provider execution or grant qualification. Native receipt row
transport is exercised separately by `warrant-native-runtime.test.ts`.

When retaining optional outputs, select exactly one fixture with
`-t "preserves local-runtime"` or `-t "preserves kf-source"`. Each output path must
be new; running both fixtures against one exclusive output path will refuse.
