---
schema: oh.war/atom/v1
warrant_uuid: 01a084e1-5936-7bc3-bb49-777cdd4bb598
role: intent
jurisdiction: authored
order: 10
classification: internal
---


# Intent

Make the Knowledge Fabric serve records from a commissioned host, and produce the evidence that
says so — from that host, not from the machine that built the software.

## Why this is a Warrant and not a task list

Phase 9 is the only objective in the §98 ladder that no amount of engineering in this repository
can discharge. Nine phases were delivered by writing code and running gates. This one is
discharged by a machine existing, being configured against a contract, and being observed. ADR
0004 makes four of the five v1.0 criteria queue behind it. One of those carried a seven-day floor
that could not begin counting until the host existed; ADR 0032 has since waived the floor, and the
parity evidence it guarded is still owed.

## Which host

ADR 0039 (`docs/decisions/0039-the-first-host-is-a-vps-on-a-tailnet-with-seaweedfs-and-b2.md`,
proposed 2026-10-03, every option chosen by the owner) settles it: **a rented KVM VPS**, about 4
vCPU and 8 GB, Debian 13, reached only over a **Tailscale** tailnet with a certificate from
`tailscale cert`; **SeaweedFS** as the working store; **Backblaze B2** for durable artifact copies
and object-locked off-site backups; semantic search on the host's **CPU**, with the LAMU engine
pinned at `26923afb` and the bge-m3 embedder local. The VM on the workstation, `kf-host-1`, stays a
rehearsal host. This is milestone **M6** of `docs/ROADMAP.md`, after KF-WAR-0002 (M0) lands the
code it runs.

It is also the objective most likely to be quietly overclaimed. A host that answers a request has
proven it is running; whether it may hold records is a different question, and the deployment
contract says in its own words that service availability must never be treated as institutional
approval. This Warrant exists so the difference is recorded rather than assumed.

## What "commissioned" means here

Every control in `docs/deployment/private-host.md` exercised with evidence produced ON the host,
and `kf-commissioning` exiting zero with no check reading `unverifiable`. That program treats "we
could not look" as a failure, which is the whole reason it exists.

## What is deliberately NOT in scope

- **v1.0.** Phase 10 needs the parity window, an accepted cutover and a green run on the tagged
  commit. This Warrant stops at a commissioned host.
- **Admitting users.** Linking a subject to a person, assigning a role and granting a clearance
  are recorded acts, and they come after the host is commissioned rather than during.
- **The corpus.** Ingesting real records is Phase 9-adjacent work that does not gate the exit.
