# Composed retrieval startup

The startup contract composes the sealed embedding runtime and the existing LAMU
engine. It owns neither document authority nor model promotion. A shipped unit,
a public model probe and a successful credential delivery are not a commissioned
retrieval installation.

## Non-secret contract

`/etc/kf/retrieval-runtime.json` is a root-owned, single-link regular file, mode
`0644`, at most 8,192 bytes. Its ancestors must be root-protected and cannot be
symlinks. It contains exactly these fields; duplicate JSON keys, including
escape-equivalent keys, refuse.

| Field                         | Meaning                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `format`                      | Exactly `kf-retrieval-startup-v1`.                                                |
| `releaseDirectory`            | Absolute, normalized, root-protected sealed KF release directory.                 |
| `releaseManifestSha256`       | Independently retained SHA-256 of that release's `SHA256SUMS`.                    |
| `enginePath`                  | Absolute, normalized, root-protected executable LAMU artifact.                    |
| `engineSha256`                | Independently retained SHA-256 of that executable.                                |
| `pythonRuntimeDirectory`      | Absolute, normalized, root-protected offline Python runtime.                      |
| `pythonRuntimeManifestSha256` | Independently retained SHA-256 of its `RUNTIME-CLOSURE.json`.                     |
| `modelDirectory`              | Absolute, normalized, root-protected public model directory.                      |
| `modelIdentity`               | Exact embedding recipe identity, not just the model repository name.              |
| `embeddingPort`               | Integer loopback port from 1 through 65,535 in the private namespace.             |
| `allowedPeerUids`             | At most sixteen distinct non-root UID integers explicitly admitted to the engine. |

Pins are 64 lowercase hexadecimal characters. The contract accepts no arbitrary
arguments, environment variables, credential values, key files or remote model
URL. UID values come from the installed accounts, never from an example.

The launcher must itself be located in the declared release. It authenticates the
manifest, then checks root custody and the manifest's exact bytes for its eight
startup/provider recipe files before starting a child. This is recipe verification,
not a second whole-release verifier. Installation and the key broker use the
existing whole-release verifier; the broker verifies before releasing a key.
The embedding launcher separately verifies its closed runtime and host-library
inventory, and the provider verifies its closed public model inventory.

The selected candidate's recipe identity is
`BAAI/bge-m3@5617a9f61b028005a4858fdac845db406aefb181/dense-cls-f32-single-cpu3-v1`.
Its candidate artifacts and limits are recorded in the
[runtime contract](embedding-runtime.md) and [provider contract](embedding-provider.md).
An artifact pin is not evidence of role qualification or acceptance.

## Identities and supervision

The [provider unit](../../deploy/systemd/kf-embedding.service) runs as
`kf-embedding`. The [engine unit](../../deploy/systemd/lamu-retrieval.service)
runs as `kf-retrieval`, with `kf-retrieval-key` as a supplementary socket group.
The broker remains a third identity without database or document authority.
The API and worker need filesystem access through group `kf-retrieval` as well
as explicit kernel-peer admission in `allowedPeerUids`; neither check replaces
the other. Existing processes acquire changed supplementary groups only after
a fresh start.

Both provider and engine use `PrivateNetwork=true`. The engine joins the
provider's namespace; their HTTP exchange is on its loopback, not host loopback.
A host-local process cannot occupy the provider's address in that namespace.
The engine's authenticated filesystem Unix socket remains the KF-facing
interface at `/run/lamu-retrieval/retrieval.sock`. No TCP engine listener is added.

The provider has a 5 GiB hard memory limit, no swap and a three-CPU quota. The
engine has a 1 GiB hard memory limit and no swap. Both use an empty capability
set, read-only system, inaccessible homes, bounded restarts, control-group stop,
disabled core dumps and the declared system-service syscall filter. Failure
routes to the existing alert unit; actual alert delivery is a separate test.

`startup.mjs engine` rejects active host swap and an unpinned executable. It
waits at most sixty seconds for a bounded local health reply naming the exact
recipe. Redirects, more than 4,096 response bytes, a wrong identity and a failed
endpoint do not release a key. It then invokes the engine's existing
`--key-release-socket` path with the exact KF release pin. There is no key-file
fallback. The engine authenticates the broker before opening its store or socket.
The persistent derived index is `/var/lib/lamu-retrieval/index`; it is not a
master record or a second source of document authority.

Startup children receive a fixed minimal environment, not the workstation's
secret environment, provider configuration from a developer settings file or
an inherited API token. SIGTERM and SIGINT are forwarded and child exit status
propagates. A provider-only restart can rejoin the namespace still held by the
engine; it does not need to recreate the encrypted index.

## Boot, delivery and recovery

The engine is wanted at boot but PID 1 skips it before forking if the root-only
workstation handoff key is absent. The
[credential path unit](../../deploy/systemd/kf-retrieval-credentials.path)
retries when the handoff directory changes. It observes events, not a continuously
true `PathExists` condition: continuous activation would restart an intentionally
stopped engine or loop on a skipped condition. If the handoff is already present
at boot, the engine's ordinary boot activation supplies the initial attempt.

The path unit reads no key. The root-only source, authenticated broker and
systemd credential-copy custody remain governed by the
[key-release contract](retrieval-key-release.md). Delivery from the encrypted
workstation store, not a guest persistent plaintext file, supplies the key.
If the workstation cannot unlock that store, no substitute key is generated.

Declare `lamu-retrieval.service` in the existing
[recovery cache-holder scope](../backup-and-restore/README.md#live-recovery-stop-permission-cache-holders-first).
Its persistent start guard must survive every delivery event and reboot while
recovery is held. An event is never permission to bypass the recovery interlock;
only the existing operator-confirmed resume procedure releases it.

## Installation and proof still required

The provisioner creates the two identities and API/worker socket-group membership,
and copies service, socket, timer and path declarations. It does not generate this
host-specific contract or enable a retrieval engine with guessed pins. Its older
generic secret-generation path is not the selected workstation encrypted-store
custody adapter and must not be applied unchanged to this VM.

Build and stage a fresh sealed KF release containing these startup modules. The
older staged candidate cannot supply them without invalidating its manifest.
Install root-held runtime and broker policies with the observed engine UID,
matching release pin and already tested runtime/model artifacts. Do not switch
the live application before its migration rehearsal and release checks pass.

Prove actual broker-to-engine key release, encrypted index creation, API/worker
permission masks, stopped/wrong-peer/drifted-release refusals, provider and engine
restart, recovery hold/resume and reboot. Then prove full host commissioning,
encrypted backup and restore, off-site preservation and corpus search quality.
The ordinary startup tests exercise the flat contract, recipe pins, bounded real
HTTP readiness and unit declarations. They do not install native units, run an
ML model, release the real key or qualify retrieval relevance.

## Selected-VM public proof — 2026-10-02

Two dedicated operating-system identities were created: `kf-embedding` UID 991
and `kf-retrieval` UID 987. These are service accounts, not enterprise document
identifiers or authority grants. Temporary native units exercised the declared
private network, resource bounds and syscall filter with the root-protected
runtime and public model. Both processes had network namespace
`net:[4026532206]`, different from PID 1. Host-loopback HTTP failed with status 7,
while the peer reached the provider through a filesystem Unix control socket.
The actual optimized LAMU artifact returned the exact CPU3 recipe identity.

The full public interface probe passed 64 short inputs, canonical repeatability,
overflow and wrong-model refusal and the 8,192-token input in a combined 116.684
seconds. This is not long-batch capacity or corpus relevance. The public-vector
digest was unchanged from the earlier runtime proof.

A real provider-only restart failed before the address-reuse correction. The
minimal TCP regression confirmed `TIME_WAIT` and then `EADDRINUSE`; after the
correction it passed, and a second live listener remained refused. Repeated
native restarts then reached readiness while the peer PID 28456 and namespace
stayed unchanged. An earlier observation was invalidated by the public harness's
unhandled disconnected-client error, not counted as a restart pass. Its generic
network-error handling was corrected. The first identity probe also used an
unsupported caller option and remains a failed invocation.

The public credential-event fixture skipped a missing source before forking,
started after atomic publication, refused a second delivery while its recovery
guard existed, and stayed stopped until explicit resume. Its counter remained
at two starts without a continuing activation loop. This is native condition/path
behaviour with a public presence marker, not the actual encrypted-store key or a
production recovery operation.

The production orchestrator also started the real provider from an eight-file
pinned public fixture recipe. A changed recipe file refused before execution;
the original bytes and manifest were then rechecked. With a ready provider and
absent broker, the orchestrator invoked the actual engine, which refused before
creating its index or socket. The initial orchestrator probe omitted `PrivateTmp`
and failed; a temporary-file negative/positive probe isolated that caller-profile
error. Repeating with the already-declared private temporary directory passed,
without loosening `ProtectSystem` or changing model code.

An explicit stop of the successful orchestrator returned result `success` and
main status 0. The peer later reached its separate fixed probe lifetime; that
timeout is not a normal-stop proof. All public probe activations are stopped,
their temporary installed unit links are retained in the fixture's retired-link
directory, and evidence is under
`/mnt/4tb/kf-vm/evidence/retrieval-startup-2026-10-02`. The five existing KF modules
remain active on release `637677e2c5e1`. No actual retrieval key, production index,
database migration, application promotion, backup or human acceptance was used.
