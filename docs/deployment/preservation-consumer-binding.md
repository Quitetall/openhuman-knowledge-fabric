# Selected native preservation consumer binding

This is a deployment adapter above the existing preservation scripts, not a
database/compiler change or an installed/commissioned backup system. The
[fixed entrypoint](../../scripts/deploy/preservation-consumer.sh) accepts
exactly one of `backup`, `offsite`, `drill`, with no extra argument, executable,
destination selector or environment-name list. Existing standalone preservation
and rsync callers are unchanged. This optional deployment selects B2 for copy
and restore; a different configured provider refuses rather than falling back.

## Inputs and invocation

PID 1 must supply the exact credential set, its canonical private credential
mount, and one service-owned mode `0700` unswapped tmpfs runtime directory.
The existing native helper checks each named file's purpose, size, read-only
mount, service-UID ACL and root ownership. Extra/missing names refuse.
Entrypoint, shared library, helper, fixed callee and public routing paths must
remain root-protected. Root/manual ordinary callers are not admitted.

| Command | PID 1 credential names                                                                               | Fixed callee              |
| ------- | ---------------------------------------------------------------------------------------------------- | ------------------------- |
| backup  | database-url, preservation-signing-key                                                               | scripts/backup.sh         |
| offsite | database-url, b2-endpoint, b2-bucket, b2-key-id, b2-key                                              | scripts/backup-offsite.sh |
| drill   | database-url, backup-decryption-key, s3-secret-access-key, b2-endpoint, b2-bucket, b2-key-id, b2-key | scripts/restore-drill.sh  |

`RUNTIME_DIRECTORY` selects `TMPDIR`; old environment-file TMPDIR/password
routes cannot select disk storage. After environment-file loading, the
entrypoint binds each role's file inputs explicitly and invokes only its
fixed callee with a clean environment containing the fixed file inputs and
declared public settings. A legacy signing path cannot override that binding.
No inline key, parent's password file, unrelated encrypted-store entry,
signing path for drill, or recovery path for backup is forwarded.

Backup uses a timestamped child of `/srv/kf-backups`; offsite selects its newest
non-hidden directory, refuses symlink redirection, and passes the label and
optional failure-domain reference as separate quoted arguments. Drill uses
that fixed backup root and its private runtime for GPG/decrypted working bytes
and the scratch cluster. The entrypoint waits for its child, preserving the
existing exit cleanup rather than losing it to `exec`. Child failure remains
failure. Missing public trust/checkpoint/recipient inputs refuse before invoking
the relevant callee. Cryptographic validity remains the callee's obligation.

## Optional overrides and prerequisites

The overrides are [backup](../../deploy/systemd/backup-workstation-credentials.conf),
[B2 copy](../../deploy/systemd/offsite-b2-workstation-credentials.conf), and
[B2 drill](../../deploy/systemd/drill-b2-workstation-credentials.conf).
They clear obsolete credential declarations/prechecks/commands, select their
fixed credential sets and entrypoint, and add private runtimes and core/swap
restrictions. Drill also clears the persistent StateDirectory and sealed-key
input. Public routing remains in the existing environment files.

The drill key ID/key source is deliberately **not** the uploader's B2 realm:
it names `/run/kf-workstation-drill-b2-credentials/current`. The
[dedicated reader handoff](drill-b2-credential-delivery.md) is now implemented,
but not installed. PID 1 still refuses activation while the source is absent;
never point it at the upload key just
to make the unit start. Endpoint/bucket remain shared public routing. A separate
provider reader key and measured read-only permissions are required. Names or
metadata admission do not establish provider capabilities.

No override is installed by this change. The selected VM does not yet have
`kf-backup`, `kf-offsite`, `kf-drill` accounts or `/srv/kf-backups`; the public
proof uses an existing isolated non-root fixture identity instead. Actual
distinct accounts, database grants, key capture, public trust bindings and
reader capabilities remain activation prerequisites. Do not use the candidate's
153-migration preservation scripts against the live 91-migration baseline.
Preserve/recover that baseline first, then seal/rehearse/promote the exact
candidate under the migration gate.

## Proof scope

The [interface tests](../../tests/deployment/preservation-consumer-binding.test.ts)
initially failed before this entrypoint and the overrides existed. The first
template regex crossed a newline into the empty credential reset; the corrected
parser admits one line only. Static override checks are not installed-unit proof.

The [public native driver](../../scripts/deploy/test-preservation-binding.mjs)
uses the real entrypoint, shell adapters and compiled native helper under PID 1,
with [public fixed-callee fixtures](../../tests/fixtures/systemd-preservation-binding.sh).
It checks real environment-file precedence, exact field sets, quoted arguments,
missing/extra refusal, routing/runtime/callee protection, child status, and
password/key cleanup before PID 1 removes the runtime directory. Its private
`/srv` mount never creates or modifies the real backup directory. Deliberately
removing the clean-child-environment guard makes this proof fail at the callee
on inherited `PGPASSFILE`, not at a source-string comparison.

Its integrated reader case now uses the actual reader publication function
and an owned private generation as PID 1's source, instead of a direct token
fixture file. The fixed callee verifies the public reader bytes. All 15 cases
pass, including deliberately selecting the uploader source for drill and
observing refusal with status `98`, followed by empty-runtime cleanup.
It still uses the fixture UID and no installed credential root or SSH sender.

The fixture does not run SQL, upload/download, parse real cryptographic keys or
recover a database. It proves invocation and custody only, not the entire
preservation operation, installed overrides, production role isolation,
Bitwarden recovery, provider authorization, baseline recovery, commissioning,
qualification or human acceptance. Retain these as separate obligations.
