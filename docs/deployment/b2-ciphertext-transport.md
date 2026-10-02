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

## Evidence and remaining integration

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

The live scripts still use rsync. Next wire this module into their authenticated
source checks, append-only copy ledger and exact-version restore selection;
deliver the dedicated credential through volatile custody; then observe a real
encrypted upload/read-back and isolated restore after the owner completes signup
and recovery-key storage. Retention/Object Lock and archives above the operating
budget need an explicit decision rather than a silent downgrade.
