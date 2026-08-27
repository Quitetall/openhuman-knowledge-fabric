# The path to daily use

Six steps between "the engine works" and "a person clicks one button and gets their records".
This document exists so a successor does not have to reconstruct that path from commit messages.

Written 2026-08-27. Every number below was measured on that date, not remembered. Re-measure
before relying on any of them — several are host and database state and will move.

## Read this first, because it is not obvious

**The engine is far ahead of the product.** 79 migrations, 106 registered action types, 1350
passing tests, and a master-record runtime that compiles, sections, seals and delivers. What is
missing is almost entirely deployment and operations, not features.

**There is a working Knowledge Fabric on this workstation.** Database `kf`, 79 migrations, all
schemas present. It is where the master record was first compiled. It is **not** a commissioned
host and does not satisfy ADR 0004 criterion 3 — but it is a real substrate and most of steps 1
and 4 can be done against it.

**A dogfood VM existed and is gone.** Built 2026-08-26, unreachable 2026-08-27: its SSH key lived
in a session scratchpad that was cleared, `libguestfs` is not installed, and local `sudo` needs a
password, so the disk cannot be mounted to re-inject one. **It held no data — the `kf` database
was never created on it.** Rebuild it; do not excavate it.

**`OW-WAR-0054`, the Warrant authorising the master record, is in a different repository.**
`/mnt/4tb/OpenWarrant` — a **peer repo**, not a submodule of this one or of LamQuant. Branch
`warrants/master-record`, pushed. Its compiled single-file form — the whole design in one file —
is `/mnt/4tb/OpenWarrant/docs/warrants/OW-WAR-0054/generated/WAR.md`. Written absolute on
purpose: it is not in this tree, and `tests/deployment/docs-references.test.ts` correctly
refused it when it was written to look as though it were. An agent looking for the Warrant here
will not find it, and one already didn't.

**Do not re-raise the classification ceiling as an open question.** ADR 0008 is _superseded by
ADR 0011_, which is accepted and implemented: organization-scoped effective-dated person
clearance, an optional assignment ceiling, effective rank is the minimum of the two, requests may
narrow but never widen.

---

## The six steps

### 1 · A corpus — mostly unblocked

The Fabric holds **14 objects, all fixtures**. It is the sole source of nothing until real
material is in it.

`register_external_artifact` and the ingest policy exist (ADR 0012); the CLI that drives them
does not. `apps/api/src/ingest/plan.ts` is a pure planner — no database, no filesystem — so its
refusals are already tested and falsified.

**Written down:** ADR 0012, and the planner's own module comment.
**Blocked on:** nothing. Needs the CLI and files.

### 2 · A running service — blocked on a decision, not on work

Zero `kf-*` units are installed anywhere. The production `kf` database does not exist on any
host, and `/etc/kf/migrator/database-url` is 0 bytes.

**Written down:** `docs/deployment/private-host.md`, thoroughly — including six host
requirements each discovered only by running it somewhere new, and
`scripts/deploy/build-release.sh`, which is that document executable.
**Blocked on:** a human deciding to create the production database and migrator credential.

### 3 · A working login — **walked, and it completes**

OIDC against the local Keycloak now works end to end: `docker compose up -d keycloak` imports the
committed realm, `scripts/deploy/create-dev-user.sh` supplies the account that cannot be
committed, and an authorization-code + PKCE flow issues a token the API verifies. It carries
`knowledge-fabric-api` in `aud`, which is what `config.ts` checks.

It stops at one designed place. `GET /master-record` with that token returns
`401 unknown_subject` — "this identity is not linked to a person in this system". That is the
refusal working, not a fault.

What is left is three deliberate human acts, none yet performed: link the subject to a person
with `linkIdentity`, assign a role, grant a clearance. The link is "deliberately not automatic"
and has no CLI.

This step is no longer the hinge. **Step 2 is** — the remaining acts want a real person record
and a running service, not more identity plumbing.

**Written down:** `docs/deployment/identity-and-login.md`, walked, with what walking found that
reading would not have.
**Blocked on:** nothing but doing the three acts.

### 4 · The button — small, once 2 and 3 land

`GET /master-record` already exposes the authenticated person's latest claim, permission digest,
stale status, items and withholding ledger. `renderMasterRecord` projects one compilation to
Markdown or HTML, with PDF and DOCX derived through pinned pandoc.

The runtime does the work. The button is thin.

**Written down:** ADR 0011, "Runtime surfaces".
**Blocked on:** steps 2 and 3.

### 5 · Filesystem presence — deferred with a reason that expires

A watched folder first (drop a file, it becomes a registry item — a thin layer over step 1), then
WebDAV rather than FUSE: WebDAV maps onto the existing HTTP API and reaches Windows Explorer,
Finder and Linux without a kernel module.

The caution that decides whether this helps: **a mount that caches is a copy, and a copy outside
KF is a second source of truth.** Read-through with explicit expiry; writes through typed
actions, never raw file writes. A mount you can save into has reinvented a shared drive wearing
the Fabric's name.

**Written down:** `OW-WAR-0054`'s work order names `OW-WAR-0056` as the successor Warrant. That
Warrant is **not yet authored.**
**Blocked on:** the deferral reason — that a browsing surface over a record which is not provably
complete makes the wrong thing look finished. That expires when step 1 gives relevance something
to find.

### 6 · Turnkey — the least started, and a different kind of project

Today installation is a ~700-line runbook of hand-run steps. The measurable distance from
turnkey: **six host requirements have been found only by running the install somewhere new** —
pandoc, python3, the PostgreSQL 18 client, packaged dbmate, `/usr/bin/node` as a real executable,
bubblewrap. A runbook wrong six times in the same way is not nearly-turnkey; it is
under-specified in a way only fresh machines expose.

Company-wide also means onboarding and offboarding, key custody, and backup and restore actually
exercised. Much of that is built. **None of it has run on a live host.**

**Written down:** nothing.
**Blocked on:** doing 1–5 first, so the install is done correctly once by somebody who records
what actually hurt.

---

## The one measurement that would change the most

The compiled master record contains **1 item in `your_record`, and it is the person's own node**;
the other 13 are `org_view`. Every refusal path has zero rows — no withholdings, no entitlement
exclusions, no link revocations.

That is expected for a fixture database where the operator authored nothing. It is **also**
exactly what a broken relevance closure would produce, and the current data cannot tell the two
apart.

So step 1 is worth more than a corpus: ingesting real material and seeing whether `your_record`
stops being a single self-reference is the cheapest available test of whether relevance works at
all. Do that before building anything on top of it.

## Where to go next

|                             |                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| From a clone to running     | [`docs/onboarding.md`](onboarding.md)                                                     |
| The master-record design    | [`docs/decisions/0011-master-record-runtime.md`](decisions/0011-master-record-runtime.md) |
| How files enter             | [`docs/decisions/0012-file-ingestion.md`](decisions/0012-file-ingestion.md)               |
| Standing a host up          | [`docs/deployment/private-host.md`](deployment/private-host.md)                           |
| The authority for all of it | `/mnt/4tb/OpenWarrant`, branch `warrants/master-record`, `OW-WAR-0054`                    |
