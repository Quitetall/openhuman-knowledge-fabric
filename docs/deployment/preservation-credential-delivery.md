# Purpose-separated preservation credential delivery

The selected persistent custodian is the workstation encrypted store. The
[handoff module](../../scripts/deploy/workstation-credentials.mjs) now adds
three closed realms beside the unchanged startup, migration and B2 protocols.
This is a delivery interface, not actual key custody, database authorization,
consumer activation, baseline recovery or qualification.

## Fixed consumer sets

Each realm has its own root-only generation and explicit `send`, `sync`,
`receive` and `status` verbs. There is no arbitrary role, environment-name list
or destination selector. For example, `backup-send CONFIG` delivers/rotates,
`backup-sync CONFIG` delivers only if that boot-bound generation is unavailable,
and root-only `backup-receive`/`backup-status` accept no further argument.
Offsite and drill use the corresponding `offsite-` and `drill-` prefixes.

| Realm   | Workstation encrypted-store name        | Guest credential           | Decoded byte bound |
| ------- | --------------------------------------- | -------------------------- | ------------------ |
| backup  | `KF_BACKUP_DATABASE_URL`                | `database-url`             | 1–8,192            |
| backup  | `KF_PRESERVATION_SIGNING_KEY_BASE64`    | `preservation-signing-key` | 1–4,096            |
| offsite | `KF_OFFSITE_DATABASE_URL`               | `database-url`             | 1–8,192            |
| drill   | `KF_DRILL_DATABASE_URL`                 | `database-url`             | 1–8,192            |
| drill   | `KF_BACKUP_RECOVERY_PRIVATE_KEY_BASE64` | `backup-decryption-key`    | 1–65,536           |
| drill   | `KF_DRILL_S3_SECRET_ACCESS_KEY`         | `s3-secret-access-key`     | 1–8,192            |

Backup contains no decryption or object-reader key. Offsite contains neither
signing nor decryption key; B2 remains a separate four-field realm. Drill
contains no preservation signer. Root remains the trusted custodian; these
sets do not isolate one trusted root process from another. Actual consumers
must keep their distinct service UIDs and receive only their named inputs
through PID 1. Do not give a consumer access to another realm's root generation.

Database strings follow the existing selected-host migration URI grammar:
PostgreSQL, `127.0.0.1:5432`, plain database/principal names, printable unencoded
passwords, no reserved PostgreSQL databases or redirection/options, and only
the optional query `sslmode=disable`. Syntax admission does not establish
grants, least privilege or distinct principals. Those must be verified against
the live database before activation. Do not reuse the migration login.

## Multiline keys and bounded framing

The workstation `secrets set` command accepts a single line, not multiline PEM
or OpenPGP material. Its two explicit `_BASE64` names therefore hold canonical
base64 of the original key bytes. Base64 is encoding, not encryption: it goes
only into the already encrypted store, never source, argv, chat or a plaintext
file. Missing padding, alternate spellings, extra whitespace, invalid UTF-8,
empty values and decoded oversize refuse. The guest files contain the original
decoded bytes, including their original final newline, not base64 text.

Each wire protocol is `kf-workstation-<realm>-credentials-v1`, followed by one
canonical-base64 line per fixed field and a final newline. Every field is
encoded on the wire; only the two multiline keys are base64 values in the
workstation store. Extra/missing fields, cross-realm framing and trailing data
refuse. Backup is bounded to 20,480 wire bytes, offsite to 16,384 and drill to
112,640. The larger drill bound admits its existing 65,536-byte recovery input
without widening startup, migration, B2, backup or offsite limits. Each decoded
guest file has its own bound; the live boot binding is still checked separately.

The signing input must be a single unencrypted PKCS#8 PEM Ed25519 private key,
parsed by Node's crypto implementation. The recovery input must be one bounded
ASCII-armored PGP private-key block; this transport does not import it or prove
GnuPG validity, passphrase availability or successful decryption. GnuPG and the
actual isolated restore retain those obligations. The object-reader input is
a bounded non-whitespace printable token; the storage provider must still
prove its read-only capability. No helper generates production keys or signs
human approval.

## Custody and recovery templates

Roots are `/run/kf-workstation-backup-credentials`,
`/run/kf-workstation-offsite-credentials` and
`/run/kf-workstation-drill-credentials`. Atomic boot-bound generations remain
root-owned mode `0700`, with singly linked regular mode `0400` files. Active or
unverifiable swap, disk storage, widened access, wrong ownership, symlinked
roots, escaping generations, missing/drifted inputs and wrong boot binding
refuse. A refused update leaves every existing generation unchanged.

The separate workstation templates are
[backup service](../../deploy/workstation/kf-host-backup-credentials.service.in)/
[timer](../../deploy/workstation/kf-host-backup-credentials.timer.in),
[offsite service](../../deploy/workstation/kf-host-offsite-credentials.service.in)/
[timer](../../deploy/workstation/kf-host-offsite-credentials.timer.in), and
[drill service](../../deploy/workstation/kf-host-drill-credentials.service.in)/
[timer](../../deploy/workstation/kf-host-drill-credentials.timer.in).
They use the existing four-field non-secret config contract and digest-versioned
sender/receiver pairs. They recover credentials only; they never run a backup,
copy, restore, migration or promotion. No template is installed by this change.
Preserve installed startup/migration/B2 pairs; do not overwrite their pinned
source in place. SSH retains the pinned host key, exact receiver digest, clean
child environment, deadlines and suppression of untrusted output. Disable core
dumps before any manual encrypted-store invocation. Clearing buffers cannot
erase every JavaScript string copy.

## Evidence and remaining activation

The interface tests cover exact field sets, decoded key bytes, all six realms'
rotation/refusal isolation, file and framing bounds, custody refusals, no-secret
error output and separate recovery timers. The
[public native proof](../../scripts/deploy/test-workstation-preservation-credentials.mjs)
runs actual role receive/status commands in private mount namespaces on the
selected VM. It exercises the maximum recovery-field size using deliberately
invalid-GPG public armor, not a real recovery key. Its root-only fixture never
publishes into the real credential roots and removes only its owned directory.
It proves custody/command behavior, not real encrypted-store/SSH delivery,
database grants, installed consumer operation or recovery.

The [selected consumer binding](preservation-consumer-binding.md) now implements
optional explicit `LoadCredential`, private runtime and core/swap overrides
with a closed entrypoint. They are not installed. It resolves old prechecks and
conflicting environment-file routes: `EnvironmentFile` can override
`Environment`, so the actual child bindings are set after that loading.
Its distinct B2 reader-key handoff remains required before drill activation.
Do not run candidate preservation SQL against production's old 91-migration
schema. Demonstrate baseline preservation/recovery first, then seal and rehearse
the exact candidate before guarded migration/promotion. Dedicated real keys,
owner-held Bitwarden recovery copies, B2 access, off-site read-back/restore,
commissioning and qualification remain open.
