---
schema: oh.war/atom/v1
warrant_uuid: 01a084e1-5936-7bc3-bb49-777cdd4bb598
role: basis
jurisdiction: authored
order: 20
classification: internal
---


# Basis

## The contract this work is performed against

- **SAS `0.1.0-draft.3`**, accepted 2026-09-04, `sha256:ecb95a11e5c5e48316ef7bea1ebc7ccb0cea65fbed15547ddd993948c71b6c92`.
  §98 Phase 9 is the objective; the twelve §106 requirements this Warrant implements are named in
  its manifest.
- **`docs/deployment/private-host.md`** — the deployment contract, and the authoritative list of
  commissioning blockers.
- **ADR 0004** — what v1.0 claims, and the five criteria. Criterion 3 is a commissioned host.

## What already stands, and is therefore not re-litigated here

Measured 2026-09-09 on the host, four days after it was built and without intervention:

| Fact | State |
|---|---|
| The host exists and is not the workstation | Debian 13 VM, `kf-host-1`, user systemd service, survives reboot |
| Six host requirements | probed on a near-empty image; bubblewrap namespace qualification passes |
| PostgreSQL 18.6 | running, `jit = off` per the measured planner setting |
| `kf` database | 88 migrations applied by a non-superuser migrator; ontology seeded 39/145/41 — the counts as installed on that date, not as the repository stands now |
| Object store | MinIO, own account, own credentials, bucket, scoped API key |
| Identity | Keycloak, own database, realm `knowledge-fabric`, `sslRequired: all`, two clients |
| TLS | private CA, nginx terminating, CA-verified 200, `:80`→308, unknown name→444 |
| Release | built in a disposable worktree, sealed, verified in place, `/opt/kf` switched atomically |
| API | `/ready` reports database and schema ok; 401 without a token AND on forged identity headers |

## The unknown this Warrant is exposed to

**Whether a host that is a virtual machine on the build workstation can produce commissioning
evidence that means anything.** It is a genuinely separate operating system, kernel, service set
and credential set — which is what found five missing host requirements the first time, and a
documentation gap and a wrong measurement this time. It shares the workstation's power supply,
motherboard and one of its disks, which no amount of configuration changes.

The honest position, recorded here rather than discovered by a later reader: this host can
evidence every control that is a property of *configuration*, and cannot evidence availability
under a hardware failure of its host machine. §100 of the SAS carries that as a limit.

## Storage, and a correction

The durable copy needs a device that fails independently of the one holding the working store.
This was recorded as impossible on 2026-09-05 — "no truly different hardware on this box" — and
that was **wrong**. It came from reading `df`, which lists mounted filesystems, rather than
`lsblk`, which lists devices. The box has five: two NVMe, a 1.9 TB spinning disk at `/mnt/2tb`
with 1.4 TB free, an unused 238 GB SATA SSD with no filesystem, and a 7.3 TB external USB drive.

`/mnt/2tb` is a different physical device and a different storage technology from the NVMe the
VM lives on. It is the durable store for this Warrant. The unused SSD would isolate better and
needs formatting, which is a decision rather than a step.
