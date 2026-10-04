# Loaded-system-manager commissioning

`systemd_loaded_units` is mandatory in the ordinary commissioning registry.
It reads the local system manager, not a remote manager or an environment-
selected executable. Installed file agreement alone cannot satisfy it.

The collector invokes `/usr/bin/systemctl --system` with a minimal environment,
five-second command timeouts, a twenty-second aggregate command deadline and
four-MiB output caps. Scope is at most 32 load paths and 256 unit observations;
directory enumeration refuses beyond 16,384 entries per load path. Filesystem
I/O is not cancellable: the command deadline is not a wall-time guarantee for a
stalled mount. Errors return `unverifiable` without printing command output.
No command lines, environment assignments or credential values are collected.
Refusal details identify reviewed template bases and failed property names,
not arbitrary template-instance identifiers, which may contain caller data.

## Concrete units and templates

Every shipped concrete service must be observed. Literal templates cannot be
queried as instances. Each shipped template is inspected through an inactive
`@kf-commissioning-probe.service` instance, plus all matching instances found
in the manager's `list-units --all` and all configured instance bases/drop-in
directories across its `UnitPath`. This includes inactive configured instances.
The collector loads introspection metadata; it never starts a service, reloads
the manager or resets failures. This is not activation proof. The behavior
follows the selected host's [systemd 257 machine interface](https://raw.githubusercontent.com/systemd/systemd/v257/man/systemctl.xml).

The decision requires complete, unique, scoped records. It compares `Id`,
`Names`, `LoadState`, `FragmentPath`, `DropInPaths`, `NeedDaemonReload`,
`Transient`, `User`, `Group`, `DynamicUser`, `OnFailure`, and explicitly declared
`NoNewPrivileges`, `MemorySwapMax`, `LimitCORE` and `LimitCORESoft`. The last
two are checked separately. The declared installed directory must belong to
the manager's load paths. Foreign fragments, aliases, transient units, pending
reloads and selected overrides not matching the reviewed composition refuse.

Instance composition uses the reviewed template base and the instance's actual
drop-in hierarchy. Arbitrary instance overrides are not approved just because
their loaded values match. The exact native-binding catalog remains the one
defined by [unit-file composition](commissioning-unit-composition.md).
`%n` is expanded only in alert targets. Other identity/alert specifiers and
unrecognized boolean declarations refuse rather than being guessed.

## Limits and tests

`CommissioningInputs.systemdObservation` is a library-only dependency seam for
controlled tests. The CLI exposes no fixture, snapshot-file, executable or bus
selector. An injected snapshot is not host evidence. Supplementary battery
paths and exact hashes are guarded by the qualification-reference test.

A satisfied result is **not startup or reboot evidence**. It does not inspect
process credentials, binary identity, credential-generation custody, every
possible systemd directive or effective properties on an already-running
process. Numeric UID aliases, NSS identity equivalence and filesystem changes
after observation remain outside its claim. Live service activation, failure
delivery, reboot recovery, independent backup recovery, local/institutional
qualification and human acceptance remain separate gates. This does not make
the old native secret-path heuristic sufficient or make KF 1.0 complete.
