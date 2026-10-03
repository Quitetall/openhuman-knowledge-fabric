# Selected backup custody and off-site destination

The owner selected Backblaze B2 for encrypted off-site backups on 2026-10-02,
with the recovery copy of the keys held by the owner in Bitwarden. This is a
deployment choice, not a record that an account exists, keys have been saved,
data has been uploaded, a restore succeeded or a release was accepted.

## Preserve the existing contracts

The [backup interface](../backup-and-restore/README.md) already encrypts to an
operator-held **OpenPGP public key**. Only that public recipient belongs on the
VM; the recovery private key must not. Signed preservation manifests use a
separate **Ed25519 key** and external historical public-key trust store. Do not
replace either format with another encryption scheme just to configure B2.

Bitwarden is the owner's recovery copy. Automated signing still needs a
dedicated machine credential through the selected encrypted-store/volatile
custody arrangement. It is not a schema approval, human signature or authority
grant. Neither the migration receipt key nor keys from another project may be
reused as a preservation signing or recovery key.

Recovery must be demonstrated without depending on the original workstation's
TPM or the lost VM. A vault item that has not actually been saved and tested is
not custody evidence. Never put private keys in this document, chat, command
arguments or a persistent plaintext export file.

## Account setup scope

The human setup sequence is account and MFA, cost caps, a private backup bucket,
then a purpose-specific bucket-scoped application key. The account data region is an
explicit owner choice at signup; the bucket and its endpoint use that region. Do not enable public access,
web hosting, cross-origin access or automatic historical-backup deletion.

Capture names for the setup helper and transport are `KF_B2_BUCKET_NAME`,
`KF_B2_S3_ENDPOINT`, `KF_B2_APPLICATION_KEY_ID` and `KF_B2_APPLICATION_KEY`.
They go directly into the workstation encrypted store, not a `.env`, GitHub
secret or source file. The [transport caller contract](b2-ciphertext-transport.md#cli-copy-ledger-and-restore-callers)
now consumes these names; this is not evidence that real values were delivered
or provider access was verified. Do not use a master application
key or the existing Cloudflare DNS credential. Measure the created key's actual
capabilities before treating it as least-privilege delivery.

The provider advertises [10 GB of free storage](https://www.backblaze.com/cloud-storage/pricing)
and [signup without a credit card](https://www.backblaze.com/sign-up/cloud-storage).
Free storage is not an unlimited-history guarantee. Review [caps and alerts](https://www.backblaze.com/docs/en/cloud-storage-create-and-manage-caps-and-alerts)
and distinguish blocked uploads from successful off-site protection. As measured
on 2026-10-02 the live `kf` database occupied 25,867,967 bytes; that is database
size, not a measured encrypted backup or the full preservation inventory.

Provider-console instructions come from the [integration setup](https://www.backblaze.com/docs/en/cloud-storage-get-started-with-a-backblaze-integration)
and [developer quickstart](https://www.backblaze.com/docs/cloud-storage-developer-quick-start-guide).
If the visible console differs, stop and check rather than guessing.

## Engineering and commissioning still required

`scripts/backup-offsite.sh` now supports the literal `b2` selector beside its
rsync/local paths; B2/S3 URIs are refused. The [shared transport module](b2-ciphertext-transport.md)
provides version-pinned upload/read-back and download. Source-manifest authentication,
the exact cloud identity in the append-only copy ledger, and the restore drill's
B2 download path are wired and locally tested. Real encrypted-store credential
delivery to these consumers, provider authentication/capabilities, uploaded backup,
recovery-key custody and isolated restore still require commissioning.

The [separate B2 handoff](b2-credential-custody.md) now implements the four-field
encrypted-store-to-volatile-VM interface and reboot recovery templates. Public
native custody/command tests are not actual credential delivery or installation.

## Preservation caller custody adapter

The [preservation shell adapter](../../scripts/lib/preservation-secrets.sh) now
uses the existing Linux guard for exactly `preservation-signing-key` (1–4,096
bytes) and `backup-decryption-key` (1–65,536 bytes). These bounds admit credential
files, not valid cryptographic keys: the export signer still parses Ed25519 and
GnuPG still parses the recovery key. Neither purpose is part of the B2 payload.

In explicit systemd custody the signing input must be that exact named PID 1
credential. The backup caller makes an owner-only mode `0400` copy in its
service-owned mode `0700`, unswapped tmpfs `TMPDIR`, retaining the export CLI's
ordinary owner-only file contract. Its shared exit dispatcher removes the copy
on success or failure. The recovery caller admits only the named native-checked
credential, not an arbitrary group-readable file. Its work root must equal the
same private runtime directory, keeping the imported keyring and decrypted
working bundle off persistent storage. Ordinary owner-only standalone inputs
remain supported; empty, oversized, symlinked or multiply linked keys refuse.

Seven ordinary-file/caller tests and the extended public PID 1 fixture exercise
these paths. The native proof includes both purpose-confusion refusals, bounds,
owner-only signing-copy metadata, success/failure cleanup, and refusal of a drill
work root outside the runtime directory. It does not import a real recovery key,
sign a backup, access a database or install a production credential.

### Database and object-reader child handoff

The same adapter now exposes `kf_preservation_database_child` and
`kf_preservation_object_child`. Native `database-url` and
`s3-secret-access-key` inputs are admitted by their exact purpose, then copied
as raw bytes to service-owned mode `0400` files in the private, unswapped tmpfs
runtime directory. Both are bounded to 1–8,192 bytes; the actual consumer still
parses the contents. Children receive explicit file inputs, not inherited
inline values or the parent's password file. The ordinary Node secret loader
retains its owner-only contract. Owned copies are removed after success or
failure, and the child exit status is preserved. Ordinary standalone database
callers without a file retain their existing sanitized URL/password-file mode;
explicit systemd custody never falls back to that mode.

The restore verifier uses its scratch `target-url` for both re-export and
checkpoint verification, even if its environment names a production database
file. Under systemd that target must be a canonical, single-linked, owner-only
file under the service's private runtime directory, with private intermediate
directories. It is not admitted as a native ledger credential. Conversely,
the ledger requires the named native `database-url`. The drill starts the
verifier without the parent's password-file variables, so the verifier owns
and cleans up a fresh password file. The built-in object reader gets its own
admitted volatile input; the separately pinned external verifier is unchanged.

The public PID 1 proof exposed another cleanup defect: registering an exit hook
inside command substitution inherited the parent's hook list and deleted the
parent's password file. Hook registration and owned-copy cleanup now track
`BASHPID`, not `$$`, and refuse ownership of another shell process's resources.
The direct regression failed before the fix. The corrected focused set passed
71 tests across seven files; 14 real PostgreSQL backup/restore tests also passed,
including exact re-export with an inherited production file. The extended
native proof uses the actual built ordinary secret loader and checks copy
metadata, failure cleanup, purpose/size refusals and fresh child password
lifecycle. Its first failing run is retained. An initial real-database test run
also refused a user-owned verifier fixture in production mode; the fixture now
explicitly uses test mode, without weakening the production verifier guard.

This is not complete consumer activation. The installed backup/offsite/drill
units still require separate database/signing/recovery/object-reader delivery,
explicit `LoadCredential` and runtime-directory drop-ins. Do not set systemd
custody on those old units and infer that the whole drill can run. Preserve and
demonstrate the 91-migration baseline recovery before using the candidate's
153-migration backup/export paths.

The separate-drive `/mnt/2tb/kf-preservation` is a replica on the same
workstation. It remains useful but does not become off-site because B2 has now
been selected. B2 custody/credentials, encrypted backup generation, independent
copies, real restore and alerts remain uncommissioned until observed.
