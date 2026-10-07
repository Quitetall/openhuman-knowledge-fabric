---
schema: oh.war/atom/v1
warrant_uuid: 01a084e1-5936-7bc3-bb49-777cdd4bb598
role: work_order
jurisdiction: authored
order: 40
classification: internal
---


# Work order

## Deliverables

0. **The VPS, provisioned against ADR 0039**, from a release built after KF-WAR-0002 lands:
   preflight passing on the VPS's own image; joined to the tailnet with nginx bound to the tailnet
   interface and the certificate from `tailscale cert`; the host firewall admitting nothing from
   the public interface but the tailnet transport; `kf-objects` (SeaweedFS) running with
   versioning enabled on every bucket; the LAMU engine at `26923afb` and the bge-m3 embedder on the
   CPU; `scripts/deploy/provision-host.sh` with `--check` listing nothing left for a person to supply.
1. **A durable artifact store in B2**, declared in `content.artifact_store` with role `durable`
   and bound to its bucket, with the storage sweep replicating to it and re-verifying on a timer.
   Closes §100.4, which records that replication is scheduled nowhere.
2. **The remaining service units and timers installed and running**: attestor, worker,
   checkpoint, backup, backup-offsite, audit-verify, storage, restore-drill, readiness, alert
   heartbeat. Each under its own unprivileged account, per the shipped units.
3. **A signed Merkle checkpoint produced on the host**, by a process the API cannot reach the key
   of, with that isolation evidenced on the host rather than asserted.
4. **A backup taken, its encrypted archive copied to the object-locked B2 bucket, and verified
   at its destination by reading the recorded version back**, then a restore drill run with the shipped scripts as `kf-drill`: it pulls the
   off-site ciphertext back, checks it against the digest recorded when it was sent, decrypts it,
   and restores it into a throwaway PostgreSQL cluster it deletes afterwards.
5. **`kf-commissioning` exiting zero**, with no check reading `unverifiable`, captured as JSON
   into the evidence directory.
6. **A reboot, and preflight re-run afterwards.** A service that works only in the install shell
   is not deployed.
7. **An enumeration of every control no automated check covers**, written down rather than left
   to be discovered.

## Constraints

- **No PHI, ever.** Not in the corpus, not in a backup, not in a test fixture.
- **Bank details, tax identifiers and payroll secrets are never stored.**
- **The host does not build.** The release is promoted byte-for-byte; a rebuild under `/opt/kf`
  voids the control that makes this host meaningful.
- **Secrets are files, 0600, owned by the account that reads them.** The secret reader refuses
  anything group-readable, which is a property to preserve rather than work around.
- **Nothing here is published to the public internet.** The instance is reachable only on its
  tailnet name, with a certificate from `tailscale cert` (ADR 0039). This read "internal names
  only, with a private certificate authority" until ADR 0039 replaced the private CA.
- **Only ciphertext and versioned evidence leave the host.** The B2 application keys reach it only
  as 0600 credential files from the owner's secrets store.
- **A human-only act stays human.** Approving, allocating, accepting cutover: none of them are
  performed by this Warrant's execution.

## Autonomy tier

**T2.** Commissioning is an institutional act in its consequences even where each step is
mechanical: it produces the evidence that a later reader will treat as proof the system may hold
records. Stages that create credentials, format a device, or accept evidence escalate to a human.

## Owner-only

- Rent the VPS, create the Tailscale account and join the host and his devices, create the B2
  buckets (one durable, one object-locked for backups) and their application keys, and give the
  host SSH access for commissioning (ADR 0039, "The owner supplies").
- Confirm receipt of a real alert, and complete a real login (RR-003).
- Authorize this Warrant (`war sign KF-WAR-0001`) and resolve it.

## Depends on

KF-WAR-0002 (M0). Deliverable 0 cannot start before the code it installs is on `main`.
