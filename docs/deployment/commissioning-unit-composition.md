# Commissioning unit-file composition

`unit_provenance` compares installed base files with the sealed release and
admits only an exact, unit-specific optional credential template. It does not
prove that PID 1 loaded those files or that a service started successfully.

The previous directory reader inspected only `.service` bases. A public
fixture overriding `kf-api` to `kf-worker` still reported `kf-api`. The same
reader now composes applicable `.conf` files before reducing the directives
used by identity, secret-path and attestor checks. The original fixture reports
`kf-worker`; provenance refuses that unreviewed override.

## Declared filesystem scope

Within `KF_SYSTEMD_DIR`, the reader visits type-wide `service.d`, dash-prefix
directories, template directories and the exact unit directory. Equal
filenames select the most specific directory; selected filenames are ordered
by ASCII lexical comparison, not the process locale. Recursive instance-prefix
lookup also follows the selected VM's [systemd 257 implementation](https://raw.githubusercontent.com/systemd/systemd/v257/src/shared/dropin.c),
including template and instance variants of a truncated prefix. This follows the relevant
[systemd unit-file rules](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.unit.xml).
Only bases named by the release are inspected; unrelated host services are
outside this check's contract. Template fallback without an explicit instance
base is not implemented by this reader.

Fragments must be regular UTF-8 files, at most one MiB. Symlinks, masks,
non-directory drop-in paths and files changing during inspection refuse.
The reader opens files without following their final symlink and closes its
handles on every exit. It does not promise an atomic snapshot of the whole
directory or protection against an administrator changing files afterward.

Directive reduction respects `[Unit]` versus `[Service]`, resets of list
directives, command continuations and replacement of an `Environment` variable.
Each fragment begins outside any section. The environment reset/replacement
rules follow the [systemd execution documentation](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml).
This is a reducer for KF's reviewed declarations, not a general systemd
parser, environment-file interpreter or shell evaluator.

## Optional reviewed bindings

Base bytes must remain identical to the release. Fragment digests are SHA-256
over exact UTF-8 file bytes, not canonical structured records; the digest-tag
gate records that raw-byte rationale explicitly. No drop-in is required by
this check. When present, exactly one selected fragment is admitted, at
`<unit>.d/<template>` with bytes matching the sealed template:

| Unit                         | Template                                              |
| ---------------------------- | ----------------------------------------------------- |
| `kf-api.service`             | `application-api-workstation-credentials.conf`        |
| `kf-worker.service`          | `application-worker-workstation-credentials.conf`     |
| `kf-attestor.service`        | `application-attestor-workstation-credentials.conf`   |
| `kf-checkpoint.service`      | `application-checkpoint-workstation-credentials.conf` |
| `kf-storage.service`         | `application-storage-workstation-credentials.conf`    |
| `kf-readiness.service`       | `application-readiness-workstation-credentials.conf`  |
| `kf-backup.service`          | `backup-workstation-credentials.conf`                 |
| `kf-backup-offsite.service`  | `offsite-b2-workstation-credentials.conf`             |
| `kf-restore-drill.service`   | `drill-b2-workstation-credentials.conf`               |
| `kf-alert@.service`          | `alert-workstation-credentials.conf`                  |
| `kf-alert-heartbeat.service` | `alert-heartbeat-workstation-credentials.conf`        |

An edited, renamed, additional, wrong-role or unrecognized selected fragment
refuses, including a no-op comment file. Lower-specificity same-name files
are read safely but do not enter the selected composition. This is not an
approval workflow for arbitrary operator overrides.

## Evidence and remaining commissioning

`packages/operations/src/commissioning-composition.test.ts` reaches the actual
directory reader and provenance check. Its initial six regressions failed on
the previous reader. Coverage includes scope filtering, filename precedence,
template/instance and recursive prefix composition, reset/section behavior,
symlink, oversize and invalid-UTF-8 refusal,
unchanged-base requirements, all eleven native bindings together and a
separate edited-template refusal for each binding. The earlier commissioning
and provisioning batteries remain unchanged.

These are local file-composition checks, not a commissioned host. Remaining
work includes all effective systemd load paths, aliases and instantiated
templates, transient properties, loaded fragment/drop-in agreement and
daemon-reload state, actual credential-generation custody, distinguishing
public configuration/projection files from secrets, service failure/startup
and reboot recovery. The older secret-path heuristic is not a proof of full
native credential posture. Real encrypted-store inputs, B2 transfer/read-back,
independent recovery, qualification and human acceptance remain separate
requirements. Do not promote the candidate or mark 1.0 complete on this result.
