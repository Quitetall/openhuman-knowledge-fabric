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

At initial measurement the Fabric held **14 objects, all fixtures**. The ingest dogfood has now
added real local records: current workstation counts are 17 `core.object` rows, 7 artifacts, 7
artifact versions, and 1 external locator. The dogfood corpus is still deliberately small and
non-PHI; it proves the write path, not relevance completeness.

`register_external_artifact` and the ingest policy exist (ADR 0012). `kf ingest` now drives both
that reference action and `attach_evidence` copy action. `apps/api/src/ingest/plan.ts` remains a
pure planner — no database, no filesystem — so its refusals happen before any side effect and
are tested and falsified.

**Written down:** ADR 0012, the planner and CLI module contracts, and
[`handoff-ingest-cli.md`](handoff-ingest-cli.md) — payload contracts, identity modes, manifest
shape, acceptance criteria, and traps.
**Blocked on:** nothing for local ingest. A safe dogfood batch still needs an operator-selected,
non-PHI corpus and the usual authority clearance.

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

The three human acts that used to stand between that refusal and a session — link the subject to
a person, assign a role, grant a clearance — are now one command, `pnpm kf:grant-authority`. It
records a real `grant_person_clearance` action and extends the audit chain, because
`org.person_clearance.granted_by_action` requires a recorded act and no action type named this
one until 2026-08-27.

Run against the workstation database, it moved `GET /master-record` from `401 unknown_subject` to
`404 master_record_not_found` — identity resolved, clearance held, request reaching a domain
answer rather than an authority refusal.

This step is no longer the hinge. **Step 2 is.**

**Written down:** `docs/deployment/identity-and-login.md`, walked, with what walking found that
reading would not have.
**Blocked on:** nothing. What remains is compiling a record (step 4) and the browser round trip.

### 4 · The button — small, once 2 and 3 land

`GET /master-record` already exposes the authenticated person's latest claim, permission digest,
stale status, items and withholding ledger. `renderMasterRecord` projects one compilation to
Markdown or HTML, with PDF and DOCX derived through pinned pandoc.

The runtime does the work. The button is thin.

Compilation has now been driven end to end through an authenticated session — `POST
/master-record/compile` returned `201` with an audit digest, and `GET /master-record` returned the
compiled claim. The recompilation defect found below is **fixed by ADR 0013** (2026-09-01): a
master record's identity is its corpus, an unchanged corpus compiles to the same record, and
sections are derived from the current relation graph on every read rather than stored.

Every reading of the record — sections, pages, exports, an agent's context — is now a
**declared projection** over the corpus (ADR 0014): `ontology/projections.yaml`, one engine in
`@kf/projections`, one canonical Result per reading, served by
`GET /master-record/projections/:definitionId` in JSON, Markdown or HTML with one projection
digest across all three.

Every first-class object now has a page with no per-type code: `GET /objects/:id` and
`apps/web/src/app/objects/[id]` render the `object_view` projection — the record, everything
that links to or from it, actions from its state, and its audit history (ADR 0015).

**Written down:** ADR 0011, "Runtime surfaces"; ADR 0013 for identity; ADR 0014 for projections;
ADR 0015 for Object Views.
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

## The one measurement that would change the most — RUN 2026-08-28, and it did

This section used to say: ingest real material, and if `your_record` stops being a single
self-reference, relevance works. **That test cannot fire, and the reason matters more than the
result.**

It was run properly for the first time on 2026-08-28: a record compiled through a real
authenticated OIDC session (`POST /master-record/compile` → `201`), against a database holding
real ingested artifacts rather than only fixtures. The result was **18 items, 17 `org_view`, 1
`your_record` — still just the person's own node.**

**`core.relation` is empty. Zero edges, in the whole fabric.** Relevance is a graph closure that
starts at the person and walks `core.relation`; with no edges it cannot reach anything, so one
item is arithmetically correct and would stay correct after ingesting a thousand files. Ingest
creates artifacts and creates no relations. `registry.relation_type` declares **23 types with
`person_anchor`**, each with a propagation class and depth — a careful policy with no input.

Exactly **one production path writes `core.relation`**:
`packages/work-control/src/internal/decision-materializers.ts`. Every other writer in the tree is
a test.

So the real gap under "one button to your master record" is not the corpus and not the closure —
it is that **nothing anchors records to people**. Until something does, every person's master
record is the org view plus themselves.

### And the experiment found a defect

Inserting one `performed_by` edge (artifact → person, the direction
`authority_one_hop_up` actually follows) and recompiling returns **`500 internal_error`**:

```
duplicate key value violates unique constraint
  "master_record_person_id_organization_id_permission_digest_key"
```

`content.master_record` is `unique (person_id, organization_id, permission_digest)` — one record
per person per **permission set**. But a record's content also depends on the relevance closure,
which is not in that digest. So a change that alters what is in `your_record` without altering
what the person may see **cannot be recompiled at all**, and the failure surfaces as an
unexplained 500.

The worse half is quieter: `stale` is computed only by comparing the stored manifest's permission
set against the current one, so `GET /master-record` went on returning the old sectioning with
**`stale: false`** — reporting the record current while a relevance change sat unrepresentable
behind it.

Confirmed by the data: the two compilations on this workstation carry **different** permission
digests (the ingest grew the permitted set), which is why the first succeeded. The second changed
only relevance, reused the digest, and collided.

No test covered this: every existing test compiled for a different person, or once per person.
That is how it survived 1396 passing tests. The experiment edge was removed afterwards — a false
`performed_by` claim must not stay in a records system.

**Resolved 2026-09-01 by ADR 0013.** The key is now `(person, organization, corpus_digest)`; an
unchanged corpus replays the existing record; sections are derived at read time, so the edge
above now moves the artifact into `your_record` against the same claim with no recompilation;
and the database CHECKs both digests against the manifest. Pinned by
`tests/database/master-record-recompilation.test.ts`.

## Where to go next

|                             |                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| From a clone to running     | [`docs/onboarding.md`](onboarding.md)                                                     |
| The master-record design    | [`docs/decisions/0011-master-record-runtime.md`](decisions/0011-master-record-runtime.md) |
| How files enter             | [`docs/decisions/0012-file-ingestion.md`](decisions/0012-file-ingestion.md)               |
| The next task, specified    | [`docs/handoff-ingest-cli.md`](handoff-ingest-cli.md)                                     |
| Standing a host up          | [`docs/deployment/private-host.md`](deployment/private-host.md)                           |
| The authority for all of it | `/mnt/4tb/OpenWarrant`, branch `warrants/master-record`, `OW-WAR-0054`                    |
