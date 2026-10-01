# KF-controlled retrieval-key release

Basis: [ADR 0028](../decisions/atoms/KF-ADR-0028-the-retrieval-index-is-masked-not-copied.md),
SAS §100.39 and the owner's decision that KF releases the key at startup. The workstation's
encrypted secret store remains the selected persistent custody. This is a startup adapter,
not a document-authority primitive or a general secret-export endpoint.

**Current scope:** the KF broker and connected-socket tests are implemented. LAMU's broker
client, the fixed three-credential workstation handoff and real-host installation remain to be
integrated. The existing two-alert-credential bootstrap is unchanged. Do not enable the new
socket yet or treat this document as commissioning evidence.

## Interface

`kf-retrieval-key.socket` accepts local Unix connections only. PID 1 owns the listening socket
and passes an accepted descriptor to `kf-retrieval-key@.service`, which handles one
connection as its own unprivileged identity. The broker authenticates the peer using kernel
credentials. The `kf-retrieval-key` group admits the selected
retrieval account to the socket. Its policy separately admits exactly one numeric peer UID.
No self-declared UID or PID is accepted from the request.

The native `tools/kf-peer-credentials` atom calls `SO_PEERCRED` on the connected stdin socket.
It reports only UID, GID and PID to the broker, not key material. It refuses a regular file,
unconnected socket or non-Unix socket. It links the Linux C runtime only and is built and sealed
with the release; the build machine requires `cc`, not the target.

The client must authenticate the root-owned listener and its protected parent directory, and
verify the listener's kernel peer UID is root before sending a request. The caller sends exactly
these ASCII bytes and shuts down its write side:

```text
kf-retrieval-key-release-v1\n
<64 lowercase hexadecimal characters: expected KF SHA256SUMS digest>\n
```

The request is at most 93 bytes; it must end within five seconds. An extra line, stale release
digest, different version or excessive request is refused, never clamped or ignored.

The response is exactly the ASCII protocol name plus a newline, then **32 raw key bytes**,
then connection closure. It is not JSON, hex or an environment assignment. The client must
bound response length, reject extra bytes, wipe receive buffers after constructing its key,
and refuse to start if the broker is absent or refuses. No fallback to an engine-owned key
file is allowed on the commissioned startup path.

## Policy and custody

`/etc/kf/retrieval-key-release.json` is non-secret, root-owned mode `0644`, in a root-owned
directory that is not writable by group or others. Its exact keys are:

```json
{
  "allowedUid": 1234,
  "releaseDirectory": "/opt/kf-releases/knowledge-fabric-<exact-release>",
  "releaseManifestSha256": "<exact SHA-256 of that release's SHA256SUMS>"
}
```

The UID above is an example, not an assigned account. Use the actual provisioned engine UID.
The release path is the canonical directory, not `/opt/kf`'s symlink. The broker refuses to
release from another running module path. It checks pinned bytes for itself, the native helper,
the release verifier and its secret-support library before invoking release programs, then
runs the existing whole-tree release verifier with a clean environment and sealed dbmate pin.
Altered content, ownership, modes, inventory or manifest refuses before key reading.

Only PID 1 reads `/run/kf-workstation-credentials/current/retrieval-index-key` to supply
`LoadCredential=index-key:...`. The broker reads its own private credential copy, never that
root-only source and never a value in arguments or environment. The credential must be a
regular, singly-linked, owner-only mode `0400` file on tmpfs, containing 32 raw bytes or 64
lowercase hex characters and an optional newline. A symlink, widened permissions or malformed
key is refused. Active swap is refused before reading any key. Core dumps and service swapping
are disabled; writable application memory remains necessary to serve the engine (§100.22).

The broker writes only to the accepted socket. Refusal logs contain a fixed generic message,
not request fields, endpoint text, credential contents or release-verifier output. Binary key
and response buffers are overwritten after use; JavaScript does not promise erasure of every
runtime copy. It has no database login, signing key, object-store credential or document
authority. The API and worker receive no retrieval encryption key.

## Evidence and remaining work

The connected-socket tests use the same broker module copied into a sealed synthetic release,
a real compiled kernel-credential helper, the packaged dbmate and the real release verifier.
A public fixture key is written only to an owned tmpfs directory. They demonstrate successful
exact-length release, a different UID refused, stale/extra framing refused, drift in data and
executable inputs refused, unsafe/malformed credentials refused, active swap refused and an
absent listener returning no key. Failed connections can reset instead of ending gracefully;
that is a refusal, not a successful empty key.

The workstation has active zram. Tests inject an empty swap table only for the public fixture's
success case, and separately plant an active swap table. The deployed CLI always reads the live
swap table and requires root ownership of policy and release. These are not production-unit,
cross-UID service-manager or VM-reboot proofs.

Before closing §100.39: integrate the LAMU client; extend the workstation handoff with one
explicitly named retrieval-key entry (no whole-store export); keep any existing index bound to
its existing key or explicitly rebuild that derived index; install a sealed release and exact
policy; exercise the real systemd identities, wrong peer, stopped broker, invalid release and
reboot. Record delivery evidence separately from signing, release acceptance and independent
qualification.

References: [systemd socket activation](https://github.com/systemd/systemd/blob/v257/man/systemd.socket.xml),
[Linux Unix-domain peer credentials](https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/tree/man/man7/unix.7).
