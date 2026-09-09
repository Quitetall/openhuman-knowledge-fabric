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

1. **A second artifact store on an independent device**, declared in `content.artifact_store`,
   with the storage sweep replicating to it and re-verifying on a timer. Closes §100.4, which
   records that replication is scheduled nowhere.
2. **The remaining service units and timers installed and running**: worker, checkpoint, backup,
   backup-offsite, restore-drill, readiness, alert heartbeat. Each under its own unprivileged
   account, per the shipped units.
3. **A signed Merkle checkpoint produced on the host**, by a process the API cannot reach the key
   of, with that isolation evidenced on the host rather than asserted.
4. **A backup taken, copied off the working device, and verified at its destination**, then a
   restore drill run with the shipped scripts into a scratch database.
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
- **Nothing here is published to the public internet.** The instance is reachable on internal
  names only, with a private certificate authority.
- **A human-only act stays human.** Approving, allocating, accepting cutover: none of them are
  performed by this Warrant's execution.

## Autonomy tier

**T2.** Commissioning is an institutional act in its consequences even where each step is
mechanical: it produces the evidence that a later reader will treat as proof the system may hold
records. Stages that create credentials, format a device, or accept evidence escalate to a human.
