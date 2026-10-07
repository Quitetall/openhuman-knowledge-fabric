---
schema: oh.war/atom/v1
adr_uuid: 303b3574-f670-5849-b616-af68fc73c9fe
local_alias: KF-ADR-0039
role: adr
jurisdiction: bound
order: 30
classification: public
status: proposed
decided: 2026-10-03
---

# ADR KF-0039: The first host is a VPS on a tailnet, its working store is SeaweedFS, and its durable copies are in Backblaze B2

- **Status:** proposed 2026-10-03. The owner chose each option below on 2026-10-03; this record
  writes those choices down and gives the reasons.
- **Decision owner:** technical authority
- **Scope:** where the first commissioned host runs, how people reach it, what holds the
  evidence bytes, and where the durable and off-site copies go
- **Builds on:** [ADR 0004](KF-ADR-0004-production-release.md) (the v1.0 criteria),
  [ADR 0017](KF-ADR-0017-storage-locations.md) (storage locations),
  [ADR 0028](KF-ADR-0028-the-retrieval-index-is-masked-not-copied.md) (the retrieval engine)
- **Carries:** Phase 9 (SAS §98); SAS §100.10 (no host commissioned) and §100.40 (the object-store
  images no longer exist)

## Context

The specification describes a private host without naming one. Hosts so far have been the build
workstation, which is not allowed to host because of the promotion boundary (SAS §86), and a VM
on that same workstation (`kf-host-1`). The VM is separate software but shares the hardware, and
it is up only when the workstation is.

Three facts forced decisions now:

1. **The object store went away.** Every compose file, provisioning script and fixture names
   MinIO. MinIO's community edition stopped shipping binaries and images in October 2025 and was
   archived in April 2026. On 2026-09-11 its images were deleted from Docker Hub, and the
   download site now answers 410. CI survives by building the pinned releases from source
   (`tests/fixtures/minio-image/`). A clean machine cannot start the dev stack, and a host would
   be running storage nobody patches.
2. **KF depends on object versioning.** Every bucket has versioning turned on ("the evidence
   vault"; `docker-compose.yml`). The artifact store reads and records each object's S3 version
   id (`content.artifact_location.store_version`, `packages/artifacts/src/store.ts`). A store
   without versioning would weaken what an evidence location guarantees.
3. **The specification's access model costs every person a configured device.** That model is
   an internal name, a private certificate authority and nginx terminating TLS (SAS §85–§91,
   `docs/deployment/private-host.md`). Each person's devices must trust a CA KF runs, which is
   the friction ADR 0024 warns about, for a handful of people.

## Decision

1. **The first host is a rented full-virtualisation VPS**, not the workstation and not a VM on
   it. The size is about 4 vCPU and 8 GB (for example, a Hetzner CPX31 running Debian 13). It must
   be KVM or equivalent, because bubblewrap needs real user, mount and PID namespaces (§85.5).
   Container-style VPS plans that refuse them are excluded by the host preflight, as now.
   `kf-host-1` remains a rehearsal host.

2. **People reach it over a Tailscale tailnet, and nothing is published.**
   - The host's name is its tailnet name (`<host>.<tailnet>.ts.net`).
   - Its TLS certificate is issued for that name by `tailscale cert`. That is a publicly trusted
     certificate for a name only the tailnet resolves, so no device has to trust a private CA.
   - nginx still terminates TLS, the API still listens on loopback, and
     `KF_TLS_TERMINATED_UPSTREAM=1` and the `reverse_proxy_posture` check are unchanged. Only
     where the certificate comes from, and which interface nginx binds, change: the tailnet
     interface, never a public address.
   - The host firewall admits nothing from the public interface except the tailnet's own
     transport.
   - Keycloak remains the identity provider. The tailnet decides who can reach the host, and
     Keycloak decides who someone is; neither stands in for the other.

3. **The working store is SeaweedFS**, run on the host as the `kf-objects` service, with S3
   versioning on for every bucket KF uses.
   - It is maintained (Apache-2.0).
   - It implements versioning and object lock, which keeps KF's versioned, write-once evidence.
   - It replaces MinIO everywhere: development, fixtures, provisioning, CI and the host.
   - KF's S3 client is unchanged; only the services that provide S3 change.

4. **Durable copies and off-site backups go to Backblaze B2.**
   - B2 is separate hardware run by someone else, which is what "off-site" and "durable" mean
     here.
   - It supports S3 versioning and object lock.
   - The durable artifact copy is a `durable` store in the registry (ADR 0017), bound to its B2
     address like any other.
   - The encrypted backup goes to a B2 bucket with object lock. The off-site step reads the copy
     back at the destination and records its digest (SAS §88), and the monthly drill pulls back
     that same object.
   - Only ciphertext and versioned evidence leave the host. The B2 application key lives in the
     owner's secrets store and reaches the host only as a 0600 credential file.

5. **Semantic search runs on the host's CPU from the start.** The LAMU retrieval engine
   (`lamu kf-retrieval serve`) is pinned to the LAMU commit that carries it on main. The bge-m3
   embedder runs locally on the CPU, with its identity pinned, and nothing is sent off the host
   (KF-SAS-RQ-218). Ingest is slower than on the workstation's GPU; search quality is the same.

6. **What stays the same:**
   - The release is built once, on the workstation, and promoted byte-for-byte (§86).
   - `provision-host.sh --check` lists what only a person can supply.
   - The host is done when `kf-commissioning` passes every check, and passes again after a
     reboot (§91).

## Options rejected

- **Hosting on the workstation, or on the VM on it.** It fails the promotion boundary, or shares
  its hardware and uptime with the machine being promoted from. It is kept as a rehearsal host.
- **Garage as the working store.** It is maintained and very light, but it has no S3 versioning:
  its `GetBucketVersioning` is a stub that always answers "not enabled". KF would have to give up
  versioned evidence or emulate it.
- **MinIO built from source.** It needs no code change, but MinIO is archived: nothing patches a
  service that holds the evidence.
- **B2 or another hosted S3 as the working store too.** It means less to run, but every document
  read would leave the host, and egress becomes a cost that grows with use.
- **WireGuard with a private CA.** It is what the specification describes and is fully
  self-run, but every person's devices must trust a CA KF runs.
- **Public HTTPS with Keycloak alone.** It is the simplest for users, but it puts the service on
  the public internet, which the specification forbids, for no gain at this scale.

## How we will know

- `docker compose up` on a clean machine starts the object store with no cached images, and the
  full suite passes against SeaweedFS. That includes the preservation tests that today build
  MinIO from source.
- The preservation and artifact-location tests prove versioning is in effect. A test fails if a
  bucket answers "not enabled".
- On the host, `kf-commissioning` passes every check, including `reverse_proxy_posture` against
  nginx bound to the tailnet interface, and passes again after a reboot.
- `kf-backup-offsite` verifies the copy at B2 by reading it back. The monthly drill restores the
  object it recorded, and a drill pointed at a deleted or altered object fails by name.
- A port scan of the host's public address shows nothing but the tailnet transport.

## Consequences

- MinIO leaves the codebase entirely: compose files, fixtures, provisioning, systemd units, CI
  and the from-source build kept for the preservation tests.
- The specification changes:
  - §85 gains SeaweedFS and Tailscale as host requirements;
  - §87 changes what `kf-objects` runs;
  - §88's off-site destination is an S3 bucket read back for verification, not only an `rsync`
    target;
  - the private-CA wording becomes the tailnet certificate;
  - §100.40 closes when the swap lands.
- KF now depends on two outside services, Tailscale and Backblaze. Losing the tailnet means
  losing access, not data: the host keeps running, and SSH through the provider's console remains
  a second way in, as `docs/deployment/dogfood-vm.md` requires of every host. Losing B2 means
  losing the off-site copies, not the working data.
- **The owner supplies:**
  - the VPS;
  - the Tailscale account, with the host and his devices joined;
  - the B2 buckets and application key;
  - the host's SSH access for the commissioning steps.
- Commissioning itself is Phase 9 and remains the owner's to authorize (KF-WAR-0001).
