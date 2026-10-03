# Separate B2 reader custody for restore drills

The [workstation handoff](../../scripts/deploy/workstation-credentials.mjs)
implements a seventh, closed `drill-b2` realm. It shares custody and pinned
transport machinery with the other realms, not their credential values.
This is an implemented delivery interface and uninstalled recovery template,
not proof of actual read-only provider access or operational backups.

## Fixed contract

| Encrypted-store name             | Guest filename | Accepted bytes |
| -------------------------------- | -------------- | -------------- |
| `KF_DRILL_B2_APPLICATION_KEY_ID` | `b2-key-id`    | 16–512         |
| `KF_DRILL_B2_APPLICATION_KEY`    | `b2-key`       | 16–512         |

Neither uploader name (`KF_B2_APPLICATION_KEY_ID`,
`KF_B2_APPLICATION_KEY`) is a fallback. Missing reader input refuses even when
valid uploader input exists. Changing uploader values cannot change this
payload. Endpoint and bucket remain shared public B2 routing, supplied
separately to a consumer. No database, signing, recovery, object-reader,
retrieval or unrelated store entry is exported by this realm.

The wire is exactly `kf-workstation-drill-b2-credentials-v1`, newline, key ID,
newline, key, newline. Its existing 16,384-byte framing limit does not widen
another realm. Each token admits only the existing printable B2 alphabet;
invalid UTF-8, whitespace, missing/extra fields, trailing data and every other
realm's protocol refuse. Existing six wire protocols remain unchanged.

Root-only `drill-b2-receive` and `drill-b2-status` accept no additional
argument. `drill-b2-send CONFIG` and `drill-b2-sync CONFIG` use the same
four-field public config and digest-pinned SSH contract as
[preservation delivery](preservation-credential-delivery.md). There is no
arbitrary environment-name list, realm or destination selector.

## Guest storage and recovery

The root is `/run/kf-workstation-drill-b2-credentials`. Atomic generations
contain exactly `b2-key-id`, `b2-key` and the existing `boot-id` binding:
root-owned, singly linked regular mode `0400` files inside mode `0700`
directories on unswapped tmpfs. Each reader file is bounded to 512 bytes.
Missing input is unavailable, while extra generation members, widened modes,
wrong owner/boot binding, links, drift, active swap or disk storage refuse.
Refused cross-realm updates preserve the active generation and all six other
realms; reader rotation changes only this realm. Root remains trusted.

The separate [service](../../deploy/workstation/kf-host-drill-b2-credentials.service.in)
and [timer](../../deploy/workstation/kf-host-drill-b2-credentials.timer.in)
recover only reader credentials after reboot. They never run a copy, drill,
migration or promotion. Install a fresh digest-versioned sender/receiver
pair; do not overwrite an installed startup, migration or uploader pair.
Consumers must receive only their explicit fields through PID 1 and their
own service UID. Do not grant a consumer access to a root generation or
redirect a missing reader source to the uploader realm.

## Evidence and remaining work

The [interface tests](../../tests/deployment/workstation-drill-b2-credentials.test.ts)
exercise exact names/bytes, no uploader fallback, framing, bounds, all-seven
realm isolation, missing/extra inputs, custody refusals, closed commands and
separate recovery templates. Before implementation, eight tests failed for
the missing interface/templates and the generic-command refusal test passed.
The first implementation exposed a missing-file semantic regression: checking
the inventory before named reads made missing input a generic refusal.
Moving the new-reader-only inventory check after named validation preserved
the existing `missing` result without admitting extra files.

The [native public proof](../../scripts/deploy/test-workstation-drill-b2-credentials.mjs)
uses root-owned, unswapped guest tmpfs and fresh private mount namespaces for
actual receive/status commands. It never writes the real credential roots.
It checks reader-source selection, all six prior realms' generations and
bytes, rotation/refusal, exact inventory and custody, and actual rejection
of uploader framing before publication. Public fixture tokens and opaque
armor are not real provider/recovery credentials.

Deliberately substituting the uploader token in the encoder made this native
proof fail by name at `reader-source`; restoring the reader-only source
returned the complete proof to PASS. The restored local and owned guest source
hashes match. This exercises the actual encoding/custody interface, not a
source-string comparison, and does not measure provider permissions.

The [joined consumer proof](../../scripts/deploy/test-preservation-binding.mjs)
publishes the reader pair through the actual handoff function into an owned
private generation, then lets PID 1 load those files into the existing drill
binding under the fixture service UID. Its public fixed callee checks reader
bytes, invocation and cleanup. All 15 cases pass, including a deliberate
uploader-source substitution refused with status `98`. Endpoint/bucket remain
separate shared routing. This is not installed SSH delivery, real production
UID separation, SQL, encryption, provider authorization or recovery.

Nothing is installed by this change. Owner signup/MFA/terms and private bucket
preparation, a separate reader-key capture in the encrypted store, measured
provider read-only permissions, actual SSH delivery/PID 1 consumer loading,
baseline preservation/recovery, exact-version B2 read-back/download/restore,
Bitwarden recovery custody, commissioning, qualification and human release
acts remain separate open obligations. A token name or native metadata cannot
prove a provider capability. Preserve the old live baseline before candidate
preservation SQL or migration/promotion.
