# B2 ciphertext transport: implemented seam, not commissioned backup

`@kf/export` exposes `createB2ArchiveStore(configuration)`, returning `publish`,
`pull` and `close`. The [public interface](../../packages/export/src/offsite.ts)
composes internal contract, streaming/file-lifecycle and SDK transport atoms.
It reuses the repository's pinned S3 SDK version rather than introducing another
object-store subsystem. This is preservation transport, not the KF kernel,
document compiler, secure-object authority or an ML corpus storage policy.

## Required caller contract

Configuration is the selected HTTPS B2 S3 endpoint, private bucket,
application-key ID and application key. A caller must obtain credentials through
the [selected custody arrangement](backup-custody.md), never a plaintext config
file, command argument or logged provider error. The module has no environment
discovery, ambient credential fallback, endpoint redirect or automatic retry.
It supports one operation at a time, caller cancellation, a 30-minute operation
deadline and explicit client closure. Failures expose only `OffsiteTransferRefused`
with code `offsite_transfer_refused`, without a provider/filesystem cause.

`publish(absoluteCiphertextPath)` requires ciphertext from an authenticated backup
builder. It opens a singly linked regular file without following the final
symlink and admits the existing public-key-encrypted OpenPGP packet framing.
**Framing alone is not proof of encryption or authentication.** Authenticating
the preservation manifest and binding it to `ops.backup_run` remain the caller's
responsibility; this module does neither.

Before transfer the module observes enabled bucket versioning and an owner-only
private ACL. B2's object ACL inherits the bucket's policy, so a private object
setting is not independent protection from a later bucket-policy change.
[Provider ACL semantics](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api)
make that distinction explicit. It does not create buckets, change policies,
delete versions, promise retention, attest physical failure domains or restrict
the actual application's provider capabilities. Those remain commissioning or
owner decisions, not facts inferred from a successful API response.

The module hashes and streams the source, then reads back the exact non-null
version returned by PUT. B2 documents this identity in the
[PUT response](https://www.backblaze.com/apidocs/s3-put-object). Success requires
matching response version, byte length and streamed SHA-256, and unchanged source
metadata. The returned `kf-offsite-object-v1` record contains endpoint, bucket,
opaque ciphertext-hash key, version ID, SHA-256 and byte length. ETags and a GET
for latest are not evidence. A failed transfer/read-back can leave an unrecorded
remote version; it is never deleted automatically.

`pull(recordedCopy, absoluteNewPath)` requires a trusted recorded copy identity,
not user-supplied or unauthenticated JSON. Endpoint, bucket and opaque key must
match the configured destination. The parent directory must be canonical,
owned by the current user and mode `0700`; the destination must not exist.
The exact historical version is streamed into private staging, length/hash
checked, synced and linked without replacing any existing file. Refused
downloads remove only their staging. Success syncs the destination directory.
A durability error after linking can leave the verified destination present;
an error is not permission to overwrite it or claim durable success.

The single-PUT operating budget is 1 byte through 5 GiB. This is KF's current
limit, not a measured provider maximum or multipart/large-corpus qualification.
Processing uses bounded streaming buffers rather than whole-archive buffering.
It does not decrypt or restore the database.

## CLI, copy ledger and restore callers

`kf-offsite publish|pull <absolute-path> <ciphertext-sha256>` is the Linux
preservation entry point. Core dumps must be disabled. It accepts no credential
arguments and reads one UTF-8 JSON request on stdin, capped at 16 KiB and 15 seconds:
`format` is `kf-offsite-request-v1`, `configuration` contains exactly endpoint,
bucket, applicationKeyId and applicationKey, and `copy` is null for publish or
the closed recorded object identity for pull. Cancellation closes stalled stdin
before a network adapter is created. Publish stdout contains only the verified
copy identity; pull stdout is empty. Entry-point errors print one generic refusal,
not request contents or provider causes. Never save this request in a plaintext file.

The first installed-command smoke check exposed a pnpm repeat-install fast-path
defect: the entry point worked, but an unchanged dependency graph let installation
skip creating its new command shim. KF's `pnpm-workspace.yaml` now disables that
fast path. Placing the setting in `.npmrc` did not work under the installed pnpm 11;
the fixture remained red until the effective workspace setting was used.
`tests/deployment/cli-install.test.ts` reproduces a new workspace command after an
initial install and requires a repeated offline frozen install to expose it without
changing the lockfile. It failed before the setting and passed after it; the real
`pnpm exec kf-offsite` entry also emits the expected redacted refusal for malformed input.

The shell callers now select this adapter with literal `b2`, not a cloud URI:
`scripts/backup-offsite.sh` with arguments `<backup-directory> b2 <label>` and
`KF_DRILL_OFFSITE_SOURCE=b2` for `scripts/restore-drill.sh`. The shared shell atom
reads `KF_B2_S3_ENDPOINT`, `KF_B2_BUCKET_NAME`, `KF_B2_APPLICATION_KEY_ID` and
`KF_B2_APPLICATION_KEY`, preferring their `_FILE` forms. Inline values are for the
sanctioned workstation `secrets run` path, not plaintext environment files.
Explicit systemd custody requires the corresponding purpose-specific PID 1
credential files: `b2-endpoint`, `b2-bucket`, `b2-key-id`, `b2-key`; no inline fallback.
The parent sends values on stdin to a child with a clean environment, so neither
B2 values nor unrelated encrypted-store entries are forwarded in its environment.

The off-site script retains signed source-manifest authentication, its binding to
`ops.backup_run`, packet framing and independently measured ciphertext SHA-256.
The new nullable `ops.backup_copy.provider_object` holds the closed seven-field
identity in the existing append-only ledger. PostgreSQL binds its digest and opaque
key to the row's ciphertext, rejects extra fields (including credentials), and
refuses SQL NULL bypasses. Historical/rsync rows retain null provider metadata.
The preservation exporter/importer round-trips that identity.

A cloud transfer without a human-approved domain uses `offsite_basis=remote-object`,
not an invented physical-domain approval or encryption-evidence assertion. On retry
the script downloads the already recorded version instead of uploading another one.
Conflicting immutable history refuses before transfer, and a conflicting concurrent
insert cannot silently receive credit. Restore requires the configured B2 selector,
recorded identity and copy ID; it downloads that version, rechecks its digest, and
decrypts before the existing signed-manifest and isolated database verification.
Drill notes name the exact backup-copy row. Transfer failures never silently fall
back to the local original.

This migration is forward-only: removing version identities would destroy
restore-critical lineage. The floor is now `20261002000100`; a new sealed candidate
requires a fresh authenticated rehearsal receipt. Earlier receipts still prove
only their earlier release. No production migration is implied.

## Evidence and remaining commissioning

`pnpm exec vitest run packages/export/src/offsite.test.ts packages/export/src/offsite-wire.test.ts`
checks controlled SDK refusals and the real SDK's serialization/streaming against
an owned loopback HTTP server. Public fixtures exercise packet framing, not real
encryption. Tests cover historical-version query encoding, source-byte upload,
private output, malformed/foreign identities, plaintext framing, symlinks and
multiple links, byte/version mismatches, truncated streams, unsafe bucket policy,
provider refusal/redirect, cancellation, concurrent calls and staging cleanup.
The positive multi-chunk wire round-trip also guards descriptor ownership across
hashing, upload and final close.

These are local protocol tests, not B2 authentication, TLS, real credential
capabilities, provider quota/cost, physical independence, recovery-key custody or
an isolated restore. No account, upload, copy-ledger entry, backup readiness,
human approval or production promotion is created by those tests.

The CLI controller suite checks bounded/closed input, exact identity output,
cancellation and input deadlines. The shell caller suites use real GPG archives
and controlled cloud adapters; one additionally runs the shipped insert and retry
SQL against real PostgreSQL through a backup-role login. The database suite checks
valid append-only identities and refusal plants; the full preservation round-trip
includes provider metadata. Removing the SQL NULL refusal makes the database
suite fail on an unbound ciphertext digest; the predicate is restored afterwards.

The selected VM's public PID 1 fixture admits all four named B2 credentials and
refuses empty/oversized values, foreign purpose, inline systemd fallback and unsafe
helper ownership/permissions. The first copied-helper attempt refused because its
source owner was preserved; the fixture driver now explicitly installs root ownership.
The original production release and five live services were unchanged. These public
credential tests do not deliver real B2 credentials or prove provider access.

The [dedicated B2 credential handoff](b2-credential-custody.md) now implements
closed four-field volatile custody with separate reboot recovery templates.
Public fixture proofs do not install it or deliver real credentials. Next wire
the actual consumers and deliver the dedicated credentials; then observe a real
encrypted upload/read-back and isolated restore after the owner completes signup
and recovery-key storage. Retention/Object Lock and archives above the operating
budget need an explicit decision rather than a silent downgrade.
