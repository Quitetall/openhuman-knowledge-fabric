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

The separate-drive `/mnt/2tb/kf-preservation` is a replica on the same
workstation. It remains useful but does not become off-site because B2 has now
been selected. B2 custody/credentials, encrypted backup generation, independent
copies, real restore and alerts remain uncommissioned until observed.
