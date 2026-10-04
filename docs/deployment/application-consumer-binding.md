# Native application consumer bindings

The optional [API](../../deploy/systemd/application-api-workstation-credentials.conf),
[worker](../../deploy/systemd/application-worker-workstation-credentials.conf),
[attestor](../../deploy/systemd/application-attestor-workstation-credentials.conf),
[checkpoint](../../deploy/systemd/application-checkpoint-workstation-credentials.conf),
[storage](../../deploy/systemd/application-storage-workstation-credentials.conf) and
[readiness](../../deploy/systemd/application-readiness-workstation-credentials.conf)
drop-ins bind the six [application delivery profiles](application-credential-delivery.md)
to existing programs. They are source templates, not installed startup or
commissioning evidence. Do not enable them until their public configuration,
credentials, role grants, sockets and matching release have been verified.

`scripts/deploy/application-consumer.mjs` derives the physical release from
itself, requires protected root-owned code, verifies the named OS identity
`kf-<role>`, admits exactly the role's native credential set, and invokes the
shared native checker before launching. It never reads credential values or
makes a service-owned secret projection. A swapped, core-enabled, ordinary-file,
wrong-role or extra-field context refuses instead of falling back.

`scripts/deploy/internal/application-consumer-plan.mjs` is the pure routing
atom: fixed programs/arguments, exact PID 1 runtime paths and closed public
settings. It does no filesystem work or process execution. Child environments
are constructed afresh; inline secrets, legacy paths, loader options and
unselected settings do not pass through. The fixed wrapper forwards termination
signals and the child's exit result. A refusal names no supplied value.

| Role       | Fixed program                                                                                                       | Native work directory     |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| api        | `apps/api/dist/server.js`                                                                                           | `/run/kf-api-work`        |
| worker     | `apps/worker/dist/main.js`                                                                                          | `/run/kf-worker-work`     |
| attestor   | `apps/attestor/dist/main.js`                                                                                        | `/run/kf-attestor-work`   |
| checkpoint | `apps/checkpoint/dist/main.js` with `--run`                                                                         | `/run/kf-checkpoint-work` |
| storage    | `apps/kf-storage/dist/main.js` with `--replicate --verify --older-than-days 30 --collect-orphans --grace-hours 168` | `/run/kf-storage-work`    |
| readiness  | `scripts/timer-liveness.sh`, then `packages/operations/dist/cli.js` only on success                                 | `/run/kf-readiness-work`  |

## Guard preservation

Drop-ins reset legacy environment files, secret paths and invocation lines,
not the base unit's identities, restart bounds, syscall filters, namespace
restrictions, capabilities or memory ceilings. Their public-only configuration
file is `/etc/kf/application-public/<role>.env`. There must be no secret or
loader instruction in that file; root protection and public-field review are
part of installation. `UnsetEnvironment` removes loader/shell injection
controls before the wrapper and pre-start guards execute. The wrapper then
selects only the declared public fields for its child.

Every binding sets `KF_SECRET_CUSTODY=systemd`, `ProcSubset=all`,
`MemorySwapMax=0`, `LimitCORE=0` and native `LoadCredential` paths.
The [native reader](native-credential-reader.md) still verifies actual process
memory protection and PID 1 mount/ACL metadata before reading.

API retains the projection-file and attestor-socket wait checks, loopback
listener, dogfood identity and upstream TLS declaration. Actual TLS termination
must be proved separately. Worker retains bwrap/prlimit, state-directory and
packaged Liminal runtime checks. It forwards the existing retrieval socket,
worker concurrency and all seven Liminal pins when selected; declaring
`liminal=none` does not enable a compiler. The existing vectors-only/local
engine preflight remains in the worker, not duplicated in this adapter.

API forwards the existing working/durable object routing, OIDC identity,
retrieval socket, public origins, effective-time policy, secure-object erasure
signer and pandoc settings. Checkpoint forwards its public signer identity,
trust directory and anchor routing; the existing signing/trust/anchor checks
still decide whether it may sign. Storage uses its declared service actor and
the existing authorized replication, verification and orphan sweep. No human
identity, authority or identifier is invented by the binding.

Attestor keeps `/run/kf-attestor` at `0710` for API socket traversal. Its work
directory must be `0700`. On the selected host, a measured pre-start chmod
returned `700` there, but the main command observed `710`: PID 1 reapplies
`RuntimeDirectoryMode` for each exec. Therefore the wrapper narrows only the
canonical, own-UID, tmpfs work directory from its expected `0710` to `0700`
inside the main process, before launching. It leaves the socket directory alone
and refuses every other unexpected mode. A pre-start chmod is not a substitute
for this check.

Readiness's ordered timer check runs under the same closed child environment.
Inherited `KF_TIMER_UNIT_DIR` or `KF_NOW_EPOCH` cannot redirect it. Any nonzero
timer result returns immediately; the database CLI never starts afterward.

## Verification and limits

```sh
pnpm exec vitest run tests/deployment/application-consumer-binding.test.ts
```

As root on a protected candidate with matching scripts and the packaged native
reader/helper, run `node scripts/deploy/test-application-consumers.mjs RELEASE`.
Its dedicated protected fixture tree puts public checking programs in the
fixed consumer slots. It exercises real service identities, PID 1 mounts,
exact paths, environment clearing, direct native reads, attestor permissions,
terminal cleanup and readiness ordering. Extra fields, wrong UID, swappable
cgroup and core-enabled contexts must refuse; a timer failure must prevent the
second command. It first refuses if any fixed runtime name is already in use,
and touches no installed consumer or provider. Public executable fixtures and
volatile input records are retained for audit, not presented as live startup.

This proves the binding and reader with fixture programs, not the real API,
worker, attestor, signer, storage or readiness application behavior against
deployed services. Source guards and pure tests cannot discharge actual unit
merge, effective identity/socket groups, encrypted-store handoff, real grants,
provider permissions, backup recovery, installed startup/reboot/rotation or
qualification. Those checks remain required before promotion and cutover.
