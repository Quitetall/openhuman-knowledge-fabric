# Migration credentials from PID 1

The selected persistent custodian is the workstation encrypted secret store,
not a plaintext guest key file. This adapter lets the existing migration module
consume PID 1's private, temporary credential copies. It does not deliver those
credentials, run a migration, produce a rehearsal receipt or approve a release.

## Interface

Ordinary callers leave `KF_SECRET_CUSTODY` unset. Their private-file permission
rule is unchanged: any group or other permission refuses the file. A normal
`0440` file is still refused. An unknown custody mode is refused, not ignored.

A commissioned migration invocation sets `KF_SECRET_CUSTODY=systemd`, uses PID
1's `CREDENTIALS_DIRECTORY`, and provides a service-owned mode `0700` `TMPDIR`
on tmpfs, normally its `/run/kf-migrate` runtime directory. An inherited
`PGPASSFILE`, active or unverifiable swap, a symlinked directory, disk-backed
storage or the wrong directory owner/mode refuses before a password file is
created. `PrivateTmp=true` alone is not a memory-backed storage guarantee.

The manager must leave `/proc/swaps` readable (`ProcSubset=all`); a unit with
`ProcSubset=pid` cannot establish the required absence of swap and refuses.
`ProtectProc=invisible` can remain enabled. Service coredumps and swapping must
also be disabled. Secret values do not belong in the unit environment or argv.

`kf_validate_secret_file PATH` checks custody without reading contents.
`kf_read_secret_file PATH LABEL` crosses that same interface before reading.
The migration receipt-key check also uses it before HMAC computation. In systemd
mode the path must be an immediate child of the exact declared credential
directory, whose canonical path contains no symlink.

The shared native helper is fixed to `tools/kf-credential-custody` in the same
release as `scripts/lib/secret.sh`; an environment-supplied helper is not an
interface. Before executing it, the shell requires a root-owned, singly linked,
non-symlink executable without set-ID/sticky or group/other write bits, and
root-owned, non-writable ancestors. Release verification remains a separate
prerequisite before any migration, as before.

The helper's optional second argument selects a closed metadata policy:

| Credential name          | Accepted file size in bytes |
| ------------------------ | --------------------------- |
| `index-key`              | 0–65                        |
| `database-url`           | 1–8,192                     |
| `rehearsal-database-url` | 1–8,192                     |
| `rehearsal-receipt-key`  | 32–4,096                    |

Omitting that argument still selects `index-key`, preserving the retrieval
broker's interface and limit. Unknown names and traversal have no policy and
refuse. Size is metadata admission, not content validation: the broker retains
its key-format checks, and connection handling retains its parser/refusals.

Every admitted file remains root:root, mode `0440`, regular and singly linked,
inside root:root mode `0550` credentials. The exact ACL admits only root and the
current non-root service UID. Directory/file permissions, ownership, ACL and
read-only tmpfs mount flags (`nosuid,nodev,noexec`) are all checked by the kernel
metadata helper; no credential contents are read or printed by it.

The receipt key is the file's **raw bytes**, as before. HMAC computation does not
hex-decode text. A later encrypted-store handoff must preserve the selected
encoding exactly between rehearsal and apply. Receipt authentication is machine
execution evidence, not a signature or a human authorization.

After connection parsing, the password goes only into the owned `0600` tmpfs
`PGPASSFILE`; the connection passed to PostgreSQL programs contains no password.
Previously the file's raw URL was exported before parsing, so escaping subprocesses
inherited its password briefly. A real child-environment observer failed before
the fix and passed afterward: the file-loaded value now stays local until stripped.
The accumulated exit dispatcher removes that owned file on exit. It does not
promise erasure of every shell/process-memory copy.

## Evidence

The ordinary tests execute the real shell library and compile the native C
predicates. New refusal tests failed before the adapter: unknown modes were
ignored, and systemd mode accepted unsafe temporary storage and inherited
password files. Native predicate plants cover exact UID/ACL, custody flags,
ownership, mode, link/type and each named size limit. Private-file and existing
receipt authenticity regressions still execute through their original interface.

The root-only [selected-VM driver](../../scripts/deploy/test-migration-credentials.mjs)
uses [this public payload](../../tests/fixtures/systemd-migration-credentials.sh),
temporary native units and an existing isolated account. Compile a fresh helper
with the target-compatible compiler, then run the driver as root with that
helper path. It contains only public fixture values, performs no database or
network connection, and sends no production alert.

On 2026-10-02 the selected VM admitted both named database credentials and the
receipt key through PID 1's actual ACL-protected credential mounts; the unchanged
index-key call also passed. Password removal from the connection, tmpfs confinement
and exit cleanup passed. Oversized URL, short key, unknown name, paths outside
the credential directory, a service-owned helper and a writable helper refused.
The positive case passed again after restoring helper custody. Public fixture
directories are retained; transient units and owned password directories stop
after each invocation. These checks are custody/lifecycle evidence, not an actual
authenticated migration rehearsal, real-key delivery or host commissioning.

A separate negative native invocation with `ProcSubset=pid` refused with
`systemd custody refuses active or unverifiable swap`, before password creation.
Its runtime directory was removed after the expected failed invocation. This
proves the fail-closed interaction with the existing migration unit's proc policy;
the future credential-enabled invocation must explicitly expose the swap table.

## Remaining integration

The [handoff module](../../scripts/deploy/workstation-credentials.mjs) has two
closed realms sharing the custody and transport implementation. The migration
interface is `migration-send CONFIG` (explicit delivery/rotation) and
`migration-sync CONFIG` (deliver only when the boot-bound generation is missing).
Root-only guest commands are `migration-receive` and `migration-status`, with no
extra arguments. Its protocol is `kf-workstation-migration-credentials-v1`,
exactly five newline-delimited lines, bounded to 16,384 bytes. The payload is:

| Encrypted-store name           | Guest credential name    |
| ------------------------------ | ------------------------ |
| `KF_MIGRATOR_DATABASE_URL`     | `database-url`           |
| `KF_REHEARSAL_DATABASE_URL`    | `rehearsal-database-url` |
| `KF_REHEARSAL_RECEIPT_KEY_HEX` | `rehearsal-receipt-key`  |

This selected-host adapter accepts only PostgreSQL URIs on `127.0.0.1`,
production port 5432 and rehearsal port 5433, with different database names,
principals and passwords. Names are plain identifiers; passwords use printable
unencoded letters, digits, dot, underscore, tilde or hyphen. Each URI is bounded
to 8,192 bytes. Reserved PostgreSQL database names, encoded userinfo, fragments
and connection redirection/options refuse. The only optional query is exactly
`sslmode=disable`, for these local selected-host connections. This does not
replace the migration script's disposable-cluster and empty-target checks.

The receipt key is 64 lowercase hex characters, representing 32 bytes of random
entropy. It is delivered as **64 ASCII bytes without a newline**, not hex-decoded.
The existing HMAC interface reads exactly those raw bytes in rehearsal and apply.
It is a deployment receipt credential, not a preservation signing key, document
approval or authority grant.

Atomic generations live only under
`/run/kf-workstation-migration-credentials/current`, with the same root-only,
unswapped tmpfs and boot-binding policy as startup credentials. Readiness checks
validate all three values, not just their presence. Cross-realm bundles refuse.
Neither successful delivery nor refused updates touch the startup generation.
No environment name, arbitrary destination, host or credential list can be
supplied by a caller. SSH retains the clean child environment, pinned host key,
exact receiver digest, deadlines and suppression of untrusted output.

The separate [service](../../deploy/workstation/kf-host-migration-credentials.service.in)
and [timer](../../deploy/workstation/kf-host-migration-credentials.timer.in)
templates use the existing four-field non-secret config contract and a
digest-versioned sender/receiver pair. They recover only this realm. The timer
never invokes a migration. Installing the new pair does not require changing
the already installed v2 alert/retrieval pair or its timer. Source sharing is
not permission to replace a sealed or installed module in place.

The [native public proof](../../scripts/deploy/test-workstation-migration-credentials.mjs)
runs as root on an unswapped tmpfs host. It uses a uniquely owned `/run` fixture,
not the real credential roots, and removes only that fixture. It demonstrates
both realms, exact permissions/receipt encoding, preserved generations and
cross-realm, ownership, swap, boot and widened-access refusals. It does not
connect to a database, import a real credential or qualify reboot recovery.

For manual sender/import commands, disable core dumps in the invoking shell
before unlocking secrets (`ulimit -c 0`). The workstation template sets both
core limits to zero; the pinned remote transport disables them before `sudo`.
Neither this contract nor buffer clearing promises erasure of every runtime
string copy.

Install its manual migration policy only
after the exact new release and handoff are verified. The baseline provisioner
still has legacy persistent secret generation and must not be run unchanged for
the selected custody policy.

The selected rehearsal database is already occupied (80 migration rows observed
2026-10-02). Preserve it and use a fresh empty target on a verified disposable
cluster; never bypass the nonempty-target refusal or destroy existing state to
make the test pass. The fresh `kf_rehearsal_20261002_custody_v1` on the separate
port-5433 cluster now passes that exact empty-target query under builtin
`C.UTF-8`/UTF8; the old database is retained unchanged. The new encrypted-store
rehearsal connection now targets it; the legacy guest file still targets the
old database and is preserved, not overwritten. A freshly authenticated receipt, guarded promotion, installed
startup/recovery/reboot proof, preservation and qualification remain separate work.

## Actual handoff checkpoint — 2026-10-02

The selected VM passed the public native proof, leaving no temporary proof
directory. Nine new regression tests and the eleven existing startup-handoff
tests passed. The ordinary full `pnpm gate` then passed: 2,950 tests, 25 opt-in
skips, 302 passed files and four skipped files, clear dependency audit, current
generated outputs and successful production build. Existing fixture/ontology
warnings remain; this is not independent qualification.

The migration sender/receiver was installed byte-identically at a separate
digest-versioned path, SHA-256
`29c787cddd061f494d9777247ffdc712ee2ac891a4f10c0a3eefd577901c064d`.
Existing production and rehearsal connection credentials were imported directly
through pinned SSH into the workstation encrypted store. Only the rehearsal
database name changed, in memory, to the fresh target above. A separate random
receipt key was generated in memory and stored encrypted. No credential value
entered a command argument, source, log or new persistent plaintext file.

Actual `migration-sync` succeeded. The guest reported the migration v1 realm
ready, with root-owned `0400` files; the ordinary guest account could not read
any of them. The separate workstation timer is enabled and active, and its
oneshot exited zero with both core limits zero. A value-aware journal check
found none of the three credential values and printed only its verdict.

The existing startup sender/receiver remains at its prior v2 digest, its
generation is unchanged, its timer remains active, and all five existing KF
modules are active on the old application release. Legacy plaintext guest
database files are preserved for existing consumers: this handoff does not
claim that all host secret custody has been converted. No database migration,
rehearsal receipt, application promotion, production alert or human approval
was performed. Real reboot recovery of this new realm remains unproved.
