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

- **SAS `0.1.0-draft.8`**, the accepted revision, with `0.1.0-draft.9` proposed. §98 Phase 9 is
  the objective; the §106 requirements this Warrant implements are named in its manifest. This
  atom first cited `0.1.0-draft.3`, the revision accepted when the Warrant was drafted; a Warrant
  keeps the basis its authorization records, and this one is not authorized yet.
- **ADR 0039**, `docs/decisions/0039-the-first-host-is-a-vps-on-a-tailnet-with-seaweedfs-and-b2.md`:
  which host, how it is reached, what holds the bytes, where the durable and off-site copies go.
- **`docs/deployment/private-host.md`** — the deployment contract, and the authoritative list of
  commissioning blockers. ADR 0039's Consequences change its §85, §87, §88 and private-CA wording;
  KF-WAR-0002 carries those changes into the SAS.
- **ADR 0004** — what v1.0 claims, and the five criteria. Criterion 3 is a commissioned host.
- **KF-WAR-0002** (M0) — lands SeaweedFS, the B2 off-site and durable store, tailnet TLS and the
  engine pin on `main`. This Warrant promotes a release built after it.

## The host ADR 0039 chose

| Part | Choice | Supplied by |
|---|---|---|
| Machine | rented KVM VPS, ~4 vCPU / 8 GB, Debian 13; container plans refused by preflight (§85.5) | the owner |
| Reach | Tailscale tailnet; host name `<host>.<tailnet>.ts.net`; certificate from `tailscale cert`; nginx terminates TLS bound to the tailnet interface; public interface admits only the tailnet transport | the owner (account, host and devices joined) |
| Working store | SeaweedFS as `kf-objects`, versioning on for every bucket | KF-WAR-0002 |
| Durable copies | a `durable` store in the registry bound to a B2 bucket (ADR 0017) | the owner (bucket, application key) |
| Off-site backup | encrypted archive to an object-locked B2 bucket, read back at the destination, version recorded | the owner (bucket, key); KF-WAR-0002 (code) |
| Semantic search | LAMU `kf-retrieval serve` pinned at `26923afb` (binary sha256 `c45c672ff498b6df36dbcff4829c4e480b2e79d2f084e37179f6959d6946e962`), bge-m3 on CPU, nothing sent off the host | KF-WAR-0002 |
| Identity | Keycloak, unchanged; the tailnet decides who can reach the host, Keycloak who someone is | the owner (realm users) |
| Access for commissioning | SSH to the host, plus the provider's console as the second way in | the owner |

## What the rehearsal host established, and is therefore not re-litigated here

Measured 2026-09-09 on `kf-host-1`, the VM on the workstation that ADR 0039 keeps as a rehearsal
host, four days after it was built and without intervention. Every row is a property the VPS must
show again on itself; none is evidence for it. The object store and TLS rows describe the
rehearsal host's MinIO and private CA, which ADR 0039 replaces with SeaweedFS and the tailnet
certificate.

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

**Whether a rented VPS behaves like the contract assumes.** It was first written as whether a VM on
the build workstation could produce commissioning evidence that meant anything; ADR 0039 answers
that by moving the host off the workstation, and the VM stays a rehearsal host. What replaces it:
whether the provider's virtualisation grants the user, mount and PID namespaces bubblewrap needs
(preflight checks it before anything else), whether the CPU embedder keeps ingest acceptable on 4
vCPU, and whether two outside services (Tailscale, Backblaze) fail in the ways ADR 0039 says:
losing the tailnet loses access, not data; losing B2 loses the off-site copies, not the working
data.

## Storage, and a correction

The durable copy needs a device that fails independently of the one holding the working store.
On the rehearsal host that was `/mnt/2tb`, a different physical disk from the NVMe the VM lives on;
it had been recorded as impossible on 2026-09-05 from reading `df` instead of `lsblk`, which was
**wrong**, and the correction stands as a record. On the VPS the question is answered differently:
the durable store is a B2 bucket, separate hardware run by someone else, bound in the registry like
any other store (ADR 0017), and holding only versioned evidence and ciphertext.
