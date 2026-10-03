# Separate workstation-to-VM B2 credential custody

The [selected account preparation](backup-custody.md) remains a human action.
This module delivers only the four settings consumed by the
[ciphertext callers](b2-ciphertext-transport.md#cli-copy-ledger-and-restore-callers).
It does not create an account, bucket, key, backup or copy-ledger row.

## Closed handoff interface

The [handoff module](../../scripts/deploy/workstation-credentials.mjs) now has
six fixed realms sharing filesystem custody and pinned SSH transport, including
the separate [preservation consumer sets](preservation-credential-delivery.md).
B2 uses
`b2-send CONFIG` for explicit delivery/rotation and `b2-sync CONFIG` for delivery
only when the boot-bound generation is unavailable. Root-only guest commands
are `b2-receive` and `b2-status`, with no further arguments. A ready generation
is not rotated by sync; use explicit send after rotating a provider key.

| Workstation encrypted-store name | Guest credential name |
| -------------------------------- | --------------------- |
| `KF_B2_S3_ENDPOINT`              | `b2-endpoint`         |
| `KF_B2_BUCKET_NAME`              | `b2-bucket`           |
| `KF_B2_APPLICATION_KEY_ID`       | `b2-key-id`           |
| `KF_B2_APPLICATION_KEY`          | `b2-key`              |

The protocol is `kf-workstation-b2-credentials-v1`: protocol header, endpoint,
bucket, key ID, key and final newline, exactly six split lines and at most
16,384 bytes. The selected HTTPS B2 S3 endpoint admits an optional final slash,
normalized away. Bucket and credential alphabets/bounds match the preservation
caller; embedded whitespace, line breaks, endpoint userinfo, ports, paths,
queries, fragments, foreign hosts, missing values and extra framing refuse.
No caller supplies an environment-name list, arbitrary destination or realm.

No database connection, receipt key, retrieval key, preservation signing key,
decryption key or unrelated store entry belongs in this payload. The SSH child
gets only the transport environment, never the decrypted workstation environment.
The fixed SSH connection pins the host key and exact receiver source digest,
disables agent forwarding and core dumps, bounds time/output, and suppresses
untrusted remote output even on refusal. Manual invocation must disable core
dumps before unlocking secrets (`ulimit -c 0`). Buffer clearing does not promise
erasure of every runtime string copy.

## Volatile guest custody and recovery

The guest publishes an atomic root-owned generation under
`/run/kf-workstation-b2-credentials/current`. Parent/generation directories are
mode `0700`; the four singly linked regular credentials and boot binding are
mode `0400`. Custody refuses disk-backed storage, active or unverifiable swap,
wrong ownership, escaping/symlinked generations, widened credential modes and
invalid credential contents. Status validates all four values and the live boot
ID. An absent field is missing, not ready. Refused updates leave the previous
generation and both other realms unchanged.

The separate [workstation service](../../deploy/workstation/kf-host-b2-credentials.service.in)
and [timer](../../deploy/workstation/kf-host-b2-credentials.timer.in) use the
existing four-field non-secret config contract (`identityFile`, `knownHostsFile`,
`receiverPath`, `secretsCommand`). Install a digest-versioned sender/receiver
pair with its own config, not an in-place replacement of the installed
alert/retrieval or migration pair. The timer recovers only B2 custody after
reboot; it invokes no backup, drill, migration or promotion.

The backup/drill consumers must receive these names through PID 1
`LoadCredential`, with `_FILE` settings pointing into their credential mount
and `KF_SECRET_CUSTODY=systemd`. Do not give their users access to the root
generation, persist decrypted values under `/etc`, or silently fall back to
inline values. Their database, signing and recovery credentials remain separate.

## Evidence and remaining deployment

`tests/deployment/workstation-b2-credentials.test.ts` exercises the same
encode/decode/receive/status interface, including accepted rotation, closed
framing, three-realm isolation and custody refusals. The unchanged startup and
migration suites also pass. The new tests failed before the interface existed.
Pointing B2 at the startup namespace made the isolation test fail; restoring
the separate root returned all three handoff suites to green.

The [native public proof](../../scripts/deploy/test-workstation-b2-credentials.mjs)
runs as root on the selected VM's unswapped tmpfs. It validates all three realms
in a uniquely owned fixture and runs the actual B2 receive/status commands in a
private mount namespace with its own `/run`. No public test values are installed
in the real B2 credential root. It removes only its owned fixture. This proves
guest command/custody behavior, not real encrypted-store delivery, SSH delivery,
provider access, PID 1 consumer activation or reboot recovery.

Do not activate current backup/drill scripts against the production database's
older 91-migration schema. The candidate's copy-version column arrives at
migration `20261002000100`, with 153 migrations. Preserve and demonstrate recovery
of the baseline first, then obtain an exact newly sealed candidate's authenticated
rehearsal and guarded migration/promotion evidence. Account/MFA, real key delivery,
consumer database/signing/decryption custody, Bitwarden recovery copies, cloud
read-back, isolated recovery and qualification remain open.
