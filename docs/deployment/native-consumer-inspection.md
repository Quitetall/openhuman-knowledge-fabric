# Current native consumer inspection

The [read-only command](../../scripts/deploy/inspect-native-consumers.mjs) complements
[source posture](application-consumer-binding.md#guard-preservation) and
[loaded-manager checks](commissioning-manager.md). Neither source files nor
loaded unit properties establish what a current main process can receive.

On the selected Linux host, from an authenticated, root-protected candidate or
installed release containing the matching native helper:

```sh
sudo env -i PATH=/usr/bin:/bin /usr/bin/node \
  /opt/kf/scripts/deploy/inspect-native-consumers.mjs api --json
```

Replace `api` with `worker`, `attestor`, `checkpoint`, `storage` or `readiness`.
Omit the role to inspect all six. An all-role result cannot pass while a required
observation is unavailable. This command does not start jobs to obtain evidence.
There is no command-line PID, helper, namespace, receipt or executable override.
Inspect the physical, verified release; an unprotected development checkout
refuses. The command is packaged by the existing release builder, not installed
separately as a privileged daemon or setuid executable.

## Observations and decisions

The collector reads only fixed manager properties, local account metadata,
kernel process metadata and credential metadata. It never reads process
environments, command lines or credential values. Manager commands are bounded
to five seconds each and a twenty-second command budget per role; filesystem
reads have byte bounds, not a hard whole-operation deadline.

The observation pins the mount namespace and filesystem root of the manager's
current `MainPID`. The existing C checker enters those handles without executing
any programs from the inspected namespace. It drops supplementary groups,
real/effective/saved IDs and capabilities, sets no-new-privileges, and applies
the existing read-only tmpfs, exact owner/mode, named UID ACL, regular-file,
single-link and purpose-specific size checks. Directory enumeration must match
the role's complete credential-name set: missing or extra entries refuse.
The ordinary unprivileged checker interface remains unchanged. Root remains
the trusted host custodian; this is not isolation from a hostile root operator.

The decision additionally requires:

- A current main PID and invocation ID, with active/running or activating/start
  state. A setup process observed before dropping root cannot pass.
- The dedicated non-root role UID, no local UID aliases, and the expected primary
  GID. The only declared nondefault group is `kf-attest` for the attestor.
- No active host swap, `memory.swap.max=0`, both core limits zero, zero effective,
  permitted and ambient capabilities, and no-new-privileges enabled.
- Unchanged manager identity, local identity files, PID start time, cgroup,
  process controls, namespace and root identity before and after inspection.

Only files-only passwd/group NSS is supported. External NSS, unavailable tools,
unsupported metadata, instability and missing processes are `unverifiable`.
Known observed failures are `unsatisfied`. Both fail. Diagnostics expose only
closed property labels and safe observed PID, invocation and numeric identity,
never supplied values or exception text.

The JSON schema label is `kf-native-consumer-posture/v1`, with scope
`current-main-process-metadata`. Exit codes are 0 for all selected checks
satisfied, 1 for an unsatisfied/unverifiable selected check, 2 for an unavailable
command context, and 64 for invalid arguments. `complete` means only that this
selected current inspection passed; it is not host commissioning or release
acceptance.

## Invocation and qualification limits

A wrapper's main process may pass while its application child has not used a
credential. This command does not prove content validity, source-generation
currency, application correctness, startup/restart/reboot, receipt authenticity,
provider access, authority grants or qualification. Collect those separately
against the exact promoted release.

An inactive completed oneshot has no current process to inspect and is therefore
unverifiable. Do not require its credential mount to persist, start a mutating
maintenance job just for inspection, or turn an old fixture result into a current
receipt. Its real invocation needs separately captured, authenticated evidence.
The existing host commissioning command is unchanged; this supplementary command
does not widen that gate's declared fault model or independent qualification.

## Verification

```sh
pnpm exec vitest run tests/deployment/native-consumer-inspection.test.ts \
  tests/deployment/peer-credentials-build.test.ts
```

The 48 inspection tests cover exact verdicts, malformed and incomplete metadata,
UID aliases, unsupported NSS, manager duplicates/omissions, kernel identity and
start-time parsing, narrow scope and diagnostic nondisclosure. Native builder
tests compare the minimal Linux syscall layouts to installed UAPI headers,
compile the static musl custody atom, and refuse unpinned inspection handles.

As root on a protected public candidate, run
`node scripts/deploy/test-native-consumer-inspection.mjs RELEASE`. It creates
attempt-owned transient services with public placeholders and `sleep` programs,
waits for the actual executable rather than PID 1's temporary root setup process,
and stops only those owned services. On the selected VM, 28 cases passed: six
roles plus a running oneshot; core, swap, new-privilege, extra/missing-credential
and wrong-identity/group refusals; and unverifiability after each stop.
Public fixture inputs and manager failure metadata remain available for audit.
The existing 48 native-reader and 16 fixed-consumer cases also passed with the
modified helper. These are real PID 1 fixtures, not production application use.

A separate read-only inspection of the unchanged selected deployment returned
exit 1: the old API/worker lacked the new swap/core and native-custody posture;
the four other roles lacked current observations. API, worker and web PID and
invocation IDs remained unchanged. No release, credential or unit was promoted.
