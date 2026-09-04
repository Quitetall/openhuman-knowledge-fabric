# The dogfood host, as a virtual machine

A host that is **not the build workstation**, because the deployment contract's central control
is that a release is promoted byte-for-byte to a machine that does not build it. A workstation
commissioning itself verifies nothing: `docs/deployment/private-host.md` records that qualifying
the first machine that was not the workstation found **five** host requirements unsatisfied,
while the suite had been green throughout on a workstation that satisfied all five by accident
of its own history.

This document exists because the previous VM was lost. It was built 2026-08-26 and unreachable
by 2026-08-27: its SSH key had been written to a session scratchpad that was cleared, and with
no second way in the disk could not be recovered. Nothing here lives in a scratchpad.

## What is on disk

| Path                                   | What                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `/mnt/4tb/kf-vm/kf-host-1.qcow2`       | the host's disk, backed by the Debian 13 generic cloud image beside it |
| `/mnt/4tb/kf-vm/seed-kf-host-1/`       | the cloud-init user-data and meta-data                                 |
| `/mnt/4tb/kf-vm/seed-kf-host-1.iso`    | those two, as a `cidata` volume                                        |
| `/mnt/4tb/kf-vm/run-kf-host-1.sh`      | the qemu invocation, written down rather than retyped                  |
| `/mnt/4tb/kf-vm/kfssh`                 | ssh to the host with the right key and port                            |
| `/mnt/4tb/kf-vm/kf-host-1-console.log` | the serial console                                                     |
| `~/.ssh/kf-host-1`                     | the private key, deliberately durable                                  |

The seed is **not committed**, because it carries a serial-console password. That password is a
second door on the console only; SSH password authentication is off. A host with exactly one
door is a host you lose, which is the lesson of the VM this one replaces.

## Why plain qemu and not libvirt

Three libvirt configurations were tried and each failed for its own reason. They are recorded so
nobody spends the afternoon again:

- **system connection, bridged `default` network** — the domain runs and never receives a DHCP
  lease. The host's firewall on `virbr0` is the likely cause; it needs root to investigate.
- **session connection, plain user networking** — no port forwarding, so nothing can reach the
  guest.
- **session connection, passt backend with `portForward`** — accepted by libvirt, and the guest
  boot-loops at GRUB with no kernel output. `--cpu host-passthrough` is the difference; the same
  disk boots under qemu without it.

The invocation in `run-kf-host-1.sh` is the one that was **observed** to boot, reach cloud-init
and start sshd. Two traps cost time getting there and are worth stating. libvirt's `--serial
file` captured only GRUB redraws, so the log looked like a boot loop when the guest was fine —
the kernel console was elsewhere. And `pkill -f kf-host-1.qcow2` matches the shell running it,
so stopping the VM that way kills the caller; use the process id.

## Provisioning

The six host requirements, installed exactly as `.github/actions/provision-host/action.yml`
installs them, because two copies of a host contract is two chances to be wrong about it:

| Requirement             | On this host                                              |
| ----------------------- | --------------------------------------------------------- |
| bubblewrap              | 0.12.0 at `/usr/bin/bwrap`                                |
| pandoc                  | 3.1.11.1                                                  |
| a LaTeX engine          | pdfTeX 3.141592653-2.6-1.40.26, PDF probe passes          |
| python3                 | 3.13.5                                                    |
| Node at `/usr/bin/node` | v24.18.1, tarball verified against the published checksum |
| PostgreSQL 18 client    | 18.6, all four tools, PGDG key pinned by digest           |

The sandbox qualification passes: `kernel.apparmor_restrict_unprivileged_userns` is absent on
Debian, and both `bwrap --unshare-user --disable-userns` and `--unshare-all` succeed. This is
the requirement a container could not have satisfied honestly, and the reason this is a virtual
machine rather than a namespace on the workstation.

PostgreSQL 18.6 is installed and running with `jit = off` in a `conf.d` fragment, for the reason
`deploy/postgres/planner.conf` records: row-level security inflates the planner's cost estimate
about a hundredfold, JIT fires on the estimate, and the configuration was measured 8 to 14 times
slower with it on.

## What this host is not

**It is not commissioned.** It has no `kf` database, no promoted release, no TLS, no reverse
proxy and no identity provider realm. `kf-commissioning` reports a check it could not run as
`unverifiable` and fails on it exactly as it fails on `unsatisfied`, so nothing here may be
cited as evidence of institutional readiness. Phase 9 of
`docs/sas/KF_Software_Architecture_Specification.md` is not started, and this is the first
deliverable inside it.

It also runs on the workstation's hardware, sharing its disk and its power. That is a real
limit on what it can evidence about availability, and it is stated here rather than discovered
later.
