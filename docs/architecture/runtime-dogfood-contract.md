# Runtime dogfood and operational-completion contract

**Status:** implementation contract — candidate ADR identifier and acceptance remain human actions

**Applies to:** workstation development, shared dogfood and private-host deployment
**Does not:** approve R01, allocate an enterprise or ADR identifier, or resolve
`docs/decisions/0001-r01-schema-pack-defects.md`

## Authority boundary

Runtime readiness and institutional readiness are separate reports.

- **Service readiness** proves software and configured dependencies can perform their claimed
  functions. Shared dogfood requires this report to pass.
- **Institutional readiness** reports missing approvals, assignments, policies and qualified
  infrastructure. A failure blocks only the governed operation it protects; it is never
  converted into a warning or inferred approval.

Every measured check carries an explicit `service` or `institutional` scope. Current partition:

| Service checks  | Institutional checks                     |
| --------------- | ---------------------------------------- |
| schema release  | checkpoint coverage                      |
| write guards    | federated-reference verification         |
| audit chain     | approved physical-storage evidence       |
| outbox delivery | declared backup and restore objectives   |
| search index    | PITR policy and qualified infrastructure |

`assessReadiness` exposes both reports. Compatibility fields `ready` and `checks` mean only
`service.ready` and `service.checks`; they never combine incompatible verdicts. CLI text and JSON
show both reports, while default process exit status follows service readiness. Operators must
still inspect institutional blockers before attempting a governed operation. A check that cannot
run is `unknown` in its named partition and fails that partition closed.

`development` may use an explicitly enabled fixed identity. Every record produced through
that path is non-authoritative. `dogfood` requires verified OIDC identity, database-backed
role assignment and normal audit attribution even when processes run on one workstation.

## Deployment profiles

The application exposes two explicit profiles:

| Profile       | Identity                         | Intended use                      |
| ------------- | -------------------------------- | --------------------------------- |
| `development` | fixed identity may be enabled    | one-person, non-authoritative dev |
| `dogfood`     | OIDC bearer identity is required | shared workstation/private host   |

Workstation and private-host deployments use the same built application images and database
migrations. Host differences belong in configuration: secrets, TLS termination, persistent
volumes, backup destination, identity issuer and service scheduling. Promotion never means
copying a development database into an authoritative environment.

## First dogfood corpus

The three entries in `dogfood/document-constitution.json` enter as draft `fabric_native`
sources backed by immutable artifact versions. Their source directory is not a Git repository,
so labeling them Git-held would invent provenance. Existing document numbers are imported as
source metadata; loader allocates no new identifier. Dogfood may read, parse, compile, search
and create proposal overlays. It may not invent approval, effectivity, enterprise identifiers
or a Source Holder transfer.

Unchanged staging is atomic at each content-addressed object key: create only when absent, then
read and verify exact bytes. A conflicting occupied key is evidence failure, not an overwrite.
Migration-019 materializations are reusable only when named by its migrator-owned allowlist,
bound to one applied action and its recomputed audit link, backed by the exact pinned object
version, and (for document sources) accompanied by the action-created parse record. Modern
actions always use semantic dispatcher replay.

Shared dogfood requires browser proof for login, document browse, source/preview, proposal
creation, blocked approval boundaries, publication preview, metric visibility and access
denial. API-only tests do not satisfy the UI gate.

Pinned Liminal execution additionally requires Linux procfs and reviewed Bubblewrap. Production
accepts only a native Linux ELF artifact pinned by executable, ordered native runtime-closure,
and `Cargo.lock` digest. Verified executable bytes cross an anonymous descriptor pipe into a
read-only sandbox file and never occupy a same-identity writable host path. Missing procfs,
script artifacts, descriptor materialization failure, or digest mismatch makes compiler readiness
fail closed.

## Exit evidence

- clean migration and rollback rehearsal;
- service readiness passes under `dogfood` profile;
- institutional readiness names every remaining human/external gate;
- automated browser scenarios pass with Keycloak users and real role assignments;
- backup and restore drill produces verifiable evidence;
- same application artifacts start under documented private-host configuration.
