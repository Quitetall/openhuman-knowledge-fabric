# KF Software Architecture Specification

## OpenHuman Knowledge Fabric: one coherent institutional record, where the database is the authority and every write is an attributable act

| Field | Value |
|---|---|
| Document class | Software Architecture Specification |
| Short name | KF SAS |
| Status | Draft for acceptance |
| Version | `0.1.0-draft.8` |
| Date | 2026-09-24 |
| Enterprise identifier | Unallocated — this file name is not an official Identifier Registry allocation (§94.5) |
| Program name | **OpenHuman Knowledge Fabric** |
| Record name | **Object** |
| Repository name | `openhuman-knowledge-fabric` |
| CLI binary | `kf` |
| Requirement prefix | `KF-SAS-RQ-<NNN>` (§106) |
| Phase prefix | `roadmap://KF-PHASE-<N>` (§98) |
| Licence | Apache-2.0 |
| Domain specification | `OH-DOC-000002-1-R01` — Knowledge Fabric Organizational Graph and Work Control Specification |
| Identifier registry | `OH-DOC-000001-3-R01`, transcribed at `registries/openhuman/` |
| Authority substrate | PostgreSQL 18 |
| Canonical portable representation | RFC 8785 canonical JSON |
| Content address | SHA-256 over exact bytes |
| Document class authority | OpenWarrant WAR SAS §6, §34, §101 |
| Generated artifact rule | the YAML sources under `ontology/` are canonical; everything under `generated/` is compiled and never hand-edited |

> **Normative summary.** The Knowledge Fabric is a records system that refuses writes it cannot
> attribute. Every controlled state change crosses one typed seam, in one transaction, as a
> recorded act with an actor, a role, a reason where one is required, and an entry in an
> append-only audit chain. Visibility, immutability and referential integrity are enforced by
> PostgreSQL constraints and row-level security rather than by application code, so a defect in
> the application cannot widen what a reader may see. One canonical authority owns each fact;
> everything else is a declared projection over it. Identity, once allocated, never changes
> meaning.

---

# Part I — Constitutional architecture

## 1. Purpose

An organisation's records are usually spread across systems that each believe they are
authoritative. A project tracker, a document store, a finance ledger, a quality system and a
version control repository all hold a version of the same fact, and none of them can say which
version is the record. When somebody asks "what is the state of this work", the answer is
assembled by hand, from several screens, by a person who knows which system to disbelieve.

The Knowledge Fabric exists to make that question answerable from one place without collapsing
the authorities that produce the answer. It holds:

- one coherent, machine-readable view of products, projects, work packages, contractor work
  orders, work execution, artifacts, decisions, configuration changes, requirements, risks,
  tests, acceptance, invoices, payments, controlled documents, people and provenance;
- while keeping project management, engineering configuration, contractor authorization,
  quality management and finance as **separate authorities linked by typed identities**.

The second half is the hard half. A system that unifies records by absorbing them destroys the
authority that made them trustworthy. This one links them and records where each came from.

**KF-SAS-RQ-001.** The Fabric SHALL present one coherent typed graph over records whose
authorities remain distinct, and SHALL record for every record which authority owns it.

## 2. Scope

This specification governs the software: its architecture, invariants, capabilities,
boundaries, interfaces, requirements, non-goals and correctness conditions. It is the contract
for the Knowledge Fabric **program**, and every Warrant written against this program traces to
a requirement identifier in §106.

In scope:

- the authority model — identity, roles, clearance, grants, and the acts that change them;
- the write path — the typed action dispatcher and everything it enforces;
- the storage authority — PostgreSQL schemas, policies, triggers and constraints;
- content — artifacts, versions, documents, atoms, and where their bytes live;
- the corpus and its projections — what a person may see and how a reading is declared;
- institutional acts — identifier allocation, Warrant registration, publication;
- interfaces — HTTP, command line, the schema pack, the preservation export, OIDC;
- operations — the platform contract, host requirements, services, backup and commissioning;
- governance of this document.

Out of scope, and owned elsewhere:

- **the domain model** — which object types exist, what edges connect them, what lifecycle each
  follows. That is `OH-DOC-000002-1-R01`, the Organizational Graph and Work Control
  Specification. This document specifies the software that implements it (§9.1);
- **the identifier registry** — namespaces, grammars, check digits and allocation rules. That is
  `OH-DOC-000001-3-R01`. One transcription of it lives at `registries/openhuman/`, and it is
  one deployment's policy, not part of the product (§9.2);
- **the work primitive** — how a bounded intervention is authorized, executed and resolved.
  That is the OpenWarrant program (§104.1).

## 3. What this document is, and what governs it

This is a Software Architecture Specification in the sense the OpenWarrant WAR SAS §6.2 defines:
it states what the software is and shall become, with stable requirement identifiers so that
Warrants can reference them.

Under WAR SAS §6.10 a SAS and a Warrant are the same class of artifact at two levels of
importance. Each is a controlled contract with an intent, a basis, deliverables, acceptance
obligations, gates and immutable revisions. They differ in scope and in what traces to them,
not in kind. A program has exactly one SAS. This is the Knowledge Fabric's.

Consequences that bind this file:

- **Accepted revisions are immutable** (§94.2). A revision records SHA-256 over this document's
  exact bytes; changing a byte after acceptance produces drift that `war check` reports, not a
  quiet correction.
- **Requirement identifiers are append-only** (§97.2). A §106 row may be added and may be
  retitled. It may never be removed or renumbered, because a Warrant that implemented it would
  then reference nothing.
- **Requirement status is derived, never asserted here** (§97.3). This document does not tick
  completion boxes. What is satisfied is computed from the Warrants and evidence that trace to
  each requirement.
- **This file is excluded from the repository's formatter** (`.prettierignore`), because a tool
  that silently rewrites the bytes of a digest-pinned normative document would make the digest a
  statement about the formatter rather than about the document.

## 4. Definitions

The terms below are used with exactly these meanings throughout.

| Term | Meaning |
|---|---|
| **Object** | A row in `core.object`: an identity, a type, a lifecycle state, an organization, a classification and a row version. Every governed record is one. |
| **Act** / **action** | One recorded, attributed state change. A row in `core.action`, produced by the dispatcher, referenced by everything it changed. |
| **Actor** | The person or service on whose behalf an act is recorded. Always a row in `org.person`. |
| **Acting role** | The role assignment under which an actor performed an act. Authority is held by role, never by person alone. |
| **Classification** | One of exactly four values — `public`, `internal`, `confidential`, `restricted` — ordered, and compared as a rank. |
| **Ceiling** | The highest classification a reader may see in a given context. Resolved at point of use, never accepted from the caller. |
| **Grant** | A recorded, effective-dated permission for a principal over a scope, with its own classification ceiling. |
| **Corpus** | The exact set of objects a person is authorized to see in an organization at a moment. The master record's identity. |
| **Projection** | A declared, versioned reading over a corpus. Sections, object views and agent context are all projections. |
| **Artifact** | A logical piece of content. Its bytes live in one or more versions. |
| **Artifact version** | An immutable statement that a specific set of bytes existed and was used, addressed by SHA-256. |
| **Location** | Where one version's bytes are held in one store, with a role and its own verification state. |
| **Source Holder** | The system that owns a record's bytes and their history. KF may hold a copy without becoming the Source Holder. |
| **Institutional authority** | The system that allocates official identity and records the organizational fact. KF is this for the OpenHuman instance. |
| **Refusal** | A named, typed failure. Refusals are a feature; an unnamed error is a defect. |
| **Human-only act** | An act no automation performs, listed in §22. |
| **Gate** | A registered check with an argv, a fault model and declared blind spots. |

## 5. Architectural thesis

**The authority is in PostgreSQL's C core. It is not in TypeScript, and it is not in Rust.**

This is the single decision from which most of the rest follows. Stated precisely:

TypeScript opens one transaction and dispatches into it. Within that transaction, what a reader
may see, what a writer may change, what may reference what, and what may never change again are
decided by row-level security policies, triggers, check constraints and foreign keys. The
application does not implement those rules a second time. It cannot relax them, and a defect in
it cannot widen them.

The shape of that authority is measured from the migrations in `database/migrations/` and stated
in [`generated/measurements.md`](../../generated/measurements.md) rather than here (§103.3): the
schemas, tables, row-level security policies, triggers, `SECURITY DEFINER` declarations,
foreign-key references, check constraints, indexes, views — none materialized — and group roles,
every one `NOLOGIN`. The file is derived from the checkout and the build fails when it drifts.

Against that, the TypeScript's job is orchestration, action dispatch and HTTP. The ratio is the
thesis. **Performance work in this system is database work**, and §40
records what that cost when it was first measured.

Three corollaries that the rest of this document depends on:

1. **A read is authorized by the same predicate that authorizes a write.** There is no
   application-side filter that a second code path could forget.
2. **An unbound context sees nothing.** `core.current_classification_rank()` defaults to `-1`,
   below `public`, so a connection that has not bound an access context reads an empty database
   rather than an unfiltered one.
3. **The application is not a second way in.** The HTTP surface permits nothing the dispatcher
   refuses, and `tests/permissions/api-actions.test.ts` asserts that against a real database.
   Since 2026-09-23 the application is not trusted to say who is acting either: the database
   binds the principal (§17) and checks every authority row against it (ADR 0033).

**KF-SAS-RQ-002.** Visibility, immutability and referential integrity SHALL be enforced in the
database, and the application layer SHALL NOT be the sole enforcement point for any of them.

**KF-SAS-RQ-003.** An access context that has not been bound SHALL read nothing, and the default
classification rank SHALL be below the lowest classification.

## 6. System hierarchy

The levels below are named kinds of object. Each is defined here so no reader has to infer one
from a diagram.

| Level | Object | What it is | Written by | Read by |
|---|---|---|---|---|
| **Program** | this SAS, at an accepted revision | the contract for the whole Knowledge Fabric: what it is and shall become, with stable requirement ids (§106) and phased objectives (§98) | a person or agent proposes; a human accepts (§94.2) | `war sas`, this document's readers |
| **Objective** | a §98 phase, `roadmap://KF-PHASE-<N>` | a stage with an Exit sentence, achieved when its exit condition is evidenced | this SAS | §98 |
| **Requirement** | a §106 row, `sas://KF-SAS-RQ-<NNN>` | one stable, append-only architectural requirement | this SAS | §97, §106 |
| **Decision** | an ADR in `docs/decisions/` | one recorded architectural decision, its measurement, its options and what it forecloses | a person or agent drafts; a human accepts | §96 |
| **Organization** | `org.organization` | the authority boundary every object belongs to | bootstrap and typed acts | Part II |
| **Object** | `core.object` | one governed record with identity, type, state, organization, classification and version | a materializer, inside an act | Parts II–VII |
| **Act** | `core.action` | one attributed state change over a set of targets | the dispatcher, and nothing else | Part III |
| **Audit event** | `core.audit_event` | one link in an append-only hash chain over acts | `appendAuditEvent`, once per act | §30 |
| **Artifact version** | `content.artifact_version` | immutable bytes with a digest | `attach_evidence` and its siblings | Part V |
| **Location** | `content.artifact_location` | where one version's bytes are, in one store, with a role | storage acts | §50 |
| **Master record** | `content.master_record` | one person's authorized corpus in one organization, compiled and sealed | `compile_master_record` | Part VI |
| **Projection result** | computed, not stored | one declared reading of a corpus | `@kf/projections` | §59 |

## 7. Design laws

These are the rules the system is built to, stated so that a change that breaks one is visible
as a change to the architecture rather than as a refactor.

### Law 1 — One canonical authority per fact

Every fact has exactly one owner. Where a fact originates elsewhere, KF holds governed metadata,
an immutable digest and a versioned locator, and records the external system as the authority.
A mirror is never presentable as the authoritative copy. `tests/integration/federation.test.ts`
asserts that KF cannot become a second authority for a federated record.

**KF-SAS-RQ-010.** Every record SHALL name its authority, and a mirrored record SHALL be
distinguishable from an authoritative one by a recorded field, not by convention.

### Law 2 — Every controlled write is an attributed act

There is no anonymous mutation. A commit cannot contain a controlled change without a matching
action row and audit event. The dispatcher is the only seam, and §25 states what that means
precisely.

**KF-SAS-RQ-011.** A controlled state change SHALL be recorded as an act naming its actor,
acting role and targets, in the same transaction that applies it.

### Law 3 — A refusal is a feature

Every refusal has a name. The dispatcher's refusal codes are a closed set (§28), each distinct so
that a caller can respond rather than only log. A system that fails with a generic error teaches its operators
to ignore failures.

**KF-SAS-RQ-012.** Every refusal the dispatcher makes SHALL carry one of the named failure codes
and a detail object, and SHALL NOT surface as an untyped error.

### Law 4 — Fail closed

A missing measurement is a failure, not a pass. An unbound context reads nothing. An unknown
action type is refused. An unclassified table fails the boundary check before compilation. A
gate with nothing to compare fails rather than reporting success.

**KF-SAS-RQ-013.** Where a check cannot be performed, the system SHALL refuse rather than
proceed, and a gate that compared nothing SHALL NOT report success.

### Law 5 — Identity never changes meaning

An enterprise identifier is opaque, carries a check digit, and is allocated exactly once. A
retired namespace stays permanently resolvable. An identifier is never reissued, and a
number skipped because it was already occupied stays skipped.

**KF-SAS-RQ-014.** An allocated identifier SHALL never be reissued or re-meant, and a retired
namespace SHALL remain resolvable.

### Law 6 — Retire by sequester, never delete

A superseded record stays as honest history. Unpublishing is a recorded verification failure,
not a delete. A revocation is an update naming the act that revoked, never a row removal. A
corrected record keeps the original and the correction.

**KF-SAS-RQ-015.** Withdrawal, supersession, revocation and unpublication SHALL be recorded
state changes, and SHALL NOT be implemented as deletion.

### Law 7 — Canonical before hashed

Everything digested is canonicalized first, by RFC 8785, and every digest is domain-separated by
a format tag. Two structures that mean the same thing hash the same; two that mean different
things cannot collide across domains.

**KF-SAS-RQ-016.** Every digest SHALL be computed over an RFC 8785 canonical form under a named
format tag, and the tag SHALL be part of the preimage.

### Law 8 — Generated artifacts are never hand-edited

the YAML sources under `ontology/` are canonical. Everything under `generated/` is compiled from it, and CI
regenerates and fails on any difference, because a hand-edited generated file is an ontology
change nobody reviewed. The same rule governs composed documents and the pack.

**KF-SAS-RQ-017.** A generated artifact SHALL be reproducible from its source, and a difference
between the committed artifact and a fresh build SHALL fail the build.

### Law 9 — Gaps are recorded, never marked

There is not one `TODO`, `FIXME`, `XXX` or `HACK` in this repository. A gap is recorded as an
ADR, as a pack `known_gaps` entry, as a checker warning with an identifier, or as a
`KNOWN_DRIFT` admission with a reason — somewhere a reader will find it and a gate can count it.
An inline marker is invisible to everything except the person already reading that line.

Held, not only observed: ESLint's `no-warning-comments` refuses the markers in code at error, and
`tests/conformance/no-inline-markers.test.ts` scans every file ESLint does not read — SQL, shell,
units, configuration, YAML — with a planted self-test. Markdown is exempt because it must be able
to name the markers to state this rule.

**KF-SAS-RQ-018.** A known gap SHALL be recorded in an enumerable place, and SHALL NOT be
recorded only as an inline source comment.

### Law 10 — Some acts are not the software's to perform

Approving a schema pack, allocating an identifier, accepting a document, transferring a Source
Holder, releasing a regulated model, accepting cutover: these are human acts. A change that
makes one of them automatic is a change to the authority model, not a convenience. §22 is the
full list and §21 is the mechanism that enforces part of it.

**KF-SAS-RQ-019.** The acts listed in §22 SHALL be performable only by a human actor, and the
system SHALL refuse them to a service actor by name.

## 8. Non-goals

Stated so that a reader does not have to infer them from silence, and so that a future proposal
to add one is recognisable as an architectural change.

**8.1 It is not a wiki.** There is no free-form page that anybody may edit. Content enters as an
artifact with a digest, is parsed into addressable atoms, and changes only through acts.

**8.2 It is not a document store.** Holding bytes is a means. The record is the typed object and
its provenance; the bytes are one attachment to it.

**8.3 It is not a replacement for the systems it links.** Not for a PLM, a QMS, a finance ledger
or version control. Law 1 forbids it becoming a second authority for a fact another system owns.

**8.4 It is not a replacement for OpenWarrant, Liminal, Katana or BLUT.** §104 states what each
of those owns and what KF does for it.

**8.5 It does not accept protected health information.** No PHI enters the Fabric in any form.
This is not a configuration setting; it is a boundary condition on what may be ingested.

**8.6 It does not store bank details, tax identifiers or payroll secrets.**

**8.7 It is not a general-purpose write API.** There is no `act()` tool, no generic write
endpoint, and no path that constructs an action type at runtime from caller input. Agents get
eight read tools and one rehearsal that runs inside a rollback-only transaction.

**8.8 It does not synchronise folders.** External sources are admitted one file at a time, as
decisions. A recursive sync would make the boundary depend on what somebody dropped in a folder,
which is not a control.

**8.9 It is not portable to arbitrary platforms.** §84 states the single platform contract.
Portability was traded for the ability to say precisely what a host must provide.

**8.10 Business logic is an application above the Fabric, not a part of it.** Decided 2026-09-04.
Invoicing arithmetic, stock movement, scheduling, order-to-cash, payroll: these are computed by
callers, and they reach the Fabric the same way every other writer does, through the dispatcher,
as attributed acts. The Fabric holds what happened and who authorised it. It does not decide
what a total should be.

This is stated positively rather than only as a non-goal because the negative form invites the
reading that such a capability is merely absent and could be added by anyone in a hurry. It is
absent by decision: an accounting engine inside the authority boundary would make the boundary
answerable for arithmetic, and the first defect in that arithmetic would be a defect in the
record rather than in an application over it.

**8.11 Datasets, transforms and lineage are NOT an application, and are not built.** Also decided
2026-09-04, and it points the other way from §8.10, which is why both are recorded together.

If the Fabric ever gains the ability to hold a dataset, derive another from it, and answer what
produced what, that capability belongs in the **core**, under the same act, audit, access and
provenance model as every other record — not in an application above it, and not on a side path
that reaches storage directly. The reason is Law 1: a derivation is a fact with an authority, and
a derived dataset whose provenance lives outside the act model would be a second authority for
its own history.

None of it is built today. `ml.run_lineage`, with its input, output and parent-model tables, is
the closest thing that exists and is the natural seed. This section exists so that a reader of
§8's non-goals does not conclude the direction is foreclosed, and so that a near-term choice does
not foreclose it by accident.

**KF-SAS-RQ-190.** Business logic SHALL be computed by callers and SHALL reach the Fabric only as
attributed acts through the dispatcher.

**KF-SAS-RQ-191.** If dataset, transform or lineage capability is built, it SHALL be a core
primitive governed by the same act, audit, access and provenance model as every other record, and
SHALL NOT reach storage outside that model.

## 8A. Friction, and why it is in this part of the document

§8 lists what the Fabric is not. This section says what it must not become, which is a system
people work around.

Every write here is an attributed act, and that is friction by design. Given only a web form, a
system built this way loses to a chat window every time, and then holds a well-governed record of
the small fraction of work somebody had the patience to enter. **A record that is expensive to
write is a record that is not written, and an authority nobody writes to is not an authority.**

So speed of capture and speed of retrieval are architectural requirements here, ranking with
correctness rather than sitting below it as product polish (ADR 0024). Three consequences follow.

**The friction is in the API contract, not in the experience.** Nothing in the act model requires
a person to see an idempotency key. One gesture may dispatch a fully formed act.

**Capture is cheap; governance is on promotion.** Recording that something happened is not an
institutional act and must not cost like one. An observation enters as an ordinary object in a
draft lifecycle state, attributed and audited from the first moment, and becomes a controlled
record only when somebody makes it so. Approval, effective state, identifiers and act grants
apply at promotion, which is rare — not at capture, which is constant. A draft is early, not
second class: same row-level security, same corpus membership, same audit.

**Several capture surfaces, one act model behind all of them.** An agent in natural language and
a chat integration are first class; a command line and a web form are conventionally useful and
included. Every one dispatches the same typed acts through the same seam. None gets a private
path to storage and none gets its own record shape, because a corpus with four shapes for one
kind of fact is the drift this system exists to prevent. §8.7's refusal of a general-purpose
write path is unaffected.

Retrieval carries equal weight. A record nobody reads back does not repay the cost of writing it.

The bars are stated in ADR 0024 as numbers, because "fast" cannot fail and therefore is not a
requirement. Three of the five — the act itself, finding prior work by text, and reading an object
view — are measured against a running stack by `scripts/latency-bars.mjs`, which writes dated
runs to [`generated/latency-bars.md`](../../generated/latency-bars.md) and judges each on its p95.
Recording an observation from intent to durable, which includes a person, and attaching evidence
are not measured, and every recorded run is a workstation run rather than a commissioned host's;
§100.18 records both.

The capture path exists (ADR 0034, proposed). An `observation` is captured by
`record_observation` — any live assignment in the organization, no act grant — and the server
forms what KF-SAS-RQ-200 says the actor never supplies: the acting assignment (the person's only
live one, or a refusal listing them; `20260925090000`), the idempotency key (gesture id and body
digest), the target. `POST /capture/observation`, `kf note` and the web capture form all dispatch
that one act, and `promote_observation`, which requires `act`, is the separate act RQ-202 asks for.

**KF-SAS-RQ-200.** Recording an observation SHALL be achievable without the actor supplying
authority, concurrency or idempotency detail, and the system SHALL form those on their behalf.

**KF-SAS-RQ-201.** Capture and retrieval latency SHALL be stated as measurable bars, measured,
and treated as architectural requirements rather than product quality.

**KF-SAS-RQ-202.** An observation SHALL be recordable as a draft object, attributed and audited
from the moment it is written, and promotion to a controlled record SHALL be a separate act.

**KF-SAS-RQ-203.** Every capture surface SHALL dispatch the same typed acts through the same
seam, and SHALL NOT define its own record shape or reach storage directly.

**KF-SAS-RQ-204.** An agent SHALL be able to form and dispatch an act on behalf of a named human,
with the act attributed to that human and the agent's participation recorded.

**KF-SAS-RQ-020.** The system SHALL NOT provide a generic authenticated write path that accepts
a caller-supplied action type outside the declared set.

**KF-SAS-RQ-021.** Ingestion SHALL admit external content one named item at a time, and SHALL
NOT provide recursive synchronisation of an external container.

## 8B. The three layers

Recorded here because a reader had to assemble this from ADRs 0002, 0010 and 0013 for the
compiler, §8.10 and KF-SAS-RQ-190 for business logic, ADR 0023 for the scope boundary, and a
README for the shape holding them together. Every piece was written down; the structure they form
was not, anywhere, with an identifier. That is the failure a specification exists to prevent, and
the predictable consequence arrived: the README's account outran this document on a structural
claim, because an unstated architecture leaves the informal description as the only description
and nothing gates it. [ADR 0030](../decisions/0030-three-layers.md).

**Layer 1 — the kernel.** PostgreSQL holds the rules. Row-level security, triggers, check
constraints and foreign keys decide what a caller may see and change; one dispatcher is the only
way to write. A defect anywhere above cannot widen what a reader sees, which is KF-SAS-RQ-002
stated as a property of the structure rather than of one mechanism.

**Layer 2 — the compiler.** Reads the kernel and writes nothing to it. Produces the master
record — exactly the set of records one person may see at one moment — and projections over it: a
page for a person, a context bundle for an agent, a view of one object and its neighbours. The
retrieval index sits inside this boundary (§64A), derived and never authoritative.

**Layer 3 — workflows.** Business rules, integrations, and every surface through which a person
or an agent reaches the Fabric: invoicing arithmetic, scheduling, CRM, the web application, the
command line, chat, agents. All dispatch the same acts through the same seam and none touches
storage directly. This is §8.10 stated positively rather than only as a non-goal.

**The vocabulary above is explanatory; the requirements below are not.** A later revision may
rewrite how these layers are described — the framing has already been refined more than once, and
will be again. The invariants have not moved, and §97.2 makes an appended identifier permanent, so
what is pinned is the part that should not move.

**KF-SAS-RQ-210.** The system SHALL be organised as a kernel that holds the rules, consumers that
read and project, and callers that reach records only through acts; and no layer above the kernel
SHALL be able to widen what a reader may see.

**KF-SAS-RQ-211.** A layer above the kernel SHALL write only as an attributed act through the
dispatcher, and SHALL NOT reach storage directly.

**KF-SAS-RQ-212.** Each layer SHALL read only what the layer below it authorised, and SHALL be
replaceable without change to the layers below it.

## 9. Relationship to the specifications this implements

### 9.1 `OH-DOC-000002-1-R01` — the domain specification

The Organizational Graph and Work Control Specification defines the domain: which object types
exist, which typed relations connect them, which lifecycles they follow, and which invariants
must hold. This software implements it. The specification document itself is not in this
repository; what is here is its machine-readable expression in `ontology/` and the compiled
schema pack built from it.

The relationship is versioned and gated, not informal. §78 states the preservation rule: every
type, edge, action and definition that R01 approved still exists, byte-identical, and every
addition beyond R01 is declared by name. An approved semantic cannot be redefined by an
extension, ever.

**KF-SAS-RQ-022.** The ontology SHALL preserve every approved R01 definition byte-identically,
and SHALL declare every addition beyond R01 by name.

### 9.2 `OH-DOC-000001-3-R01` — the identifier registry

The registry defines namespaces, grammars, check digits, lifecycle rules and allocation
procedure for enterprise identifiers. It is **one deployment's policy, not part of the
product**. `registries/openhuman/` is a transcription of the OpenHuman instance's registry, and
`KF_REGISTRY_DIR` selects a different one.

That boundary is **partly enforced and partly aspirational**, and §70.2 states exactly where it
holds and where it leaks rather than claiming a separation that has never been exercised.

### 9.3 The precedence order

Where this document and a specification it implements appear to disagree, the domain
specification governs the domain and this document governs the software. Where this document
describes behaviour the code does not have, the code is right and this document has drifted;
§94.6 says what to do about that.

## 10. Implementation basis

The choices below are architectural, in the sense that changing one is a change to this
specification rather than a change of dependency.

**10.1 PostgreSQL 18 is the authority.** Not a datastore behind an ORM. §5 states why. The
version is exact: the client tooling refuses a directory whose `psql`, `pg_dump`, `pg_dumpall`
and `pg_restore` do not all report PostgreSQL 18.

**10.2 TypeScript, strict, on Node.js.** One language for orchestration, one runtime, no
polyglot service mesh. Node `>=24.18.1 <25` as the real executable at `/usr/bin/node`.

**10.3 A pnpm workspace, built as a composed monolith.** Libraries under `packages/` and
executables under `apps/`, counted in [`generated/measurements.md`](../../generated/measurements.md).
The composition root is `@kf/orchestrator`. The
packages are authority boundaries in the same sense the schemas are: `@kf/database` is the only
package permitted to open a connection, `@kf/actions` is the only path for controlled writes,
`@kf/ui` holds no business rules.

**10.4 Workspace dependencies are copied, not symlinked.** `injectWorkspacePackages` is on, so a
package sees exactly what it declares.

**10.5 Testcontainers against a real PostgreSQL.** The database tests run against the real
engine, not a mock and not an in-memory substitute, because every rule this system relies on is
one the real engine enforces and a substitute would not.

**10.6 RFC 8785 canonical JSON for every digest and export.**

**10.7 Ed25519 for checkpoint signatures and pack approvals**, with the signing key held by a
separate process precisely so it is not reachable from the API.

**10.8 pandoc for document parsing, deliberately unpinned.** §52.3 records the measurement that
justifies not pinning it, and the trap that measurement exposed.

**KF-SAS-RQ-023.** Exactly one package SHALL be permitted to open a database connection, and
exactly one package SHALL provide the controlled write path.

## 11. Conformance language

**SHALL** states a requirement. **SHALL NOT** states a prohibition. **SHOULD** states a strong
recommendation whose exceptions must be recorded. **MAY** states an option.

A statement in the present indicative — "the dispatcher refuses an unknown action type" — is a
statement about the software as it stands at this revision, and is verifiable by reading the
cited code. Where the software does not yet do what a requirement states, the requirement stands
and §100 records the gap. The two are deliberately different registers, and §12 says how to tell
them apart.

## 12. How to read the state claims in this document

Every claim here is one of three kinds, and each is written so the kind is unambiguous:

1. **Present indicative with a citation** — this is true now, and the cited file makes it true.
   `packages/actions/src/internal/dispatcher.ts` is a claim you can check.
2. **SHALL** — this is a requirement of the architecture. It may or may not be met today. What
   is met is derived from the Warrants that trace to it (§97), never asserted here.
3. **An explicit statement of absence** — "no host has been commissioned", "cross-repository SAS
   resolution does not exist". These are claims too, and they are as load-bearing as the others.

A count is the most perishable kind of claim. This document states no source count and cites
[`generated/measurements.md`](../../generated/measurements.md), which is gated on drift; a runtime
count appears only where the runtime is the subject, with its date and host (§103.3).

---

# Part II — Identity, authority and access

## 13. Objects and identity

Every governed record is a row in `core.object`. The row carries the identity, the type, the
lifecycle state, the owning organization, the classification and a row version. The typed table
that holds the record's own fields references it.

ADR 0003 first stopped row-level security at `core.object`, on the reasoning that a typed row is
reachable only through its object. That held for the application's joins and not for a role
reading a typed table directly, so since 2026-08-16 the typed tables carry policies of their own
whose predicate is that the owning envelope is visible (`20260816000300`, `20260816000500`); the
tables still excluded are an exact set, each with a reason, asserted by
`tests/database/typed-table-visibility.test.ts`. The object remains the one place the two axes are
decided, and `tests/database/classification-predicate-equivalence.test.ts` asserts the predicate
has exactly one meaning however it is written.

Identity is a UUIDv7. The ordering property is used; the timestamp inside it is not treated as
an authoritative time. `effective_at` on the act is the time the event happened, which can
differ from the time it was recorded, and both are kept. Absent, it is the database clock at
dispatch, rounded up to the millisecond so an act never takes effect before the transaction that
recorded it began. A caller-supplied value is bounded at the HTTP surface — at most five minutes
ahead, and no further back than `KF_EFFECTIVE_AT_BACKDATE_DAYS` (default 30) unless the action type
is listed as backdatable — and refused otherwise as `effective_at_out_of_bounds`, because an
unbounded event time lets anyone date an approval before the review it depended on.

**KF-SAS-RQ-030.** Every governed record SHALL have exactly one `core.object` row carrying its
identity, type, lifecycle state, organization, classification and row version.

**KF-SAS-RQ-031.** The time an event occurred and the time it was recorded SHALL be separately
recorded, and the recorded time SHALL be assigned by the server.

## 14. Enterprise identifiers

An enterprise identifier is the name a record carries outside the system. It is opaque —
`OH-<NAMESPACE>-<NNNNNN>-<C>` — and the check character is a Damm digit, which detects every
single-digit error and every adjacent transposition.

Opacity is a design decision with a cost and a reason. A speaking identifier that encodes a
year, a project or a department is readable until the thing it encodes changes, at which point
either the identifier lies or the record has to be renumbered. Law 5 forbids both.

Allocation is an act, not a proposal, and §65 states the mechanism. The property that matters
here: **there is no field in which a caller can put a suggested identifier.** That is the
refusal by construction rather than by validation.

The registry has 21 namespaces after the 2026-09-02 pack revision added `WAR` and `CONF`.
`registries/openhuman/` holds the transcription: `namespaces.yaml`, `grammars.yaml`,
`damm.yaml`, `codes.yaml`, `lifecycle.yaml`, `rules.yaml`.

**KF-SAS-RQ-032.** An enterprise identifier SHALL be opaque and SHALL carry a check character
that detects single-character and adjacent-transposition errors.

**KF-SAS-RQ-033.** The request that allocates an identifier SHALL have no field in which a
caller can name, suggest or influence the identifier allocated.

## 15. Organizations, people and roles

`org.organization` is the authority boundary. Every object belongs to exactly one, and the
organization is part of every access context.

`org.person` is the actor. A person has a kind — `human` or `service` — and §21 states what that
distinction buys. External identities link to a person; a trigger enforces that only a human
person may carry one, because a service actor authenticates by holding a key on a host, not by
signing in.

**Authority is held by role, never by person.** Every act names both an actor and an acting role
assignment, and the dispatcher checks the assignment is live before anything else happens. The
check runs through `org.holds_role`, which is `SECURITY DEFINER`, so role ownership is
established independently of the reader ceiling that is bound later — an authority fact is not
itself a classified record.

**KF-SAS-RQ-034.** Every act SHALL name an acting role assignment, and the system SHALL verify
that assignment is live before applying any change.

**KF-SAS-RQ-035.** Only a human person SHALL carry an external authentication identity.

## 16. Classification

Four values, closed, ordered: `public`, `internal`, `confidential`, `restricted`. They are
compared as a rank, and the rank of an unbound context is `-1`.

The set is closed on purpose. A configurable classification lattice is a lattice somebody will
configure wrongly, and every policy in the database would have to be written against a shape
that can change under it.

**KF-SAS-RQ-036.** Classification SHALL be a closed, totally ordered set, and comparison SHALL
be by rank.

## 17. Clearance and the effective ceiling

The rule: **a caller may request a ceiling; the database decides what it gets.**

ADR 0008 recorded the defect that made this necessary. A caller whose token verified, whose
identity was linked, and who held a valid role could name any ceiling up to `restricted`, and
the database honoured it. The token proved who; nothing proved what they were cleared for.

ADR 0011 replaced it. Clearance is organization-scoped and effective-dated, resolved at point of
use by `org.resolve_effective_classification`, and the resolved value — never the requested one
— is what is bound into the row-level security context. A request may narrow; it can never
widen.

A role assignment may carry its own ceiling, and what that ceiling caps changed with
[ADR 0027](../decisions/0027-access-is-a-grant-on-every-read.md). ADR 0011 took the minimum of the
clearance and the assignment ceiling as the session's ceiling. ADR 0027 made **the session ceiling
the person's clearance**, and gave the assignment ceiling the meaning `org.effective_access_grant`
already gave it: the cap on the organization-wide read grant that the assignment is. Nothing
widens — a record above the assignment ceiling is still unreadable through that role unless
another grant reaches it — but the ceiling bound into the session is not lowered by it.
KF-SAS-RQ-038 said "the minimum of the clearance and any assignment ceiling", which is ADR 0011's
rule; it is clarified in place below to ADR 0027's, which is what the code does, and §100.28
records that the owner must confirm that reading.

**Since 2026-09-23 the database enforces this, not the application** ([ADR 0033](../decisions/0033-the-database-binds-the-principal.md)).
A red-team pass run as `kf_app` showed that every `kf.*` setting the policies read was the
application's to write: any tenant could be bound at `restricted` with nobody behind it. The
TypeScript seam was correct and was the only thing in the way.

- **The context is sealed** (`20260923000100`). Each `kf.*` setting is written with an HMAC over
  its name, value, backend and transaction start, under a key no role with write grants can read.
  A raw `set_config` is not refused; it is simply not believed, and reads as the unset context —
  no organization, rank `-1`, no actor. No function but the seal's own reads or writes a `kf.*`
  setting.
- **The application binds a principal, not an organization.** `core.bind_principal` takes a
  person, their role assignment, the organization and a requested ceiling; it checks the
  assignment is live and clamps the ceiling to the person's clearance. `core.set_access_context`
  then refuses the application anything but narrowing that ceiling in that organization — or
  `public` with no principal bound, the one level that is anyone's to read.
- **Administrator and service logins keep their credential as their authority** — the owner and
  migrator, the worker, readiness, backup, checkpoint — and a service login's actor must still
  hold the assignment it names.

`setResolvedAccessContext` in `@kf/database` is now a caller of `core.bind_principal`. A refusal
surfaces as `classification_not_granted`, `role_not_held`, or `not_attested` (§24).
`tests/database/principal-binding.test.ts` plants the forgeries the red team succeeded with.

**KF-SAS-RQ-037.** A caller-supplied classification ceiling SHALL be resolved against recorded
clearance before it is bound, and the resolved value SHALL be the one enforced.

**KF-SAS-RQ-038.** A clearance SHALL be organization-scoped and effective-dated; the session
ceiling SHALL be at most the person's live clearance, and an assignment ceiling SHALL cap the read
grant that assignment confers rather than the session.

**KF-SAS-RQ-233.** The transaction's access and actor context SHALL be written only by the
database's own binding functions, sealed so that a value written any other way reads as unset, and
readable only through accessors that verify the seal.

**KF-SAS-RQ-234.** Above `public`, an application session SHALL bind a reader only as a principal
whose organization and ceiling the database derives from a live role assignment and recorded
clearance, and SHALL thereafter be able only to narrow that ceiling in that organization.

## 18. Access is a grant

ADR 0016 replaced three overlapping mechanisms — role assignment, project membership and secure
object capability issue — with one primitive that all three now project into.

`org.access_grant` records a principal, a principal kind, a capability, a scope object, a
classification ceiling, a validity interval, who granted it, the act that granted it, what it
was delegated from, and its revocation. Overlapping live grants for the same principal, scope
and capability are refused by an exclusion constraint over the validity interval.

`org.effective_access_grant` is the view every reader and every writer consults, so a refusal
and an explanation cannot disagree.

The permitted set is the **intersection**: a record is in a person's corpus when row-level
security admits it *and* a live grant reaches it. The consequence is deliberate and was tested
for: a person with a valid clearance and no role has an **empty** corpus. Clearance says how
high; a grant says over what.

The three legacy tables could not become views. `org.role_assignment` is itself a `core.object`
and a foreign-key target from `ml.*`, so it stays a table and projects into the view.

Both sources that project into the view are bounded ([ADR 0036](../decisions/0036-delegation-is-one-level-and-assignments-expire.md),
proposed and implemented; `20260925153600`). Delegation goes one level deep: the database refuses a
role assignment whose `delegated_by` holds the role only by delegation, and an access grant whose
`delegated_from` is itself delegated, so "who can act" is answerable from two rows. And every new
role assignment and project membership ends within 366 days of its start; renewal is a new,
attributed assignment, so the review is the act. Rows made before the rule are grandfathered and
reported by readiness (`assignment_review_dates`) until renewed. The one exception is the
bootstrap write — an administrator session acting as the bootstrap identity
(`org.is_bootstrap_write()`) — and it is excepted from the end date only, never from the depth.

**KF-SAS-RQ-039.** Read authorization SHALL be the intersection of row-level visibility and live
grant coverage, and a principal with no grant SHALL have an empty corpus.

**KF-SAS-RQ-040.** Two live grants for the same principal, scope and capability SHALL NOT
overlap in time.

**KF-SAS-RQ-041.** The read path and the write path SHALL consult the same grant view.

**KF-SAS-RQ-246.** A delegated role assignment or access grant SHALL NOT be delegated again, and
every new role assignment and project membership SHALL end within 366 days of its start.

## 19. Explaining a denial

A denial that cannot be explained is indistinguishable from a bug, and it teaches people to ask
an administrator rather than to understand the model.

`explainAccess` returns the policy path: which grants were considered, which reached, and where
the chain ended. It is exposed at `GET /objects/:id/access?person=&capability=&action=` and it
answers "why can't this person see this" with the exclusion that caused it rather than with a
boolean. The path walks the same steps the permitted set applies, in the same order —
organization membership, the principal-kind bar (a service actor asking for `act` is denied by
`service_actor`, §21), clearance, classification, grant coverage, exclusions, holds — and, given
`action=`, the separation-of-duty rule for that action (§23). The caller must be able to see the
object; otherwise the answer is not found, so asking about a colleague reveals nothing the asker
could not already read.

**KF-SAS-RQ-042.** The system SHALL be able to explain any access decision as a path ending in
the specific grant, exclusion, principal-kind bar or separation-of-duty rule that determined it.

## 20. Institutional acts and the act capability

Not every action is equal. Some change what the organization asserts: authorize, approve, grant,
revoke, allocate, issue, publish, supersede, deprecate, annul, make-effective, resolve.

An action type may declare `requires: act` in the ontology, carried into
`registry.action_type.requires_capability`. Which do is `ontology/action-types.yaml`'s to say, and
how many there are in all is in [`generated/measurements.md`](../../generated/measurements.md);
this document counts neither (§103.3), having stated a figure for the first until `0.1.0-draft.8`
that the ontology had long outgrown. For those,
the dispatcher requires a live `act` grant reaching every target — or the organization — before
the act is applied, through `org.act_grant_reaches`, over the same view the read side uses.
A refusal is `act_not_granted`, surfaced as HTTP 403.

**The database asks the same question on the ledger row** (`20260924000100`). Once an action row
had to name the sealed principal (§17), a compromised API could still write one crediting its
principal with an act that principal had no authority to perform. The trigger
`action_requires_act_authority` on `core.action` refuses it, through the same
`org.act_grant_reaches`, over the row's own `target_ids`, as the invoker, so row-level security on
every grant source applies exactly as it did to the dispatcher a moment earlier. It is the same
decision taken twice, not a second implementation that could disagree. The dispatcher's check
still runs first, because its refusal carries a message a person can act on; the trigger is for a
caller that did not go through it. `tests/database/act-authority.test.ts` plants both refusals.

The check runs **after the targets are locked**, because a check against a target set that could
still change is a check against nothing.

Other actions remain role-only. The distinction is what makes "institutional act" a mechanised
category rather than a description.

**KF-SAS-RQ-043.** An institutional act SHALL require a live act grant reaching every target or
the organization, checked after targets are locked.

**KF-SAS-RQ-044.** Which actions are institutional SHALL be declared in the ontology and carried
into the database, not encoded in application control flow; the database consults that
declaration itself, and does not rely on the application to have done so.

**KF-SAS-RQ-238.** The database SHALL refuse a ledger row for an institutional act that no live
act grant covers, or whose actor is a service actor, using the same coverage function the
dispatcher uses.

## 21. Service actors

Scheduled work has to act as somebody. The alternatives are worse than the problem: a shared
human account destroys attribution, and a path around the dispatcher destroys everything.

ADR 0020 declares a service actor as a person of kind `service`, with an organization-scoped
role and a clearance ceiling, created by a recorded act. It authenticates by holding a
permission-checked key file on the host. It goes through the same dispatcher as everybody else.

And it is barred from institutional acts. Whatever grants reach it, the dispatcher refuses any
action declaring `requires: act` to an actor whose `person_kind` is `service`, by name and with
a message that says why, and since `20260924000100` the database refuses the ledger row as well
(§20). A service actor does routine work under authority somebody granted; it
never authorizes, approves, grants, allocates or resolves.

`person_kind` is a database column and deliberately **not** an ontology field, because `person`
is an R01-preserved type and adding a field to it would be redefining an approved semantic.

**KF-SAS-RQ-045.** Scheduled and automated work SHALL act as a declared service actor through
the same write path as a human, and SHALL NOT have a privileged path around it.

**KF-SAS-RQ-046.** A service actor SHALL be refused every institutional act, regardless of the
grants that reach it.

## 22. Human-only acts

No automation performs these. They are listed here because a list in one place is auditable and
a convention is not.

1. Approving and signing a schema pack.
2. Allocating an identifier.
3. Accepting a document, transferring a Source Holder, releasing a regulated model.
4. Accepting cutover.
5. Accepting an architecture decision record.
6. Resolving a schema-pack defect.
7. Approving restricted-data use.
8. Changing key custody or a provider allowlist.
9. Authorizing PHI admission — which, per §8.5, is a decision to refuse.
10. Accepting a revision of this specification (§94.2).

Two of these are mechanised today: the service-actor bar (§21) enforces the institutional-act
class in the database, and the pack-drift conformance test states in its own source that signing
is human-only and cannot be discharged by any automation in it. The rest are enforced by the
authority model and by review.

The link between this list and the action vocabulary is asserted rather than assumed:
`tests/conformance/human-only-acts.test.ts` maps every item to the action types that perform it,
or says why none does, exhaustively against this section, and requires every one of those action
types to declare `requires: act` — so each is refused to a service actor by the dispatcher and by
the database. Until `0.1.0-draft.8` one did not: `change_document_source_holder`, item 3's
transfer of a Source Holder, was role-only.

A change that makes one of them automatic is a change to the authority model, not a convenience.

## 23. Separation of duty

Some acts must not be performed by whoever performed the act they judge. The dispatcher enforces
a declared map: issuing an acceptance is separated from the work execution it accepts, accepting
a work package from the work package, approving an invoice from the invoice. A violation is
refused as `separation_of_duty`.

**KF-SAS-RQ-047.** Where an act judges the product of another act, the system SHALL refuse it to
the actor who performed the act being judged.

## 24. Identity at the edge

**The provider says who. The database says what.**

An OpenID Connect provider authenticates the person and issues a token. The token's audience is
checked. The subject is then looked up: an identity not linked to a person in this system is
refused as `unknown_subject`, which is the refusal working, not a fault. Everything after that
— which roles, which clearance, which grants, which acts — is answered by PostgreSQL.

**Presence is attested by a separate process** (`20260924001000`). PostgreSQL cannot verify an
RS256 token — pgcrypto has no RSA — so until then `core.bind_principal` believed any real person
the API named, and a fully compromised API could act as anyone with their real authority.
`apps/attestor` (`kf-attestor`) now verifies the bearer token exactly as the API did — issuer,
audience, RS256 only, expiry, keys over TLS — resolves the subject, and calls
`core.issue_attestation` under the `kf_attestor` login, which the API does not hold. The database
stores a digest of a random secret against the person, assignment, organization and ceiling,
expiring at the earlier of the token's own expiry and sixty seconds; the API carries the secret for
the request and presents it to every `core.bind_principal`. An application bind without a current
matching attestation is refused as `not_attested`, answered HTTP 401. Where a person named no
acting assignment — a capture gesture (§8A) — the API asks the attestor to derive it, and the
attestor, which has just verified that person's token, looks up their live assignments through
functions only its login may call (`20260925090000`): their only one, or a refusal listing them.
Both processes run from the same installed release under `/opt/kf`, so the protocol between them
is promoted as one artifact (§86).

The attestation is reusable within its life rather than consumed, and the reason is stated so it is
not mistaken for an oversight: a compromised API sees every token passing through it and can have a
fresh attestation issued for any of them until that token expires, so the replay window is the
token's lifetime either way. What the attestor closes is the step that mattered — the API can no
longer bind a person who has not presented a valid token to it within one token lifetime. That
lifetime is at most 300 s, and not merely by the shipped realm's default: commissioning's
`identity_provider_policy` check refuses a realm whose access-token lifespan, or any client's
`access.token.lifespan` override, exceeds `MAX_ACCESS_TOKEN_LIFESPAN_SECONDS`, because that
lifespan is the replay bound. The database still trusts the attestor's verification; an attacker
holding both processes is back to the earlier position, and threat model open item 6 records that.

**An attestor that cannot be asked is an outage, not a refusal.** When `kf-attestor`'s socket is
absent or refuses, when it does not answer within five seconds, or when it answers 5xx, every
bearer request is answered HTTP 503 `attestor_unavailable` and binds nobody. There is no
in-process fallback outside the `development` profile — a fallback would be the API attesting to
people itself, the separation this exists to keep — and a token the attestor did refuse is still
401. `apps/api/src/app.test.ts` and `tests/permissions/attestor.test.ts` plant both.

**An agent acts for a named human on a delegated token** ([ADR 0035](../decisions/0035-an-agent-acts-for-a-named-human.md),
proposed; `20260925100000`). The agent obtains a token by OAuth 2.0 token exchange whose `sub` is
the person and whose `azp` is the agent's client; because Keycloak 26.4 emits no `act` claim of
its own, the realm's mapper on the agent client stamps `act.client_id`, and the attestor requires
it to equal `azp`, one level deep. `core.issue_attestation` accepts only a client that is a live
row of `org.declared_agent` — written only over the owner credential, by `kf declare-agent` — and
refuses a declared agent's token that carries no `act`, so an agent whose mapper was removed
cannot pass as the person; either is `undeclared_agent`, HTTP 401. The bind seals the agent, and
a trigger writes `core.action.agent_participation` from the seal over whatever the application
supplied. The act stays the person's: actor, role, clearance and grants are theirs. An agent never
passes step-up: an exchanged token carries no `auth_time`, and step-up fails closed without one.
Commissioning limits token exchange to clients that stamp their own `act`. KF-SAS-RQ-204 is
implemented by this; §100.19 is closed.

A declaration is a row, not a chained act, and that is the owner's judgement recorded rather than
an oversight: declaring an agent targets no record and belongs to no organization, so there is
nothing for a ledger row to target. The row carries its own decider, reason, login and time;
rows are never deleted, and a withdrawal is the one change a row accepts. The canonical export
leaves declarations out, so they are re-declared after an import (§100.33).

The web boundary has two identity profiles and they never fall back into each other. A
`development` profile may explicitly enable a fixed non-authoritative identity. The `dogfood`
profile refuses that path entirely and requires verified OIDC identity plus a database-backed
role assignment; `KF_ALLOW_FIXED_IDENTITY=1` cannot enable it there. Locally, `pnpm dev:dogfood`
runs the `dogfood` profile — the attestor first, then the API and the web application, each on its
own database login — with no owner SQL typed by hand, once `pnpm dogfood:logins` has written those
logins' connection strings owner-only; so the profile that serves records is the one exercised in
development too.

**KF-SAS-RQ-048.** Authentication SHALL establish only the subject, and every authorization
question SHALL be answered from recorded state in the database.

**KF-SAS-RQ-049.** A deployment profile that permits fixed non-authoritative identity SHALL be
distinct from every profile that serves records, and SHALL NOT be reachable from one by
configuration.

**KF-SAS-RQ-235.** The database SHALL bind a person for the application's login only on a current
attestation, issued through a login the application does not hold by a separate process that
verified that person's token, and valid no longer than that token.

**KF-SAS-RQ-240.** Where the attesting process cannot be reached or cannot answer, a request
bearing a token SHALL be refused as unavailable and bind nobody, and outside a development profile
the application SHALL NOT attest a person itself as a fallback.

**KF-SAS-RQ-241.** Commissioning SHALL refuse an identity provider whose access-token lifetime,
realm-wide or for any client, exceeds the attestation replay bound.

---

# Part III — The write path

## 25. The dispatcher is the only write seam

Every controlled state change crosses one seam, in one transaction: authority resolves, targets
lock, preconditions run, typed writes apply, audit appends, and the outbox emits.

The property that makes it a seam rather than a convention: **a commit cannot contain a
controlled change without a matching action and audit record.** Not because the application is
careful, but because the typed writes happen inside the same transaction that inserts the act
and appends the audit event, and a failure anywhere rolls all of it back.

There is no second path. There is no generic write endpoint, no `act()` tool, no admin escape.
The one documented exception is bootstrap (§33), and it is an exception that still extends the
same audit chain with the same arithmetic.

**The database holds the seam too** (`20260925011000`). Until then the ledger and the chain agreed
with the sealed context, and the domain tables did not have to: `kf_app` held column updates on
CAPAs, nonconformities and controlled documents and inserts across work, engineering, product,
content and finance, each guarded only by an envelope-visible policy, so a compromised API with a
bound principal could rewrite a CAPA's root cause and nothing in the ledger would say anyone had.
Every table the application or the worker can write now carries two triggers: one refusing a row
written while the sealed context names no action, and one deferred to commit requiring that
action to be in `core.action`, performed by the sealed actor in the bound organization, and — for
an application session — recorded in the same transaction, so an old act cannot license new
writes. A service session may complete an act already recorded, as the document compiler does
from the outbox. Tables exempt from the guard are declared, each with its reason, in
`core.write_guard_exemption`. `tests/database/write-guards.test.ts` plants the writes.

**KF-SAS-RQ-050.** All controlled writes SHALL pass through one dispatcher, in one transaction
per act, and no other path SHALL be able to apply a controlled change.

**KF-SAS-RQ-242.** The database SHALL refuse a row written by the application or a service login
to a governed table unless that row belongs to an act recorded in the ledger by the sealed actor —
for the application, in the same transaction — and the tables exempt from that rule SHALL be
declared, each with its reason.

## 26. The action lifecycle

`createTransactionalDispatcher` runs these steps in this order. The order is load-bearing and
each step is named here because a reordering is an authority change; a capture of the statements
one dispatch issues pins it as positions (`packages/actions/src/dispatcher-order.test.ts`), so a
reordering fails a test rather than a review.

1. **The action type is available.** A dispatcher-level allowlist, refused as `unknown_action`.
   Registry presence does not prove the owning module was loaded into this process.
2. **The effective time is canonical.** A non-canonical RFC 3339 millisecond instant is refused
   rather than normalised, because normalising a time silently is deciding what somebody meant.
3. **The request is digested** into a semantic digest (§29).
4. **The idempotency key is locked** with a transaction-scoped advisory lock, so equivalent
   retries serialize before either can materialize anything.
5. **The definition is loaded** from `registry.action_type` and `registry.state_transition`.
6. **The role is held.** Checked through a `SECURITY DEFINER` helper so it is independent of the
   ceiling bound in the next step.
7. **The principal is bound** (§17). `core.bind_principal` derives the organization and ceiling
   from the live assignment and clearance, and for the application's login requires a current
   attestation (§24). The caller's requested ceiling is untrusted and never reaches RLS
   directly; it can only narrow what the database resolved.
8. **A reason is present** where the action type requires one.
9. **A prior action is replayed** if this key was already used (§29). Replay happens after
   clearance is resolved, so an idempotency retry cannot bypass the authority boundary.
10. **The action id is minted** and the effective time settled, both from the database: the id
    by `uuidv7()`, and an omitted effective time as the database clock rounded up to the
    millisecond (§13).
11. **Prepare** — materialize, lock, validate, digest (§27).
12. **Act coverage is asserted** (§20), after the targets are locked.
13. **Apply** — insert the act, apply the transitions, run the typed effect.
14. **Finalize** — append the audit event, emit the outbox row.
15. **The receipt is read back** from what the act durably wrote.

**KF-SAS-RQ-051.** Authority SHALL be resolved before any state is materialized, and target
coverage SHALL be asserted after targets are locked.

## 27. Materializers and effects

The split exists because two different things happen at two different moments, and conflating
them produced a class of bug worth naming.

A **materializer** creates records before target locking. The transaction context is bound, but
`core.action` does not exist yet. So a materializer inserts, and nothing else: lifecycle
movement and action references belong in the effect, because neither can name an act that has
not been recorded.

An **effect** applies typed writes after the act exists and transitions are applied. An effect
failure rolls back the whole action transaction.

`prepareActionState` sits between them and does the work that makes an act safe:

- refuses an action with no targets, when the type requires them;
- takes `select … for update` on every target, in canonical id order, so two concurrent acts on
  overlapping targets cannot deadlock by ordering — the statement itself says `order by id`, since
  `0.1.0-draft.8`; before, the rows were sorted in TypeScript afterwards, which ordered the digest
  and not the locks, since `for update` locks rows in the order the plan emits them;
- refuses a target that is missing or invisible under the bound context, as
  `object_not_visible` — the same refusal for both, because telling a caller that a record
  exists but is invisible is itself a disclosure;
- refuses a stale `expectedVersion` as `version_conflict`;
- resolves the lifecycle transition, refusing an illegal one as `illegal_transition` and an
  ambiguous one as `precondition_failed`;
- asserts separation of duty (§23);
- runs the action's own precondition check;
- digests the before and after target states.

**KF-SAS-RQ-052.** Targets SHALL be locked in a canonical order, and an act SHALL refuse a
target that is not visible under the bound access context.

**KF-SAS-RQ-053.** An act SHALL refuse a stale expected row version rather than applying a
change over a read the caller did not make.

## 28. Refusal codes

Thirteen, closed, each distinct so a caller can respond rather than only log:

| Code | Meaning |
|---|---|
| `unknown_action` | the action type is not available in this process |
| `actor_not_authorized` | the actor may not perform this act |
| `classification_not_granted` | the requested ceiling exceeds resolved clearance |
| `role_not_held` | the acting role assignment is not live for this actor |
| `not_attested` | no current attestation that the actor is present (§24); HTTP 401, so the caller identifies again |
| `act_not_granted` | no live act grant reaches the targets (§20), or the actor is a service (§21) |
| `object_not_visible` | a target is missing, or invisible under the bound context |
| `version_conflict` | the expected row version is stale |
| `illegal_transition` | the lifecycle does not permit this transition |
| `precondition_failed` | an action-specific precondition did not hold |
| `idempotency_conflict` | this key was used for different act semantics |
| `separation_of_duty` | the actor performed the act this one judges |
| `reason_required` | this action type requires a stated reason |

`not_attested` is the thirteenth, added 2026-09-24 with the attestor. Every other code answers
403, 404, 409, 422 or 400; this one answers 401, because the remedy is to present a token again,
not to ask for more authority.

Refusals are **thrown**, as `ActionRejected` carrying the code and a detail object.
`ActionResult.status` has exactly one value, `'applied'`. There is no success object that means
failure, and no caller can forget to check a status field.

`tests/conformance/rule-implementation.test.ts` maps refusal codes to the declared invariants
they implement, so "which rule does this refusal enforce" is answerable.

**KF-SAS-RQ-054.** A refused act SHALL raise, and the result type SHALL NOT be able to represent
a refusal.

## 29. Idempotency and replay

A network timeout is not a decision to apply an act twice.

Every request carries an idempotency key, stable across retries of one logical attempt. The
lookup key is the triple `(organization_id, action_type, idempotency_key)`, backed by a global
unique index.

Alongside it, a **semantic** request digest under the format tag `kf-action-request-v1`, over
the organization, action type, actor, acting role, **sorted** target ids, payload, reason,
expected version and effective time. What is deliberately excluded is as important as what is
included: `requestId` is transport correlation and `maxClassification` is read scope, and
neither changes mutation semantics. Target order is non-semantic because authority and audit
operate over a set. An omitted event time stays null in the digest, so the database clock that
supplies it (§13) cannot make two otherwise identical retries differ.

On replay the system does not simply return the old result. It re-verifies it:

- a different actor or role on the prior act is `actor_not_authorized`;
- a different request digest under the same key is `idempotency_conflict` — the key was used for
  different semantics;
- the audit receipt is **recomputed**. The chain digest is recalculated from the recorded event
  and compared to what was stored, along with the result status, the event count, the target
  ids, and every attributed field. A mismatch is `precondition_failed` with a message saying the
  action or audit receipt is inconsistent;
- the receipt is re-read from durable state, because a replay that carried a different receipt
  would be a different act.

**KF-SAS-RQ-055.** A retried act SHALL apply at most once, and the replayed result SHALL be
re-read from durable state rather than reconstructed.

**KF-SAS-RQ-056.** The idempotency digest SHALL cover exactly the fields that determine mutation
semantics, and SHALL exclude transport and read-scope fields.

**KF-SAS-RQ-057.** A replay SHALL re-verify the integrity of the prior act's audit receipt
before returning it.

## 30. The audit chain

One append-only hash chain over every act. Each event digests the previous digest together with
the RFC 8785 canonical form of the act's attributed fields, and records the format it was computed
under in `link_format` (`20260924001100`). Every link appended since that migration is
`kf-audit-link-v2`, whose preimage carries the tag as a `format` property beside the fields, as
KF-SAS-RQ-016 requires. Earlier links stay `kf-audit-link-v1` — the untagged preimage, a label for
what they already were — and verify under it, because the chain is append-only and signed
checkpoints and backups already hold their bytes; re-hashing them would break every link after.
A format never regresses: a v1 link after a v2 one is refused by the database and by every
verifier outside it. §100.27's audit-chain half is closed.

Three properties are enforced structurally:

- **One writer of the chain.** `appendAuditEvent` is the only place that appends an event and
  computes `prev_digest`. Two hand-written appends would be two chances to compute it
  differently, and a chain that disagrees with itself is indistinguishable from a tampered one.
- **The database recomputes every link** (`20260923000200`). Until then the insert trigger
  checked an event's link to its predecessor and never its digest, so a writer could make a digest
  nobody computed the chain head. `core.audit_event_digest` now recomputes it from the event's own
  fields and its action's targets, exactly as `auditChainDigest` does, under the event's recorded
  format (`20260924001100`), refusing a new link that is not `kf-audit-link-v2`; readiness counts a
  format regression as a break, beside a link that does not link; and
  `core.enforce_audit_chain_head` refuses a mismatch, an event that misdescribes its action, and —
  outside an administrator session — an event for any action but the one the sealed context names.
  The second computation is a check, not a second writer: where the two disagree, nothing is
  stored.
- **The chain lock is taken as late as possible.** It serializes every act in the system, so it
  is held for the shortest interval the arithmetic allows.

`tests/audit-verification/ledger.test.ts` verifies the ledger against a real database,
including from the position of someone who can write to the audit table.

Above the chain sit signed Merkle checkpoints (§89), produced by a separate process.

**KF-SAS-RQ-058.** Every act SHALL append exactly one event to an append-only chain, computed by
one implementation, in the same transaction as the act.

**KF-SAS-RQ-059.** The audit chain SHALL be independently verifiable from its recorded events
without trusting the process that wrote them.

**KF-SAS-RQ-237.** The database SHALL recompute each audit event's digest from the recorded fields
it commits to, and SHALL refuse an event whose stated digest differs or which does not describe
the act the sealed context names.

## 31. The outbox

Effects that reach outside the transaction do not run inside it. `core.outbox` takes one row per
act, topic `kf.<action_type>`, with a partial index over undelivered rows. A worker polls it.

There is no `LISTEN`/`NOTIFY` anywhere in the system. The choice is stated in the test that
governs it: delivery may be **late**, and may not be **lossy**. A notification is neither
transactional nor durable; a row in the same transaction as the act is both.

**KF-SAS-RQ-060.** Side effects outside the act's transaction SHALL be driven from a durable
record written inside it, and delivery SHALL be at-least-once rather than best-effort.

## 32. Preflight and rehearsal

An agent, or a person, may want to know what an act *would* do. `TransactionalActionPreflight`
is a read-only rehearsal seam, and its contract is stated where it is defined: a successful
preflight never grants write authority.

The agent tool surface is eight reads and one rehearsal, and the rehearsal runs a real
dispatcher action inside a rollback-only transaction. So an agent can find out what would happen
and cannot make it happen. There is still no general-purpose `act()` tool.

Every agent read asks the same read grant the API asks (KF-SAS-RQ-039, RQ-041): an ungranted
object is absent from `read_record`, `read_history`, `available_actions` and the rest, a search
drops ungranted hits, and `trace_relations` shows an edge only when a grant reaches both ends.
Until `0.1.0-draft.8` they answered on row-level security alone, so a person with clearance and no
grant could learn a record's title and history through an agent.

**KF-SAS-RQ-061.** A rehearsal SHALL exercise the real write path inside a transaction that
cannot commit, and SHALL NOT confer authority on any subsequent request.

## 33. Bootstrap acts

There are exceptions to §25, they are enumerated, and each is documented where it is exported
rather than hidden.

Dispatch binds authoritative clearance before effects run. So the **first** clearance in an
organization cannot be granted through the dispatcher: there is no clearance yet to bind. That
grant happens outside it — and it still has to extend the same audit chain, with the same
arithmetic, or the chain disagrees with itself. `appendAuditEvent` is exported for exactly this,
with that reasoning attached.

Since ADR 0033 the exception is wider and deliberate. **Authority is minted only by the owner
credential**: `kf_app` has no INSERT on `org.person` or `org.role_assignment`, and neither INSERT
nor UPDATE on `org.external_identity` (`20260923000200`), because that grant was the whole of what
a compromised API needed to make itself somebody. So five administrative commands run on the
owner connection, outside the dispatcher, and each still appends through `appendAuditEvent`:
`apps/api/src/admin/bootstrap-organization.ts`, `grant-authority.ts`,
`declare-service-actor.ts`, `retire-organization.ts` and `revoke-identity.ts`. A sixth,
`declare-agent.ts`, records an agent declaration as a row carrying its own decider and reason
rather than as an act, for the reason §24 gives. Since `20260925010000` the application cannot
change a person either — who is human or service, and which organization they belong to — and a
trigger refuses anyone but an administrator session creating a person or changing a person's id,
kind or organization. What the application keeps is narrower
than creation: it may end-date a role assignment or a clearance and nothing else about it — a
trigger refuses reopening, retargeting or extending an interval — and it may grant a clearance
only by a dispatched act, never to the act's own actor.

**KF-SAS-RQ-062.** Any act that cannot pass through the dispatcher SHALL still extend the audit
chain using the same implementation, and SHALL be enumerable.

**KF-SAS-RQ-236.** People, role assignments and external identity links SHALL be created only
through the owner credential, each creation as a recorded act; an external identity link SHALL be
revoked only through the owner credential, as a recorded act naming its decider and reason, and
never deleted; the application role SHALL be able at most to end-date an assignment or clearance,
and SHALL NOT grant clearance to the actor granting it.

## 34. What the dispatcher does not do

Stated so that its guarantees are not read as broader than they are.

**34.1 It does not decide what an action means.** The action's materializer and effect own the
typed writes. The dispatcher owns authority, ordering, atomicity and recording.

**34.2 It does not validate payload shape beyond what an action's own code requires.** There is
no schema layer between the caller and the effect; each action reads what it needs and refuses
what it cannot use.

**34.3 It does not enforce row visibility.** PostgreSQL does. The dispatcher names the principal;
the database binds it (§17) and the policies decide. This is the point of §5, and it is why a dispatcher bug cannot widen a
read.

**34.4 It does not know about HTTP.** The API is a caller like any other, and holds no authority
of its own.

**34.5 It does not retry.** A refused act stays refused. Whether to retry is the caller's
decision, and the idempotency key is what makes that decision safe.

---

# Part IV — The database as the authority

## 35. The authority thesis, in SQL

§5 states the thesis. This part states what it means concretely, because "the database is the
authority" is a slogan until somebody says which construct enforces which rule.

| Rule | Enforced by |
|---|---|
| what a reader may see | row-level security policies on `core.object`, over a bound context |
| what may reference what | foreign keys |
| what values are legal | check constraints |
| who is acting, where, at what ceiling | a sealed context bound by `core.bind_principal` (§17) |
| what may never change again | triggers that refuse `update` and `delete` on immutable rows |
| what may not overlap | exclusion constraints over validity intervals |
| that an unknown token is unknown | foreign keys into `registry.*`, so an unknown state or action fails a key rather than an application check |

That last row is the pattern worth naming. The ontology is **mirrored into the database**, so a
typed row referencing a lifecycle state or an action type references a registry row. An
application that invents a state token gets a foreign key violation, not a silently accepted
value that fails somewhere else later.

The same holds for the shape of an edge (`20260925030300`). R01 declared no source or target types
for its relations, so `settles` from a risk to a supplier was as storable as `settles` from a
payment to an invoice. The ontology now declares both ends of every relation, the compiler refuses
a relation that omits either (ONT-012, an error from `0.1.0-draft.8`), the seed mirrors them into
`registry.relation_type_endpoint`, and a trigger refuses an edge whose source or target type is not
declared for its end — for administrator sessions too, because a restore that writes an edge of
the wrong shape is writing a corrupt graph. The trigger is `SECURITY DEFINER` so a writer who
cannot see the target is still refused a wrongly shaped edge rather than let through by row
security hiding its type. `tests/database/relation-endpoints.test.ts` plants both ends.

**KF-SAS-RQ-070.** The declared ontology SHALL be mirrored into the database such that an
undeclared type, state or action token fails a referential constraint.

**KF-SAS-RQ-244.** Every relation type SHALL declare the object types each of its ends may
connect, and the database SHALL refuse an edge whose source or target type its relation does not
declare, whoever writes it.

## 36. Schemas as authority boundaries

The schemas are authority boundaries, not folders: each names the domain that owns the facts
inside it, so "which system may write this" is answerable from the table name. How many there are
is in [`generated/measurements.md`](../../generated/measurements.md); what each owns is here.

| Schema | Owns |
|---|---|
| `registry` | the ontology, mirrored from the YAML sources under `ontology/` |
| `core` | object identity, typed relations, actions, approvals, snapshots, audit, outbox, verification, the context seal and attestations, and the declared exemptions from the act write guard (§25) |
| `org` | people, organizations, engagements, roles, clearance, grants, declared agents (§24), and the access-demand aggregate (§64B) |
| `product` | products, configuration items, baselines |
| `work` | projects, work packages, work orders, execution, warrants |
| `engineering` | decisions, changes, requirements, risks, tests |
| `content` | artifacts, versions, locations, documents, publications, orphan collection |
| `finance` | invoices, payments, allocations |
| `quality` | controlled documents, CAPA, suppliers, training |
| `ops` | backup runs and copies, recovery objectives, restore drills, readiness evidence |
| `search` | a derived, disposable index; and, as transient observations that expire (§64B), recorded queries, their pseudonym key and the demand contributions counted from them |
| `retrieval` | the retrieval index's band version and its embedding queue, both derived and excluded from the boundary (§64A); and the digests of what semantic answers disclosed, as transient observations |
| `ml` | append-only ML lineage, typed metrics, run seals, signed promotions |
| `secure_object` | secure-object capabilities, authority keys, erasure |

`search` carries its own statement of what it is not: nothing there is a source of truth, and
`search.rebuild()` reconstructs every row from `core.object` and the typed tables. A derived
index that could not be rebuilt would be a second authority by accident.

The database says the same (`20260925020000`): every schema carries a comment opening with the
domain this table gives it, or saying it is derived and not an authority, and
`tests/database/catalog-authority.test.ts` holds the running schema set to this table's, so a
schema added without a row here fails.

**KF-SAS-RQ-071.** Each schema SHALL name exactly one authority domain, and a derived schema
SHALL be reconstructible from authoritative rows.

## 37. Roles and DDL

Group roles, all `NOLOGIN`, so a role is a set of privileges rather than an account:
`kf_owner_role`, `kf_migrator`, `kf_app`, `kf_worker`, `kf_checkpoint`, `kf_readonly`,
`kf_auditor`, `kf_backup`, `kf_ml_promoter`, and since `20260924001000` `kf_attestor`, the only
application-side role that may vouch a person is present (§24), and `kf_service_actor`, an
application login whose principal must be a declared service actor (§21). `kf_api` is not among
them and never was: it is the example login role, inheriting `kf_app`, in the comment that
explains the pattern. The list is counted in
[`generated/measurements.md`](../../generated/measurements.md).

`kf_migrator` owns structure and is **the only role permitted DDL**. `kf_app` is the API: it
reads, and writes domain rows through actions only. The separation means a compromised
application role cannot alter a policy, drop a constraint or add a table outside the boundary
registry.

The deployment gives each service a distinct unprivileged system account. Backup and restore
drill used to share one, on the reasoning that they needed the same secrets; the 2026-09-23
hardening found that they do not. The backup writes and signs an archive encrypted to a public
key, and only the drill needs the secret half, so the drill runs as `kf-drill`, the one unit that
can decrypt, and the backup user never can. The off-site copy runs as `kf-offsite`, the attestor
as `kf-attestor` in the `kf-attest` group it shares only with the API's socket, and the daily
checkpoint verification as `kf-audit-verify`, which holds no signing key. The one remaining
shared account is `kf-alert`, used by the alert unit and its heartbeat, which need the same
webhook and nothing else.

**KF-SAS-RQ-072.** Exactly one database role SHALL be permitted schema changes, and the
application role SHALL NOT hold it.

## 38. Row-level security

**Every table that enables row-level security forces it**, since `20260924000200`. The migration
forces each table that only enabled it and then refuses to complete if any remains, and
`tests/database/row-security-forced.test.ts` fails on a table added later that enables without
forcing. KF-SAS-RQ-073 is met as stated.

The history is kept because it is instructive. On 2026-09-04, against the first install of this
schema on a host, 143 tables enabled row-level security and 70 forced it; the 73 that did not
reconciled exactly with the migrations, and the "113 of 139" `deploy/postgres/planner.conf` had
claimed was wrong in both halves, having come from a workstation database that had accumulated
state. By 2026-09-24 the migrations left 76 unforced — the domain tables in work, quality,
engineering, product and finance, and parts of core, org and content. No host has been measured
since the forcing migration; that runtime count is owed.

What forcing changes is narrower than it sounds, and the reason is worth stating. ENABLE binds
every role but a table's owner, and PostgreSQL treats any login that **inherits** the owner role
as the owner. Before `20260924000200`, such a login read every tenant at every classification with
no context bound, and the only thing in the way was the API's refusal to start as one — a check in
one program, not a property of the tables. FORCE binds the owner too. The owner itself still reads
everything, by its `BYPASSRLS` attribute (ADR 0026), which is not inherited; every `SECURITY
DEFINER` seam depends on that, and readiness refuses a host whose owner lacks it.

Tables that do not enable row-level security at all — `ops.*`, `registry.*` reference data,
`org.role`, the chain head and checkpoints, the seal key, leases and migration bookkeeping — name
no organization and hold no record content, so there is no row a policy could scope. They are
guarded by grants and append-only triggers.

Two kinds of count appear in this document because two things are being counted: statements in
migrations, and tables in a running database. §103.3 says which to cite for what.

The policies scope every read to the bound organization and classification rank. ADR 0003
records how the typed tables came to carry policies of their own, keyed on the visibility of
their envelope (§13). Since `20260923000300` every policy asks for the sealed context once per
query rather than once per row: verifying the seal made each accessor a call the planner cannot
inline, and a policy-governed read of 12 000 rows went from 17 ms to 296 ms before the rewrite and
5.9 ms after it, measured by `tests/database/rls-read-cost.test.ts`.

A caution that is part of the architecture, not an accident: the boundary registry
(`docs/architecture/master-record-boundary.json`) is built by reading `alter table … enable row
level security` statements **literally** from the migrations. A table brought under RLS by a
`DO` loop is invisible to that scan. That is why §62 requires new RLS statements to be literal.
The one loop there was — over `ml.run_lineage_input`, `_output` and `_parent_model` — is now
restated literally (`20260925020000`), and `tests/database/catalog-authority.test.ts` asserts that
the statically discovered set equals the running one.

**A running database is held to the migrations, not only a test database**
(`20260925040000`). `core.readiness_unforced_row_security()` names every table that carries no
row security, or enables it without forcing it, and is not declared, with its reason, by
`core.readiness_row_security_exemptions()`; readiness reports each as a `row_security_reconciled`
failure. A table created by hand on a host, or an `alter table … no force row level security`
typed to make one query work, is therefore caught where the data is. The exemption list lives in
a migration because "derivable from the migrations" is KF-SAS-RQ-186's requirement, and a change
to it is a new migration saying why. The cost is a merge rule: a branch adding a table without
row security must redefine that function to declare it, and a sibling branch that did not know of
the table will not — which has happened once, repaired by `20260925045000`. The backup login's
reach (§88) carries the same rule and has been missed the same way (`20260925135000`).

**KF-SAS-RQ-073.** Row-level security SHALL be forced, not merely enabled, on every table
holding governed records.

**KF-SAS-RQ-074.** A table brought under row-level security SHALL be declared in a form the
boundary registry can discover statically.

**KF-SAS-RQ-239.** Every table that enables row-level security SHALL force it, and a table that
enables it without forcing it SHALL fail a gate.

## 39. Policy predicates and plan shape

A policy predicate is not only a security statement; it is an input to the query planner, and
the wrong shape is a performance defect that looks like a security feature.

ADR 0007 records the case. `content.composition_input`'s policy was a `CASE` over six branches,
each an `exists` against a *different* RLS-protected table. PostgreSQL inlined all of it, and
counting three rows cost about 950 milliseconds.

The fix was to move the predicate **verbatim** into a PL/pgSQL `stable` **`SECURITY INVOKER`**
function. Invoker rights keep every referenced table enforcing its own RLS, so this is a
plan-shape change and not a visibility change — which is the property that made it acceptable at
all.

A census found a handful of other policies with three or more `EXISTS` clauses. Three siblings
in `ml.*` were long unmeasured because their tables were empty, where the hashed subplans never
run; `tests/database/rls-read-cost.test.ts` (opt-in, behind `KF_MEASURE_RLS`) now seeds them with
rows whose references all exist and times each policy against the same count unfiltered, and ADR
0007's dated section records the figures. None approaches the cost that prompted the ADR.
§100.7 is closed.

**KF-SAS-RQ-075.** A policy predicate refactored for plan shape SHALL preserve visibility
exactly, and SHALL run with invoker rights so that referenced tables continue to enforce their
own policies.

## 40. The JIT finding

The single largest performance finding in this system, and it follows directly from §5.

Row-level security wraps almost every table. RLS subplans inflate the planner's **cost
estimate** by roughly a hundredfold — 2 222 440 estimated for a query that executes in 16
milliseconds. PostgreSQL's just-in-time compilation triggers on that estimate. So it compiled
for 122 milliseconds in order to run 16 milliseconds of work.

Measured both ways with the repository's own harness:

| Query | JIT on | JIT off |
|---|---|---|
| `training_requirement` · policy | 294.9 ms | 21.3 ms |
| `controlled_document` · policy | 160.8 ms | 18.5 ms |
| full scan count | 161.3 ms | 18.2 ms |
| `training_requirement` · plain join | 180.6 ms | 60.1 ms |

The plain join improved too, so it was never only an RLS problem. And the policy is now
**faster than the join it replaces**, which answers ADR 0003's open cost question in favour of
the boundary.

`jit=off` therefore lives in three places, held in agreement by
`tests/deployment/postgres-settings-parity.test.ts`: `docker-compose.yml`, the test harness, and
`deploy/postgres/planner.conf`. That file states its own status plainly: unlike the
point-in-time-recovery fragment, it is not optional and not posture-dependent. A private host
that omits it is the only place still running the configuration measured to be 8 to 14 times
slower — and it no longer omits it silently: readiness's `planner_settings` check reads the live
server's `jit` and fails a host where it is on (`tests/database/readiness.test.ts`).

**KF-SAS-RQ-076.** Planner settings that a measurement showed to be load-bearing SHALL be
applied identically in development, test and production, and a gate SHALL assert they agree.

## 41. Triggers and immutability

The triggers, counted in [`generated/measurements.md`](../../generated/measurements.md),
implement Law 6 first: a record that states something happened cannot be edited to state that it
happened differently.

An artifact version is a statement that a specific set of bytes existed and was used, so it is
append-only. An audit event cannot be updated. A location may be updated only to record
verification. A public copy may be written only by a publication act and only into a store
declared public, and unpublishing marks it rather than removing it.

Triggers are used where a `CHECK` cannot reach, because a check constraint cannot read another
table. That is a deliberate and repeated pattern, and it is why the count is high. Since the
2026-09-23 hardening they also hold writes to the sealed context: an audit event's digest (§30),
an act's authority (§20), an interval that may only close (§33), a revocation dated by the
database's clock, and a verification whose basis is paced (§100.26).

The draft.8 work added four more, each binding the owner too, because a trigger has to be dropped
deliberately where a privilege can be re-granted by accident:

- **A verification is append-only** (`20260925020000`). `core.object_verification` was guarded
  only by granting the application no update or delete; it now carries the same refusal every
  other event record in `core` does. A withdrawn verification is another record, not an edit.
- **Every write belongs to a recorded act** — the act write guard of §25 (`20260925011000`).
- **A decided decision is frozen** (`20260925030000`, KF-DEC-001). The state machine already kept a
  decided record from moving anywhere but supersession; nothing kept its words. Once past
  `proposed`, a decision's title is fixed and its alternatives are closed.
- **A closed record keeps its identity** (`20260925064200`). Once a record is in a state the
  ontology declares terminal — or is a decision in `accepted`, which KF-DEC-001 names immutable —
  its title, type, organization, authority domain and creation facts are fixed for every session.
  Its lifecycle, classification and retention are not: supersession is the way out of `accepted`,
  and a closed record is still reclassified and still runs its retention.
  `tests/database/closed-identity.test.ts` plants each.

Two structural keys belong with them. A typed row is bound to its type by a composite key
`(id, object_type)`, which `work.warrant` and `ml.promotion_authority_decision` had lacked
(`20260925012000`); and a record's `authority_domain` must be the one the ontology gives its type
(`20260925013000`) — five materializers had been filing records under the wrong domain, so the key
is validated wherever no existing row breaks it and the runbook finishes the job where one does.

**KF-SAS-RQ-077.** A record asserting that an event occurred SHALL be immutable after it is
written, except for fields that record subsequent verification of it.

**KF-SAS-RQ-243.** Once a record reaches a closed state, the fields that say what it is — its
title, type, organization, authority domain and creation facts — SHALL be immutable for every
session, including the owner's.

## 42. Check constraints and invariants

`ontology/rules.yaml` declares the invariants. Ten came from R01 and are asserted byte-identical
and in order; the rest are declared additions.

Every declared invariant is enforced by a database constraint, a trigger or a dispatcher
precondition. `tests/conformance/rule-implementation.test.ts` maps each refusal code to the
invariant it implements, exhaustively in both directions, and `tests/database/rule-ledger.test.ts`
records every rule as live, each citing the test that plants its violation against a real
database — none pending. The last to close was KF-DEC-001's content half, which the ledger had
recorded as unenforced until `20260925030000` froze a decided decision's words (§41).

What remains is the distributed validator, and it is stated exactly rather than as a fraction.
The R01 pack shipped a `validate_graph.py` that is frozen byte-identical with the release
(§78), and it checks three of the declared rules — KF-GRAPH-001's dangling edges, KF-FIN-001's
accepted value within the ceiling, and KF-FIN-003's allocations — beside schema validity and an
invoice line-total check no rule declares. The others are enforced in the database and not by a
consumer who validates a graph offline with that script; the specification's own §27.1 calls
prose-only rules nonconforming, and for such a consumer they still are. The database side is
unchanged by that: the script is frozen, not the enforcement. §100.1 carries the remainder.

**KF-SAS-RQ-078.** Every declared invariant SHALL be enforced by a database constraint or an
action precondition, and the mapping from invariant to enforcement SHALL be asserted by a test.

## 43. Migrations

Forward migrations, counted in [`generated/measurements.md`](../../generated/measurements.md),
each with a `migrate:down` section. Structure lives only in
`database/migrations/`; the sibling directories for constraints, functions, row security,
triggers and seeds are empty by design, because DDL split across directories is DDL applied in
an order nobody declared.

A migration is promoted, never re-run in place. The deployment installs an immutable release,
verifies its checksum manifest, and switches a symlink atomically, retaining the previous
release for rollback. Both halves are scripts, not prose: `scripts/deploy/migrate-release.sh`
applies one verified migration set with `dbmate up --strict`, which refuses a migration whose
version is older than one already applied — the one-declared-sequence property KF-SAS-RQ-079
states, which dbmate's default would let a late-merged branch violate — and
`scripts/deploy/install-release.sh` switches the release (§86), tested by
`tests/deployment/install-release.test.ts`.

**KF-SAS-RQ-079.** Schema changes SHALL be ordered, forward-only in application, and applied
from one declared sequence.

## 44. Reversibility

Some migrations are not reversible, and that is declared rather than discovered during an
incident. Each carries `-- kf:forward-only <reason>` in its down-section; rollback runs down to the
highest such migration and the rehearsal asserts it stopped there, by version.
`tests/deployment/migration-reversibility.test.ts` plants an empty down-section without the
declaration and requires the verifier to name it, and the number that declare it is in
[`generated/measurements.md`](../../generated/measurements.md).

Irreversibility is acceptable when it is known. A `down` section that silently loses data is
worse than no `down` section, because it invites a rollback that cannot be undone.

**KF-SAS-RQ-080.** A migration that cannot be reversed without loss SHALL be identified as such
by a test, and SHALL NOT present a `down` path that appears safe.

## 45. The registry mirror

`registry` holds the ontology as rows: object types, relation types, action types, state
machines, transitions, and the `requires_capability` column that makes §20 mechanical.

It is seeded from `generated/sql-registry/001-ontology-seed.sql`, which the compiler produces
from the YAML sources under `ontology/`, and which names its own source digest in its header.

Earlier revisions said `tests/database/fresh-install.test.ts` pinned that digest so a mismatch
was caught at install. It did not, and no install checked it: the claim was false until
`0.1.0-draft.8`. The digest is now compared where it matters, three times and against the running
database rather than a literal in a test. `migrate-release.sh` compares the seed's declared digest
with `registry.schema_release`'s current row **after** seeding, because the seed is what writes
that row; readiness's `schema_release` check compares them on every run; and the API compares them
at startup and refuses to serve outside the `development` profile, where a developer mid-rebase
gets a warning instead. `tests/deployment/private-host.test.ts`, `tests/database/readiness.test.ts`
and `tests/permissions/ontology-startup.test.ts` plant a mismatch at each.

The lesson the old wording carried still holds, and is the reason the check moved: a pinned
constant has to be re-pinned on every ontology change, one was once stale in a way that made its
assertion a no-op, and a pinned constant nobody updates is a test that stops testing. Comparing
the seed with the database needs no constant.

**KF-SAS-RQ-081.** A fresh installation SHALL verify that the seeded ontology matches the
compiled source by digest, and SHALL refuse to proceed on a mismatch.

---

# Part V — Content, documents and preservation

## 46. Artifacts and versions

An **artifact** is a logical piece of content with a kind and a source system. An **artifact
version** is an immutable statement that a specific set of bytes existed and was used: a
SHA-256, a size, a media type, and an optional revision label.

Versions are append-only. A new revision of a document is a new version, never an edit of an
old one, so a claim that cited a digest continues to cite exactly what it cited.

**KF-SAS-RQ-090.** An artifact version SHALL be immutable once written, and a change to content
SHALL produce a new version rather than modify an existing one.

## 47. Digest addressing

Content is addressed by SHA-256 over its exact bytes. A compiled view lives at
`compiled-views/sha256/<digest>`, which makes the address a function of the content.

The consequence is stated because it has teeth: **a silent parse change means one document with
two addresses.** That is why §52.3's pandoc measurement matters, and why the parser identity is
recorded on every parse.

**KF-SAS-RQ-091.** Content SHALL be addressed by a digest over its exact bytes, and the
producing toolchain's identity SHALL be recorded alongside the result.

## 48. Ingestion: copy or reference, never by default

ADR 0012. A file enters the Fabric one of two ways, and the caller must say which. There is no
default, and a batch that does not state its intent is refused before any database pool, source
file or object store is touched.

**Copy** (`--mode=copy`) — the Fabric holds the bytes. They are hashed, written to the working
store with create-only semantics, and attached by `attach_evidence`.

The order is load-bearing, and since 2026-09-23 it is this. **Content is scanned first**: a path
or content shape that must never enter — private keys, credential files, likely bank details, tax
and card numbers — refuses the whole batch before a byte goes anywhere, reading inside ZIP
packages and PDF streams under a decompression bound
(`apps/api/src/ingest/content-policy.ts`; a backstop, not a guarantee, and the threat model
states its blind spots). **A batch has a ceiling**, which a caller may lower and not raise. **The
act is rehearsed before any put**: the classification is checked against the session's ceiling
and the act is run through the transactional preflight, so a refusal that can be known in advance
is known before the object store — outside the transaction and immutable — is touched. **The
storage key is derived by the server** from the bound organization and the digest; a caller-named
key is refused. **The document is parsed before the transaction opens**, so a source pandoc
cannot parse is refused without holding a transaction, and the act inside it only checks that
the parse was computed over the exact bytes it verified.

**Reference** (`--mode=reference`) — the Fabric does not hold the bytes. It records governed
metadata, the digest, and a versioned external locator through `register_external_artifact`.
The file is still hashed, because the digest is the whole point of a reference.

Reference mode exists for a specific reason: **a vendor datasheet is third-party copyright.** It
is referenced by document number, revision and hash, and never committed. Before reference mode
existed, the only way anything could enter was by copying its bytes, so the safe path did not
exist and the unsafe one was the only one available.

The planner (`apps/api/src/ingest/plan.ts`) is pure — no database, no filesystem — so its
refusals happen before any side effect, and they are tested by planting each one.

**KF-SAS-RQ-092.** Ingestion SHALL require an explicit copy-or-reference intent, and SHALL
refuse a batch that does not state one.

**KF-SAS-RQ-093.** The system SHALL support recording an external artifact by digest and locator
without holding its bytes.

## 48A. Verification, and what unverified means

[ADR 0031](../decisions/0031-a-draft-is-a-record-that-says-so.md). §48 admits one named item at a
time and KF-SAS-RQ-021 forbids admitting a container. Neither says how many acts a single gesture
may produce, and the distinction decides whether a low-friction capture path is possible at all.

**One gesture may produce many acts. It may not produce zero, and it may not produce one act
covering many items.** Zero acts is folder synchronisation — unattributable, and what RQ-021
forbids. One act covering many items is "I admitted this folder", the same container decision
reached by a different route. Many acts from one gesture is cheap capture with full attribution,
which KF-SAS-RQ-202 already permits. The person clicks once; the ledger receives one entry per
item, each naming them. A capture path built this way is a fast path **through** this machinery
rather than around it.

**Verification is orthogonal to lifecycle state, and this revision exists because the last one
assumed otherwise.** `draft` is the initial state of only some of the state machines in
`ontology/state-machines.yaml`; the others begin at `planned`, `proposed`, `active`, `open`,
`captured`, `prospective`, `in_service` or `received`. So "unverified" cannot be
`lifecycle_state = 'draft'` — a work order that begins at `planned` was never a draft, and under the
previous wording the rules below did not reach it at all.

Nor is it "any initial state". Equipment whose lifecycle begins at `in_service` is not unverified;
that is simply where that machine starts. Conflating the two would also produce nonsense acts —
promoting from `draft` something that was never in draft.

A record therefore carries **whether anyone has verified it, and who**, independently of where its
lifecycle sits. A record may be `active` and unverified — captured by a sync, unchecked — or `draft`
and verified, because somebody reviewed a draft.

**An unverified record is a record.** Law 6 applies, it is attributed and audited from the moment
it is written (RQ-202), and it appears in the preservation export marked unverified. Excluding it
would create a class of stored thing that can vanish, and §64B defines that category deliberately
narrowly.

**It is a member of a master record, and the projection says it is unverified.** Omission is not
available: a master record that silently omits is the failure §63 was written against. What is
required instead is that a reader can tell which members nobody has checked. An unlabelled
unverified record inside "everything you may see" is worse than an absent one, because it borrows
the credibility of the records around it.

**It is not citable as evidence.** A Warrant tracing to an unverified record is a claim resting on
something nobody has checked, which is the ticked box §97.3 exists to prevent. This is the single
place an unverified record is not a record like any other, and it is where the distinction earns
its keep.

**A promotion act records its basis.** Reviewing five hundred documents one at a time and promoting
five hundred in one gesture are different facts. A ledger that writes "verified" for both has made
the word carry no information, and an auditor asking whether a person looked at a document then has
no answer available. Recording the basis costs the fast path nothing and stops it misrepresenting
itself.

**KF-SAS-RQ-227.** A single caller gesture MAY dispatch many acts, SHALL dispatch at least one per
item it admits, and SHALL NOT dispatch one act covering several items.

**KF-SAS-RQ-228.** An unverified record SHALL be a record under Law 6, attributed from the moment
it is written, and SHALL appear in the preservation export marked as unverified.

**KF-SAS-RQ-229.** A projection that includes an unverified member SHALL label it as such, and
SHALL NOT omit it silently.

**KF-SAS-RQ-230.** An unverified record SHALL NOT be citable as evidence for a requirement or a
Warrant.

**KF-SAS-RQ-231.** An act that promotes a record from unverified SHALL record whether the item was
reviewed individually or promoted in bulk.

**KF-SAS-RQ-232.** Whether a record is verified SHALL be recorded independently of its lifecycle
state, and SHALL NOT be inferred from the state a record happens to occupy.

## 49. Object storage and the working store

Bytes go to an object store with **create-only** semantics: a put to an existing key is refused
rather than overwriting. Combined with digest addressing, this means a key can only ever hold
one set of bytes.

Ingestion distinguishes an authority refusal from a storage failure, and since 2026-09-23 it
prevents rather than cleans up: every refusal that can be known before the put is made before it
(§48), for `POST /ingest`, `POST /documents` and `kf ingest` alike. What can still slip through —
a crash between the put and the commit, an act refused by a check the rehearsal cannot see — is
swept by `kf-storage --collect-orphans`, which deletes a key under an organization's evidence
prefixes that no version or location references once it is older than a grace period (168 hours
as shipped). Each deletion is recorded in the append-only `content.orphan_collection`
(`20260924000400`), written through one definer seam that takes the collector and organization
from the sealed principal and requires a declared service actor, and carried in the preservation
export. Collection is not an act, because an act is on a record and an orphan is bytes no record
points at; it is still attributed and kept.

KF-SAS-RQ-094 is therefore met by prevention, a sweep, and a record of the sweep — not by the
first alone.

**KF-SAS-RQ-094.** Object writes SHALL be create-only, and a failed act SHALL NOT leave
unreferenced content in a store.

## 50. Storage locations

ADR 0017. Where the bytes are is a **set of locations**, each verifiable on its own.

`content.artifact_store` declares a store: an id, a kind, a bound address (endpoint and bucket,
never credentials — an endpoint carrying a user or password is refused by a check), whether it is
writable, and whether it is public. Every process that holds a store — the API, ingestion, the
worker, `kf-storage` and the dogfood loader — resolves it through `StoreRegistry.fromDatabase`
against these rows before building a client, and is refused (`StoreAddressMismatch`) when its
configured address differs. A store is declared and bound only through
`content.bind_artifact_store`, which binds an address to a store that has none and never rebinds;
no application role can insert or update the table (`20260925160000`). The checkpoint runner's
anchor bucket is not an artifact store and is outside the registry by design. `content.artifact_location` records one version's presence in one
store with a role — `working`, `hot_cache`, `durable_copy`, `evidence_copy`, `public_copy` — a
URI, a store version, and its own verification state.

The working row is mirrored by trigger from the append-only version row, so the old
`storage_uri` field became a compatibility view of a location rather than a second truth.

`readVersionBytes` degrades: if the working store fails for any reason, it serves a
**verified** durable copy. Degrading to an unverified copy would be serving bytes nobody
checked.

**KF-SAS-RQ-095.** A version's bytes MAY exist in several stores, each location carrying its own
role and verification state.

**KF-SAS-RQ-096.** A read that falls back to a secondary copy SHALL serve only a copy whose
digest has been verified.

**KF-SAS-RQ-249.** A process SHALL address a store only through the address its declaration
records, and SHALL refuse to use one whose configured address differs; a store's recorded address
SHALL NOT be changed once bound, and SHALL NOT carry a credential.

## 51. Replication and verification

`replicate_artifact_version` copies bytes to another store and records the location.
`verify_artifact_location` re-reads a location and re-hashes it, recording either the verified
digest or a verification failure.

Both are typed acts, so replication and verification are attributable and auditable rather than
background magic. §87.4 states the scheduling, and §100.4 records that it is not scheduled on
any host today.

**KF-SAS-RQ-097.** Replication and verification SHALL be recorded acts, and a verification
failure SHALL be recorded rather than retried into silence.

## 52. Document parsing and atoms

A document is parsed into ordered, independently hashed **atoms**. The parse records four
digests — source, atoms, loss and projection — each with its preimage persisted, so a claim
about the parse can be checked rather than trusted.

**52.1 Conversion loss is recorded, not discarded.** The parser reports every richer claim the
atom projection cannot retain. A lossy conversion that says nothing is indistinguishable from a
lossless one.

**52.2 The parse fails closed.** `attach_evidence` refuses a parser receipt whose source, atom,
loss or projection digest lacks its preimage.

**52.3 pandoc is deliberately unpinned, and the golden is frozen instead.** CI runs pandoc
3.1.3, the dogfood host 3.1.11.1, this workstation 3.10.2, and all three produce the **same**
content digest for markdown. So the parse is version-stable and a pin is not a correctness
requirement.

Two traps that measurement exposed. `parserVersion` originally recorded `pandoc-api-version` —
the AST *schema* version, not the binary — and now records `<binary>+api.<schema>`, for example
`3.10.2+api.1.23.1.2`. And no test ran the real pandoc at all until one was written, despite CI
installing it for that purpose.

The method generalises and is stated as a requirement: **report the digest from both hosts, and
freeze only what they agree on.** A golden frozen from one machine is that machine's output, not
the parser's behaviour.

**KF-SAS-RQ-098.** A parse SHALL record the identity of the tool that produced it, including the
executable version and not only its data-format version.

**KF-SAS-RQ-099.** A cross-host golden SHALL be frozen only over output that independent hosts
were measured to agree on.

**KF-SAS-RQ-100.** Conversion loss SHALL be enumerated and recorded with the parse.

## 53. Controlled documents

A controlled document has a lifecycle, an effective state, a classification, and revisions that
supersede rather than replace. Making one effective, superseding it and withdrawing it are all
institutional acts requiring `act` (§20).

**KF-SAS-RQ-101.** A controlled document's effective state SHALL change only through an
institutional act, and a superseded revision SHALL remain retrievable.

## 54. Compilation and rendering

A compiled view is a deterministic projection of a document's atoms to a target format, stored
by content digest. Rendering to Markdown, HTML, PDF and DOCX runs through pandoc with a LaTeX
engine for PDF.

Determinism is the requirement, not the format list: the same atoms and the same toolchain
produce the same bytes, which is what makes the content address meaningful.

The exact repeat cannot arise — a compilation basis is unique and a second, different result for
one request is refused — but a basis also carries the compiler's qualification state, so
requalifying the same pinned binary made a new basis over the same sources that nothing compared
with the old. A compilation whose basis matches an earlier succeeded run in everything but that
qualification must now reproduce the earlier run's semantic and view digests, or it is recorded as
the request's failed run with `nondeterministic_output`, naming the run it did not reproduce
(`20260925160100`, `KF-DOC-DETERMINISM-001`; [ADR 0002](../decisions/0002-liminal-backed-document-compiler.md)'s
dated note). Acceptance reads that record: once a run over the same sources and pinned compiler
has failed as `nondeterministic_output`, no succeeded run of theirs is accepted — not the run it
named, and not a later one that happens to match it — by the dispatcher precondition and by a
trigger on the acceptance row (`20260925170000`, `KF-DOC-DETERMINISM-002`). What that does not do
is in §100.35.

**KF-SAS-RQ-102.** Compilation SHALL be deterministic for a given source and toolchain, and the
result SHALL be addressed by its digest.

## 55. Preservation export

The export is the answer to "the database died". It carries every governed row in a canonical
form, and its inventory is **closed**: a table is in the export, or the export refuses to claim
completeness.

That closure is enforced across three places that must agree — the export section list, the
import target list, and the import order — and migration-seeded rows must be reconciled in the
restore path rather than colliding with rows the migrations already created.

Adding a governed table without updating all of them fails the round-trip test. This has caught
every new table added since it was written, which is the only reason to have it.

**KF-SAS-RQ-103.** The preservation inventory SHALL be closed, and a governed table absent from
it SHALL fail a gate rather than be silently omitted.

## 56. The round trip

Export, import into an **empty** database, export again, compare. If that holds, "the database
died" is a restore.

The test is `tests/round-trip/export.test.ts`, and the property it asserts is byte equality of
the two exports, not merely that the import did not error.

Backup and restore are the operational half of the same guarantee (§88), including a monthly
drill that pulls the newest off-site ciphertext back, checks it is the object recorded as sent,
decrypts it as `kf-drill`, restores it into a throwaway PostgreSQL 18 cluster that it deletes
afterwards, and records the result against the production ledger.
A backup is not valid until it has been restored, so the drill runs the **shipped scripts**
rather than a test-only path.

**KF-SAS-RQ-104.** An export imported into an empty database SHALL re-export byte-identically.

An export written by an earlier exporter must import too, because the backups are exactly that. A
table whose shape a migration changed is converted on import as the migration converted it, keyed
on what the archive itself carries — `work.deliverable`'s retired columns become
`work.deliverable_retired_attribute` rows (`20260925130100`,
`tests/round-trip/deliverable-upconversion.test.ts`) — and a section missing from a format-2
archive is accepted only when `section-eras.ts` names it as added later without a format bump,
file, manifest entry and count all absent together, and absent with the sections that arrived in
its commit and every section after it. A blanket rule would accept a truncated export. Where the
migration that added a section derived its rows rather than creating the table empty, the import
derives them the same way (storage locations, `20260902000200`).

**KF-SAS-RQ-248.** An export written by an earlier exporter of the same format SHALL import into
the current schema, each changed-shape table converted as its migration converted it, and a
section SHALL be accepted as absent only when it is named as a later addition.

**KF-SAS-RQ-105.** Restore SHALL be exercised on a schedule using the shipped scripts, and its
result SHALL be recorded.

---

# Part VI — The corpus and disclosure

## 57. The master record

A master record is one person's authorized corpus in one organization, compiled, sectioned,
sealed and delivered. It answers "what does this system hold about me, that I am authorized to
see".

It is compiled by an act, `compile_master_record`, and it carries a claim, a permission digest,
a staleness answer, its items, and a withholding ledger.

**KF-SAS-RQ-110.** A person SHALL be able to obtain the complete set of records about them that
they are authorized to see, as one compiled, sealed artifact.

## 58. Corpus identity

ADR 0013, and the correction is instructive enough to state in full.

The identity key was `(person, organization, permission_digest)`, and `permission_digest` hashed
object ids, types and content digests — a **corpus digest under the wrong name**. Sectioning
lived outside that digest. So recompiling after a relevance-only change returned `500` on a
unique violation, while the read endpoint cheerfully reported `stale: false`.

The fix follows from asking what a master record *is*. Its identity is its **corpus**: the
sorted set of `(object_id, object_type, content_digest, classification, item_state)`. Sections,
relevance and compilation time are excluded, because they are readings of the corpus and not the
corpus.

So: an unchanged corpus compiles to the same record and replays, returning 200 rather than
failing. `permission_digest` became a smaller hash over object ids and the effective ceiling,
which answers a different and useful question — *why* the corpus changed. And `stale` compares
the current corpus digest to the stored one, so it tells the truth.

The migration is a forward-only floor.

Each member's content digest is taken over its payload — the object, its typed rows, its
relations and the artifact versions it references — so what the payload reads is part of the
corpus identity, and it is named. `content.master_record_payloads(uuid[])` reads the payload for
the whole permitted set in one statement (`20260925121500`) rather than once per member, which had
made every Object View cost linear in the organization's size; it is `SECURITY INVOKER`, so it
widens nothing, and `tests/database/master-record-payloads.test.ts` holds it byte-equal to the
one-object form. `20260925121600` then found that every implementation since the first had read
an artifact relationship as its `relationship` column rather than its row, recording
`["supersedes"]` without which versions it linked. The bytes under recorded claims could not
change without making every one of them stale, so the reading is versioned rather than fixed in
place: `kf-master-record-payload-v1` is the reading as recorded, defect included, under
`kf-master-record-member-v1` and manifests `kf-master-record-v1`/`-v2`; `-payload-v2` reads every
row whole, under `kf-master-record-member-v2` and `kf-master-record-v3`. Both functions take the
format and have no default, so no caller reads one believing it is the other.

**KF-SAS-RQ-111.** A master record's identity SHALL be its corpus, and an unchanged corpus SHALL
compile to the same record rather than a conflict.

**KF-SAS-RQ-112.** Staleness SHALL be computed by comparing the current corpus to the recorded
one, not asserted by the writer.

## 59. Projections

ADR 0014. **Master is the exact authorized corpus; everything else is a projection over it.**

`@kf/projections` is one engine. `project(master, definition, params)` returns a canonical
`kf-projection-result-v2` — members, sections, provenance, digests — and `render(result,
format)` turns that into Markdown, HTML, PDF, DOCX or JSON. The web application renders results
generically, so a new definition needs no UI code.

Every member carries its verification (§48A), in the master record's own words, and the engine
refuses a member without it, or whose label its facts do not produce, as `unlabelled_member` — so
no result can show an unverified member unlabelled, and KF-SAS-RQ-229 holds for every projection
rather than only the master record's rendering. A member whose verification the reader cannot see
is labelled "no verification is visible to this reader", and its facts are not repeated. Because
what a reader is shown changed, the projection digest now covers each member's verification, and
the format moved to `-v2`. Moving it also corrected a claim: earlier revisions said the
`kf-projection-result-v1` digest carried its tag in the preimage, and it never did; `-v2`'s does.

Two invariants hold over every result, and both are planted against:

- **⊆-corpus.** Every member of a projection is a member of the master corpus. A definition that
  reaches outside it fails.
- **Coverage.** Sections partition the corpus; a Raw Corpus remainder is always appended, so a
  definition that omits a member fails rather than hiding it.

Core definitions are pack-shipped in `ontology/projections.yaml`, so they are
compiled, R01-gated and signed with the pack. Organization-authored custom definitions are
controlled database records referencing the pack-declared grammar.

`agent_context` is a projection definition, not a format. That is the point: a reading for an
agent is subject to the same two invariants as a reading for a person. The AI proposal planner
consumes exactly that reading: it takes the reader's `agent_context` result, refuses one that is
not `agent_context`, is not that reader's, or whose projection digest does not recompute from its
own sections, uses only its members — anything else is omitted as `outside_projection` before it
reaches the authorizer or the model — and the proposal's recorded model provenance names that
reading (definition, version, corpus digest and projection digest) inside a context claim digested
as `kf-ai-proposal-context-v2`.

**KF-SAS-RQ-113.** Every reading of a corpus SHALL be a declared, versioned projection, and its
members SHALL be a subset of the corpus.

**KF-SAS-RQ-114.** A projection's sections SHALL cover its corpus, with an explicit remainder,
so that no member is silently omitted.

**KF-SAS-RQ-115.** Context assembled for an agent SHALL be a projection subject to the same
invariants as a projection rendered for a person.

## 60. The projection grammar

A closed algebra over existing primitives. No expressions, no SQL, no user-supplied predicate:

- **filter** on object type, lifecycle state, classification (at or below), item state;
- **traverse** from an anchor along named relation types, bounded depth, declared direction,
  reusing the relation propagation classes;
- **group and sort** on declared fields;
- **sections** as ordered filter groups, under the coverage invariant;
- **typed parameters** declared in the ontology.

Budgets are part of the grammar, not an operational afterthought: maximum depth, maximum rows,
maximum runtime. A projection that cannot be bounded cannot be declared.

Enforced, since `0.1.0-draft.8`, at three points. The loader refuses any key the grammar does not
name, at every level, because a misspelt `max_detph` used to be dropped and leave an unbounded
definition reading as bounded. The compiler refuses a definition above the grammar's own limits
— depth 8, 100 000 members, 30 000 ms — as ONT-018, and requires a runtime budget on every
definition. And the engine turns that budget into a deadline checked per node walked and per
member placed, refusing an overrun as `budget_exceeded` rather than truncating it, and refuses a
definition that is not statically bounded, whatever produced it.

**KF-SAS-RQ-116.** The projection grammar SHALL be closed and non-executable, and every
definition SHALL be statically bounded in depth, size and runtime.

## 61. Object Views

ADR 0015. An Object View is a projection anchored at one object, over the reader's own corpus.

The family is generated from ontology metadata, so **every** object type is browsable with no
per-type code: overview, relationships at depth one in both directions — which yields backlinks
for free — provenance, history from audit events, documents, and the actions the ontology
declares for that type.

`GET /objects/:id` is the read. Adding a new object type to the ontology makes it browsable
without a UI change, and that is the acceptance test for the design — now a test in fact:
`tests/database/object-view-every-type.test.ts` creates a record of every declared type and reads
its view. The view labels an unverified record as every projection does (§59), and reads the
verification live rather than from the compiled record.

History is read by index. An object's history is every audit event naming it and every event of an
act that targeted it; the second leg used to walk the whole ledger, because `@>` on arrays is not
leakproof and row security therefore refused the index. `core.actions_targeting` answers the
lookup under the policy's own organization predicate and returns act ids only, the events being
read under the caller's row security, and the index no longer defers its entries to a pending list
every reader would scan (`20260925142200`, `tests/database/history-plan.test.ts`). The residual is
§100.36.

**Reading has no side effects** ([ADR 0033](../decisions/0033-the-database-binds-the-principal.md),
amending ADR 0015). A view is over the reader's master record, and when that record was absent or
stale the GET used to compile it — an audited act, which a cross-site link carrying the viewer's
cookie could trigger. `GET /objects/:id` now answers `409 master_record_stale`, and
`POST /objects/:id/refresh` compiles as an act, as the reader, and serves the view. The web
application issues that POST itself when the browser reports the navigation as the person's own
— same-origin, or typed and bookmarked, by `Sec-Fetch-Site`, and never a prefetch — and asks for a
click otherwise.

**KF-SAS-RQ-117.** Every object type SHALL have a read view derived from ontology metadata,
requiring no type-specific presentation code.

## 62. The master-record boundary

The invariant: `permission(O, C)` contains **only** rows materialized into KF-governed tables
and admitted by the active organization and classification context. No table is resolved live
from an external system.

`docs/architecture/master-record-boundary.json` is the machine-readable registry, and
`assertMasterRecordBoundaryComplete` runs it against every RLS-enabled table discovered from the
migrations. It refuses an **unclassified, stale, or multiply classified** table, so adding a
governed table without a boundary decision fails before compilation rather than quietly
enlarging or shrinking what a master record claims to cover.

Federated and object-store systems remain **source boundaries, not hidden members**. External
bytes enter a claim only after ingestion creates an RLS-governed artifact and version row and
the claim records that digest. A missing mirror is therefore not silently treated as complete.

`search.document` is classified separately, as a derived projection, and its exclusion is
explicit rather than incidental. Transient observations (§64B) are a third class in the same
registry, `transientTables`, each with its expiry, and
`tests/conformance/transient-observations.test.ts` holds every one of them out of the four places
KF-SAS-RQ-220 names.

**KF-SAS-RQ-118.** Every governed table SHALL carry an explicit master-record boundary
classification, and an unclassified table SHALL fail the build.

**KF-SAS-RQ-119.** No external system SHALL be resolved live into a master record; external
content SHALL enter only as a governed row recording its digest.

## 63. The withholding ledger

A master record states what was withheld and why, as a ledger rather than an absence. A record
that omits without saying it omitted is a record that cannot be reasoned about, and it is the
difference between "you have seen everything about you" and "you have seen everything you are
cleared for, and here is the shape of what you have not".

**KF-SAS-RQ-120.** A compiled record SHALL enumerate what was withheld from it and on what
basis.

## 64. Search

One index, many audiences. The alternative — an index per clearance — is several copies of the
records with several ways to drift.

So `search.document` is a derived projection, filtered at read time by the same context that
filters everything else, and rebuildable in full from authoritative rows. It is deliberately
outside the master-record boundary, and §62 states that exclusion explicitly.

**Visibility defers to the record, and once did not.** `search.document` denormalises
`organization_id` and `classification` so a hit can be filtered and rendered without joining back
for every row. Until `20260914000100` the read policy also *decided* on that copy — and the copy is
refreshed through the outbox, which states plainly that delivery "is allowed to be late". Late is
exactly what broke it: between a reclassification committing and the drain running, the index
evaluated the old level over `search.document.body`, which holds the assembled plaintext of every
controlled document. Nothing bounded that window and nothing measured it.

The repair is not a faster drain. A shorter window is still a window, and one measured in seconds
is harder to reason about than one that cannot exist. The policy now asks whether the record itself
is visible and lets `core.object`'s own row security answer, live, in the same statement. The
denormalised columns stay and no longer decide, so a stale copy can only make the index
under-inclusive — costing a caller a result until the next drain, and disclosing nothing. The
failure direction is safe by construction rather than by punctuality.

Found while specifying §64A, which avoids the same failure by holding no authorization input at
all, and fixed in the same revision that found it.

**KF-SAS-RQ-121.** Search SHALL use one index for all audiences, filtered at read time by the
same authorization context as every other read.

**KF-SAS-RQ-226.** A derived index SHALL NOT decide visibility from a denormalised copy of an
authorization input; the decision SHALL be taken against the authoritative record in the same
statement that reads the index.

## 64A. The retrieval index

A second derived index beside `search.document`, and the same bargain §64 already struck: one
index, many audiences, filtered at read time. [ADR 0028](../decisions/0028-the-retrieval-index-is-masked-not-copied.md).

The migration that built canonical search refused embeddings with reasons and named the condition
for revisiting — canonical search first, because an auditor asking for every record citing a
document needs an answer that is exhaustive and explicable rather than usually about right. That
condition is met. This section is that revisiting, not a reversal of it.

**Inside the trust boundary, outside the authority boundary.** An embedding index over restricted
records is itself restricted, so it cannot live where the kernel's rules do not reach. It is also
derived, disposable and rebuildable in full from authoritative rows, so it is never authoritative
for anything — KF-SAS-RQ-010 already says so and this section adds no exception. It is not a
neighbouring program under §104 and Law 1 does not apply to it.

**The role is named here; the implementation is not.** A specification that names an engine cannot
change engines without a revision.

**The index holds no record text and no authorization input.** No body, no title, no
classification, no metadata.

"Text" rather than "content", deliberately: §100.22 records that a vector is itself a degraded
reconstruction of what it was made from, so a prohibition on holding "content" would, read
strictly, forbid the index from holding the one thing an index is for.

**Holds, not sees — and the difference is not a quibble.** A vector is made from text, only the
engine has an embedder, and the Fabric holds the text. So record text necessarily *transits* to the
engine to be embedded. It is never persisted there, which is what RQ-213 forbids and what the word
"hold" means. The two are easy to conflate and the wrong one is the memorable one: "the engine
never sees our records" is false, and a later reader who carries that phrase away will reason from
it to a conclusion this document does not support.

**What makes that transit lawful is RQ-218, and the two requirements are incomplete alone.**
Controlled text may reach the embedder because the embedder is on the host and cannot be a remote
service. Without that guarantee this design would route controlled text to a component able to
forward it onward on the presence of an ambient credential, and every other control here would sit
downstream of that. RQ-213 governs what is kept; RQ-218 governs where it may go; neither is
sufficient by itself.

**Text supplied for embedding is not persisted, and the ordinary path is refused.** An engine
built to remember things will have a write path that stores the text it was given — that is what
such a path is for. Admitting controlled records through it would persist the text by default and
populate a lexical index the Fabric does not want populated, without anyone deciding to. The
Fabric therefore writes through a path that persists no text, and a controlled record offered to
the remembering path is refused rather than quietly stored. It holds what an index needs to rank — vectors, the identifiers they
belong to, and whatever positional bookkeeping the engine's own structure requires — and nothing
that would let a stale copy answer a question the kernel should have answered. Every hit is
resolved through the same grant check every other read surface performs (§27, ADR 0027) before it
reaches a person or an agent. An engine answer naming any record outside the mask, or naming a
record twice, is refused whole rather than shortened: a list with the bad identifier quietly
removed is a short list, which is what RQ-216 forbids.

Stated as two prohibitions rather than as a list of permitted fields, deliberately. An exhaustive
list makes a conformant engine non-conformant for a structural reason unrelated to authorization —
a slot-parallel array that the index needs to score positionally is not an authorization input, and
a specification that a correct implementation fails is worse than none.

**Where the version lives, and why the bitmaps do not.** The database holds one row per
organization recording a band version, moved by a trigger on every insert, reclassification,
organization change and deletion of a record. That row is a derived table, excluded from the
master-record boundary alongside `search.document`, and it is the only durable
authorization-related thing this design adds. The bitmaps themselves are built from it and from
the live records, per process, and are never written anywhere. Two other things the design stores
are not authorization inputs: `retrieval.embed_pending`, the derived queue of records awaiting
embedding (rebuilt by enqueueing every object again; a lost row delays one embedding and discloses
nothing, because the mask pads an unembedded record closed), and `retrieval.disclosure`, the
digests of what semantic answers disclosed (RQ-219), a transient observation under §64B.

**The version never repeats** (`20260925064100`). A derived row can be lost — a restore that
leaves it out, an operator who truncates it — and the next write recreated it at version 1, so the
counter climbed back through values it had issued, and a bitmap cached at one of them became valid
again over records reclassified since. The version is now the pair (epoch, counter): the epoch is
a fresh `uuidv7()` whenever the row is created and is never changed by a bump, so a recreated row
can issue no token equal to one issued before. A restore that brings back an *earlier* row, epoch
included, is the one way left to repeat a version; §100.29 records it.

**The band bitmap is memory-only.** It is a derived copy of an authorization input, and the only
thing that makes it safe is that it never outlives the process holding it and is re-derived per
query against a version token. Stating it separately (RQ-223) rather than leaving it to rest on
what "stored" means: a memory-mapped cache is both stored and not, and that argument should not be
available to anyone.

**These requirements bind the Fabric, not the engine.** Every requirement in this section is one
the Fabric must satisfy; where an engine's behaviour is what satisfies it, choosing and configuring
that engine is how the Fabric complies. No requirement here reaches into a peer program's
implementation, and none may.

**Authorization is computed per query from live rows and applied during scoring.** The kernel
derives band-membership bitmaps from the live records, versioned against both the classification
state and the index's own slot ordering, and the engine scores only unmasked slots. Masked records
are never scored rather than filtered afterwards, so a caller cleared for a small part of the
corpus receives a full result set rather than a silently short one. Because no authorization input
is stored, a reclassification takes effect on the next query: there is no refresh to schedule and
no window to bound.

**This is the property `search.document` does not have**, and the difference is the reason this
section exists rather than extending §64. That index carries a denormalised classification refreshed
by a worker that is permitted to be late (§100.20).

**A stale or mismatched mask fails closed, asymmetrically.** Slots are append-only and positional,
so a mask shorter than the index means the newest records are not yet authorized, and those slots
are excluded. A mask *longer* than the index is refused outright: that is not a stale bitmap but one
built against a different index, and scoring by a foreign ordering is not a degraded answer but a
wrong one. Treating both the same way and calling it safe is the failure this formulation exists to
prevent.

**Row-level security cannot substitute for the mask**, and this is worth stating because it is
counter-intuitive. Row policies filter rows; they cannot filter inside a precomputed approximate
index, whose structure is built over a fixed row set. Any design placing an approximate index
behind a row policy needs masked scoring or accepts silent recall collapse for the least-cleared
reader. That holds regardless of where the index runs.

**The Fabric composes rankings; it does not delegate retrieval wholesale.** Two ways to find a
record, and they fail differently. Lexical search answers "every record naming `SOP-QMS-012`" and
its answer is exhaustive — that is the property §64 exists for, and an auditor's question is not
answered by a ranking that is usually about right. Semantic search answers "records about this",
including ones that use none of the caller's words, and cannot be exhaustive by construction.

So the lexical index stays here (§64), the semantic ranking comes from the engine, and the compiler
presents both. Merging them into one order would destroy the property §64 was built for: a merged
list cannot show which results are the complete lexical answer, because a semantically near record
sits in the same list and looks identical. Composition keeps both — an auditor reads the lexical
ranking and knows it is complete; an agent reads both and gets the wider reach.

This also settles what the Fabric takes from a retrieval engine. Such an engine is a full suite,
and the Fabric uses the part of it the boundary permits and the Fabric lacks: semantic ranking over
vectors it holds. A lexical leg inside the engine would need a copy of the record text, which
RQ-213 forbids, so that leg stays here where the text already lawfully lives.

**A degraded engine refuses.** It never returns a short result set. Where the system falls back to
lexical search, the response records that semantic ranking was unavailable as a withholding-ledger
entry (§63) rather than a separate flag, because a ledger entry carries its basis and a boolean does
not, and an agent that cannot distinguish a degraded answer from a complete one acts on it as
complete.

**Near misses are a labelled, opt-in set.** This is an obligation on the projection the compiler
produces (§59, §60), not on how an engine ranks: an engine returns a ranked result and the
compiler decides what part of it, if any, is offered as adjacent rather than requested. Records
near a question but not asked for are returned only when the caller asks, are never merged into the requested result, and the scoring function that
selected them is named in the projection that used it — so changing how nearness is computed is a
visible event. The withholding ledger does not apply to them: an unauthorized record is never a
candidate, so nothing was withheld. Reporting a count of withheld near misses would disclose the
shape of a semantic neighbourhood that is unbounded and steerable by choice of query, which is a
materially worse bargain than §63's fixed-corpus disclosure.

**No controlled content leaves the host to be embedded.** The embedder is local, a non-local
provider resolving is a refusal rather than a fallback, and the binding is evidenced at
commissioning (§91).

**KF-SAS-RQ-213.** The retrieval index SHALL hold no record text and no authorization input, and
every hit SHALL be resolved through the same grant check as every other read before it reaches a
caller.

**KF-SAS-RQ-214.** Authorization for a retrieval query SHALL be computed from live records and
applied during scoring, and no derived copy of an authorization input SHALL be stored.

**KF-SAS-RQ-215.** A mask shorter than the index SHALL exclude the unaddressed slots; a mask longer
than the index SHALL be refused.

**KF-SAS-RQ-216.** A retrieval engine that cannot serve SHALL refuse, and a result produced without
semantic ranking SHALL record that in the withholding ledger.

**KF-SAS-RQ-217.** Near misses SHALL be returned only on request, as a separately labelled set,
naming the scoring function that selected them.

**KF-SAS-RQ-218.** Controlled content SHALL NOT leave the host to be embedded, a non-local
embedding provider SHALL be refused rather than used as a fallback, and the embedder binding SHALL
NOT be replaced by a differing identity while the process runs.

**KF-SAS-RQ-219.** The retrieval engine's trace SHALL be derived and disposable, and the record of
what was disclosed SHALL be held by the kernel as a digest of that trace.

**KF-SAS-RQ-223.** A band bitmap, ceiling, coverage set or derived scope tag supplied to the
retrieval engine SHALL exist only for the life of the process holding it, and SHALL NOT be written
to durable storage of any kind.

**KF-SAS-RQ-224.** The Fabric SHALL compose lexical and semantic rankings rather than merging them
into a single order, SHALL keep the lexical ranking exhaustive within its scope, and every result
SHALL name the ranking that produced it.

**KF-SAS-RQ-225.** Record text MAY transit to an embedder on the same host and SHALL NOT be
persisted by it; the Fabric SHALL write controlled records only through a path that persists no
text, and a controlled record offered to a path that would persist it SHALL be refused.

## 64B. Transient observations

Not every stored thing is a record or a rebuildable projection. A query log observes something that
happened once: it is not authoritative, and unlike `search.document` or the retrieval index it
cannot be recomputed from anything. Without a name for that category a later reader infers that
whatever sits outside the records is rebuildable, writes a restore procedure on that assumption, and
silently loses what was never recoverable. [ADR 0029](../decisions/0029-transient-observations-are-a-third-category.md).

| | Authoritative | Rebuildable | On loss |
| --- | --- | --- | --- |
| Record | yes | — | Law 6; never deleted |
| Derived projection | no | yes | rebuild it |
| Transient observation | no | no | expected |

Raw queries are transient observations rather than records, which is why Law 6 is untouched: a
query was never a record. They expire on a stated window, and **expiry means nothing unless every
copy expires** — so a transient observation is excluded from the preservation export, whose
retention is unbounded and would otherwise keep every search anyone ever ran; from the
master-record boundary; from checkpoint coverage, which signs state and would pin it
cryptographically; and from any backup retained past the window. Missing one of the four makes the
guarantee false.

What managers need from the log is an aggregate — which records recur in higher-clearance replays
of lower-clearance queries — and that aggregate is a durable record carrying a count of distinct
persons and never which persons. The log itself carries identity while it lives, because otherwise
the aggregate cannot distinguish many people wanting a record from one person wanting it many
times, and those mean opposite things. Reading the log with attribution is its own act requiring its
own grant.

The replay is structurally necessary rather than convenient: under §64A a masked record is never
scored, so the original query genuinely cannot know whether a withheld record would have ranked.
Only an unmasked run can, and only somebody cleared for those records may perform one. What was
withheld is computed at the replayer's ceiling and never persisted, because written down it becomes
a classified fact about records at whatever classification the writer guessed.

The signal is biased and the requirement says so. It measures demand from people who searched for
what they could not find; people who have learned the system will not help them stop searching, so
it decays toward zero exactly where the access problem is worst. A quiet report is not evidence of
no unmet demand.

**As built** (`20260925070000`, `20260925130200`). A query is recorded by a definer seam that takes
the organization, ceiling and person from the sealed context, and no application role writes any
table here. "Carries identity" is met by a keyed pseudonym rather than a person column: `asker_key`
is an HMAC of the person under a key in `search.asker_key`, which no application role can read,
and which rotates with the 90-day window and is swept like the log. Turning a key back into a
person needs the owner credential and a list of candidates — the "own act with its own grant" this
section asks for, in its narrowest form — and after the key is swept not even that. Every table is
swept at 90 days. A person lists and replays **their own** recorded queries
(`GET /search/recorded-queries`, `POST /search/recorded-queries/:id/replay`) through a seam that
recomputes the bound principal's key under every live key and takes no person argument; a replay
runs at their ceiling now, returns what the original ceiling withheld without storing it, and
counts each such record they may read once, for that pseudonym, into `org.access_demand`.

The replay by *somebody else* — somebody cleared higher re-running lower-cleared people's queries,
which produces the aggregate's strongest signal — is built as the aggregate alone
(`POST /search/demand/replay`; ADR 0029, amended 2026-09-24). The server re-runs the organization's
recorded queries asked below the caller's ceiling, at the caller's ceiling and grants, and counts
what each original ceiling withheld; the caller receives records they may read, each with its
count of distinct persons, and how many queries were replayed — never a query's text, its
recorded-query id or time, or its asker. Other people's recorded queries are never listed to
anyone, and no attributed read of the log is built: "its own act requiring its own grant" is met
only by the owner credential and a list of candidates, as above. §100.30 records the rotation's
cost: a person whose key rotated between two queries counts as two askers.

**KF-SAS-RQ-220.** A stored thing that is neither authoritative nor rebuildable SHALL be declared a
transient observation, SHALL carry a stated expiry, and SHALL be excluded from the preservation
export, the master-record boundary, checkpoint coverage and any backup retained beyond its window.

**KF-SAS-RQ-221.** Recorded queries SHALL be transient observations rather than records, and a
durable demand aggregate over them SHALL identify records and counts of distinct persons, never
which persons.

**KF-SAS-RQ-247.** A recorded query SHALL NOT be disclosed to anyone but its asker; a replay by
another person SHALL return only the aggregate.

How much of that may be told to the person who asked is [ADR 0037](../decisions/0037-what-a-query-withheld-is-a-count-within-your-ceiling.md)'s
answer, proposed and implemented: one count, `withheldCount`, of matching records at or below
their clearance that no grant reaches — something they could ask for — computed with the answer and
stored nowhere. Nothing above their clearance is counted, because a count above the ceiling proves
that such records exist and match; and no title, identifier or type of anything withheld is given.

**KF-SAS-RQ-222.** What a query withheld from a caller SHALL be computed on demand at the ceiling of
the person asking, and SHALL NOT be persisted; what remains withheld from that person SHALL be
disclosed to them only as one count of matching records at or below their ceiling that no grant
reaches.

---

# Part VII — Institutional acts and federation

## 65. Identifier allocation

ADR 0018. **An enterprise identifier is allocated by the registry, in the act that asks, and
never proposed.**

`core.allocate_enterprise_id` takes a row lock on `registry.identifier_sequence`, skips numbers
already occupied by seeded identifiers, allocates the next, computes the Damm digit, and writes
a ledger row in `registry.identifier_allocation`. The allocation and the act that caused it are
the same transaction.

Three properties, each deliberate:

- **There is no field to put a suggestion in.** A caller cannot choose, suggest or fabricate an
  identifier, because the request type has nowhere to say one. This is the refusal by
  construction that the OpenWarrant SAS §12.4 requires, and validation would have been the
  weaker answer.
- **Numbers already occupied are skipped, never reissued.** 68 identifiers were seeded into the
  quality registry before the allocator existed. They keep their numbers by being skipped.
- **The result comes back on a receipt.** Allocation needed a channel for an act to return
  something the caller did not supply, so the dispatcher grew a receipt reader that reads from
  what the act durably wrote, and is re-read on replay.

An undeclared namespace is refused by name rather than allocated speculatively.

**KF-SAS-RQ-130.** Identifier allocation SHALL be atomic with the act that requests it, SHALL
skip occupied numbers rather than reissue them, and SHALL be refused for an undeclared
namespace.

**KF-SAS-RQ-131.** An act SHALL be able to return a value it computed, read back from durable
state, and a replay SHALL return the same value.

## 66. Warrants

ADR 0019. **A Warrant is an institutional record here and a source record in Git.**

This is the federation case that matters most, because it is the one where two systems both have
a legitimate claim. OpenWarrant's Git repository is the Source Holder: it owns the atoms, the
contract revisions, the digests and their history. KF is the institutional authority: it
allocates official identity, and it records the organizational fact that a Warrant exists, is
authorized, and reached a conclusion.

`work.warrant` uses the OpenWarrant UUIDv7 **as** the object id, so the two systems name the
same thing. The §24 state dimensions map on: phase to lifecycle state; condition, outcome,
currency and standing as columns, because they are orthogonal and collapsing them into one enum
would lose the orthogonality that made them worth separating.

`work.warrant_contract_revision` is append-only and records the digest, basis and canonical
intermediate representation **as OpenWarrant computed them**. KF does not recompute a digest and
assert its own answer; that would be becoming a second authority for a fact Git owns.

`@kf/warrants` owns every §67 action name, in four groups: contract, execution, evidence and
terminal acts. Every one of them now performs a typed
write; the list of names accepted and audited without one is empty, and it is kept as an empty
exported constant rather than deleted, so that adding a name without a typed effect is a visible
change rather than an absence. Authorization requires a contract digest. Blocking and pausing
are permitted only in the phases where they mean something.

**KF-SAS-RQ-132.** KF SHALL be the institutional authority for a federated record without
becoming its Source Holder, and SHALL record the source system's computed digests rather than
substituting its own.

**KF-SAS-RQ-133.** A federated record's identity in KF SHALL be the identity the Source Holder
uses.

## 67. Publication

ADR 0021. A publication crosses the institutional boundary, so both halves are strict.

The institutional half already existed: `publish_document_view` requires an accepted, qualified
compilation run, an effective controlled document at or above the view's classification, and a
registered publication target. The public route serves only an Ed25519-signed manifest.

The storage half is the addition. A store may be declared **public** — meaning bytes written
there are outside the product-instance boundary. A publication target may name one, and a
trigger refuses a target naming a store that is not public. The act then writes exactly one
`public_copy` and verifies what landed; a copy that does not verify refuses the publication.

The database enforces the "exactly one" in two directions: a `public_copy` recorded by any act
other than `publish_document_view`, or into any store not declared public, is refused. A target
naming a store this instance cannot reach refuses the publication by name rather than publishing
a manifest without the bytes.

**Unpublishing is not a delete.** When the controlled document leaves `effective` — withdrawn or
superseded, both institutional acts — a trigger marks every public copy with a recorded
verification failure saying so. The public route already refuses. The bytes stay as evidence of
what was public, and until when.

**KF-SAS-RQ-134.** Publication SHALL write exactly one public copy, verified, and the database
SHALL refuse a public copy written by any other act or into any non-public store.

**KF-SAS-RQ-135.** Unpublication SHALL be a recorded state change over the published copy, and
SHALL NOT delete it.

## 68. External source holders

ADR 0022, deciding ADR 0009's deferred design in its narrowest form.

A Google Drive file enters by the **same path a local file does** — fetched, hashed, stored,
attached by `attach_evidence` — so nothing downstream learns that Drive exists. What is recorded
in addition is exactly what a local file cannot have:

- the file id and the **exact revision the bytes were read at**, as an external locator with
  authority `authoritative`: Drive holds the source, KF holds a copy;
- the **exporter identity**, because a Google-native document has no bytes of its own and
  `files.export` is a converter. Two exporters can differ the way two pandocs do, so the
  exporter is part of the record and not a default;
- the source's own media type and modification time.

A native document is exported at its head revision only, and a request for an older revision is
refused rather than exporting the head under an older label. The adapter is read-only by
scope and the test asserts that the only non-GET request it makes is the token exchange.

What was deliberately **not** built is as important. No federated source row, no `SourceReader`,
no drift-checking seam — because a Drive file is admitted once, as a copy, and if it changes
somebody ingests it again. The question ADR 0009 could not settle, what replaces a commit SHA
for a non-Git source, is therefore not answered because it is no longer asked.

**KF-SAS-RQ-136.** External content admitted as a copy SHALL record the source system, the exact
revision read, and the identity of any converter that produced the bytes held.

**KF-SAS-RQ-137.** A conversion that cannot be performed at the cited revision SHALL be refused
rather than performed at a different one under the cited label.

## 69. Federation adapters

`@kf/integration` holds federation adapters and dispatcher-governed integration effects. The
rule they implement is Law 1: an adapter brings governed metadata, a digest and a versioned
locator into KF, and the external system stays canonical.

`tests/integration/federation.test.ts` asserts the negative directly: the QMS stays canonical,
and this system cannot become a second authority.

**KF-SAS-RQ-138.** A federation adapter SHALL import governed metadata and a digest, and SHALL
NOT create a writable local copy that could diverge from its authority.

## 70. What KF refuses to be a second authority for

**70.1 Source Holders.** Git for Warrants and code; the QMS for quality records; the finance
system for its ledger. KF records that they exist and what their digests were.

**70.2 The identifier registry — with a stated leak.** ADR 0006 draws the boundary: the
Knowledge Fabric is the product, an identifier registry is one deployment's policy, and the
registry directory is the seam. `KF_REGISTRY_DIR` selects it, and it defaults to
`registries/openhuman` because that is the only instance that exists, not because it is
privileged.

The leak is stated rather than glossed, and it has moved since it was first written. Earlier
revisions said a different registry compiles and is then rejected by the database. Measured, it is
the other way round: `tests/ontology/registry-separability.test.ts` loads and packs a genuinely
different registry (`AC-` prefix, a different namespace set) through the same compiler, and the
database accepts its identifiers once its namespaces are seeded
(`tests/database/instance-identifier-namespace.test.ts`). What refuses it is `registry-check`, for exactly one
reason: `ontology/meta.yaml` still pins an `OH-` enterprise identifier pattern. The test lists every
file that still pins `OH-` in something executable, exhaustively both ways — `meta.yaml`, the two
generated artifacts compiled from it, and `packages/ontology-compiler/src/damm.ts`, which is a code
coupling rather than a governance one and also makes `registry-check`'s reject-vector gate vacuous
for any second registry.

Attempting to un-pin it produced the most instructive refusal in this repository. The `OH-`
prefix is part of an approved, signed R01 pack, and the conformance suite's preservation rule is
that an approved semantic cannot be redefined by an extension, ever. So un-pinning it is a
specification amendment requiring the pack owner — a governance act, not a refactor. **The
system refusing a developer the ability to do it quietly is the control working, not a defect.**
The change was reverted.

**70.3 The domain specification.** `OH-DOC-000002-1` defines the graph. This software implements
it and does not redefine it.

**KF-SAS-RQ-139.** The product SHALL be separable from any one deployment's identifier registry,
and where that separation does not yet hold, the specific coupling SHALL be recorded.

**KF-SAS-RQ-192.** The deploying organization's identity SHALL be configuration, and SHALL NOT be
compiled into the product's source.

## 71. The ML registry

`ml` holds append-only, privacy-minimal lineage: runs, typed metrics, run seals and signed
promotions. It is privacy-minimal by construction — it records what a model run was and what it
measured, not the data it saw.

Promotion of a regulated model is a human-only act (§22).

**KF-SAS-RQ-140.** Model lineage SHALL be append-only and SHALL record measurements and
provenance without the underlying data.

## 72. Secure objects

`secure_object` holds capabilities, authority keys, safe purposes and erasure records for
content that needs a stricter regime than classification alone provides. Capability issue is one
of the three mechanisms ADR 0016 folded into the access-grant view.

**KF-SAS-RQ-141.** Access to a secure object SHALL be by an issued, recorded capability with a
declared purpose.

## 73. Work control

`work` holds the path from a captured initiative to a closed project: initiatives, projects,
work packages, contractor work orders, execution, acceptance — and, since ADR 0019, warrants.

`tests/end-to-end/reference-scenario.test.ts` walks that whole path **through public actions
only**. There is not one fixture insert into a work or finance table in that file, and the
restriction is the test: a scenario that seeds its own state proves the reader works, not that
the writer does.

Until `0.1.0-draft.8` three work-control types had typed tables and no act to create them, so the
scenario seeded its engagement with an owner insert. An engagement is now recorded by
`record_engagement`, a milestone planned by `plan_milestone` and a deliverable defined by
`define_deliverable`, and `tests/conformance/create-act-coverage.test.ts` maps every type to its
create act; only the counterparty organization is still a bootstrap insert. An engagement also has
the lifecycle R01 declared states for and no transitions — activate, suspend, resume, close,
terminate, through dispatched acts (`tests/database/engagement-lifecycle.test.ts`) — and
`work.deliverable` holds the fields the ontology declares for a deliverable rather than the older
columns it predated them with, which are kept per row in `work.deliverable_retired_attribute`
(`20260925130100`). An engagement cannot be closed or terminated while a work order that is not
terminal references it, and no work order can be issued under an ended engagement — rule
KF-ENG-001, checked as the transition's precondition and again by the database
(`20260925142100`, `tests/database/engagement-lifecycle.test.ts`).

**KF-SAS-RQ-142.** The full work-control path SHALL be reachable through declared actions alone,
and an end-to-end test SHALL exercise it without direct table writes.

## 74. Product configuration and quality

`product` holds products, configuration items and baselines. `quality` holds controlled
documents, corrective actions, suppliers and training records. `engineering` holds decisions,
changes, requirements, risks and tests.

The same restriction as §73 applies to their end-to-end test, for the same reason. Until
`0.1.0-draft.8` it had an exception it did not state: the R01 product and quality records —
product systems, requirements, risks, tests, baselines, releases — had declared, required fields
and no table or act, so the only way one came to exist was an owner-credential insert of a title
into `core.object`, which is the privileged path KF-SAS-RQ-143 forbids. Each now has a typed row
(`20260925030100`) and a create act that writes it.

**KF-SAS-RQ-143.** Product configuration, quality and engineering records SHALL be governed by
the same object, act and audit model as every other record, with no privileged path.

---

# Part VIII — Interfaces

## 75. The HTTP surface

`@kf/api` exposes typed reads and typed actions. It holds no authority of its own: every write
is a dispatcher call, and every read binds the caller as a principal through
`core.bind_principal` with the attestation `kf-attestor` issued for that request (§17, §24). The
API names who is acting; the database decides whether that is anybody.

`tests/permissions/api-actions.test.ts` asserts the property that matters — **the API is not a
second way in.** Every refusal the dispatcher makes, the API makes, and nothing the dispatcher
refuses can be had through it.

The converse used to be claimed too — that the API makes no refusal the write path does not —
and the 2026-09-23 hardening made it untrue on purpose. The ingest surfaces refuse content that
must never enter (§48), a batch over its ceiling, and a sync over its limit; the action route
refuses an `effectiveAt` outside its bounds (§13); step-up refuses a money, release or
control-withdrawal act without a fresh strong authentication; the edge rate-limits. Each is an
**admission check on the request** — on what it carries, how much, when it claims to have
happened, how recently its bearer authenticated — and none grants, widens or substitutes for a
decision the write path makes. KF-SAS-RQ-150 is clarified in place to say exactly that. Its
identifier stands; the earlier wording was wrong about the design, not about a defect.

Notable reads: `GET /master-record` and `POST /master-record/compile`; `GET /objects/:id`, which
answers `409 master_record_stale` rather than compiling, and `POST /objects/:id/refresh` (§61);
`GET /objects/:id/access?person=`; `GET /documents/:id/source`; `GET /identifiers/:id`; the
signed public publication route.

**KF-SAS-RQ-150.** The HTTP layer SHALL hold no authority of its own; SHALL permit nothing the
write path refuses; and every refusal it makes that the write path does not SHALL be an admission
check on the request — its content, size, stated time or authentication freshness — that grants
and widens nothing.

## 76. The command line

`kf` is the operator and ingestion interface. `kf ingest` drives the planner and the typed
document actions. `kf:grant-authority` performs the three acts that used to stand between a
verified token and a usable session — link the subject to a person, assign a role, grant a
clearance — as one command that records a real act and extends the audit chain. The assignment
ends at `--valid-to`, at most 366 days away and one year by default, and `--renew` ends the live
assignment now and records a new one (ADR 0036, §18); `kf:declare-service-actor` defaults the same
way, which partly supersedes ADR 0020's "nothing defaulted" for the end date alone.
`kf:revoke-identity` withdraws one: given the link's id, or its issuer and subject, and a
required deciding person and reason, it records a `revoke_external_identity` act extending the
audit chain, sets the link's `revoked_at` in the same transaction, and withdraws every attestation
the person holds, so "revoked" means the next request is refused. A link already revoked is
refused, not re-recorded, and the row is never deleted — who could sign in as whom is a fact an
investigation needs. One consequence is deliberate and worth knowing: `(issuer, subject)` is
unique whether revoked or not, so a revoked account cannot be linked again, and a person who needs
access back is given a new account. Until this command the runbook's answer was an owner typing an
UPDATE, the one change to who can sign in as whom that the record would not show.
`kf:declare-service-actor` declares a service person (§21), and `kf:declare-agent` declares or
withdraws an agent client (§24).

Two rules the CLI enforces because they are cheap there and expensive later: **no inline bearer
tokens** — `--token-file` only, refusing `--token` by name, `kf master-record` included — and
refusals printed verbatim before any credential or database is opened. The owner connection
string the administrative commands use is a secret like any other, read from the file
`DATABASE_OWNER_URL_FILE` names; an inline `DATABASE_OWNER_URL` is accepted only when `NODE_ENV`
is `development` or `test`. KF-SAS-RQ-151 is met as stated. Since 2026-09-23 a token file must also be
owner-only, read through the same `readSecretFile` rule as every other secret, and
`scripts/deploy/login-token.sh` takes a password from the terminal without echo or from an
owner-only file, refusing it from the environment. What the CLI writes is as sensitive as what it
reads: a master record written with `--out` is created `0600`.

**KF-SAS-RQ-151.** Operator commands SHALL accept secrets only by file reference, and SHALL
refuse an inline secret by name.

## 77. The schema pack

The pack is the versioned contract between this software and the domain specification. Nine
files under one manifest: five compiled from the ontology, three carried forward byte-for-byte
from R01, and a generated README.

The manifest is appended last and **does not list itself**, because a file cannot contain its own
hash — so verifying the manifest is a separate act, which is signing it.

The manifest carries the schema version, the document identifier, the status, what it supersedes,
the ontology source digest, the defects it corrects, and its `known_gaps`. The gaps are written
into the manifest and the README so that **approving the package is an informed act**.

Approval is human-only (§22). An approval records a digest over a canonical payload — the
manifest digest, the time, the approver's name, role and statement, the signing key id, and the
accepted gaps. The gaps are signed too, because an approval that committed to the manifest but
not to the gaps could be re-presented as though the approver had seen a shorter list.

**KF-SAS-RQ-152.** A release package SHALL carry its known gaps, and an approval SHALL commit to
the gaps as well as to the content.

**KF-SAS-RQ-153.** A package manifest SHALL NOT contain its own digest, and verification of the
manifest SHALL be a distinct act.

## 78. R01 preservation

Two guarantees, and the second exists because the first alone was unworkable.

**Preservation.** Every R01 type, edge, action and definition still exists, byte-identical. An
approved semantic cannot be redefined by an extension, ever.

**Declaration.** Every addition is named in a declared-additions list. A new type appearing
without being declared fails, so growth is recorded rather than absorbed.

The assertion used to be equality. Equality makes extension impossible, and an impossible check
gets weakened under pressure — which is how a conformance suite quietly stops meaning anything.

The mechanics are strict in ways worth stating:

- the golden files are **never patched**; divergence lives entirely in the compiler's output;
- recorded divergences are a fixed, **exhaustive** enumeration — three schema extensions and four
  R01 defect corrections — and any new difference, in either direction, fails;
- only two enum paths may widen, and each widening must be a strict **superset**, because
  swapping one token for another would otherwise pass as "the enum changed";
- every divergence must have a rationale that literally appears in the ontology source.

This is the mechanism that refused the registry un-pinning in §70.2.

**KF-SAS-RQ-154.** An approved definition SHALL be preserved byte-identically, every addition
SHALL be declared by name, and every divergence SHALL be enumerated exhaustively with a
rationale.

## 79. The registry pack

A second, separate pack for the identifier registry, under a different document authority
(`OH-DOC-000001-3`) and checked by a separate command, because the two are different authorities
and a single check would let one vouch for the other.

It carries five known gaps, including two rules that are honestly **not machine-enforceable**:
R13's readability rule is unenforced by the document's own wording, and R14's prohibition on PHI
and secrets in identifiers is only partially covered by a credential scanner, which finds
credential shapes and cannot recognise PHI.

**KF-SAS-RQ-155.** A rule that cannot be machine-enforced SHALL be recorded as such rather than
presented as enforced.

## 80. Generated artifacts

Ten artifacts under `generated/`: JSON Schema, vocabulary, state machines, JSON-LD context,
SHACL, OpenAPI, TypeScript types, the SQL registry seed, reference documentation, and the
projection definitions.

Deterministic by construction: there is deliberately **no wall-clock timestamp** in any artifact,
because a timestamp makes every build differ and turns the drift check into noise. The source
digest answers the same question better.

CI regenerates and diffs. A hand-edited generated file is an ontology change nobody reviewed.

**KF-SAS-RQ-156.** Generated artifacts SHALL contain no non-deterministic content, and SHALL be
verified by regeneration in continuous integration.

## 81. The web boundary

`@kf/web` renders projection results generically (§59) and carries two identity profiles that
never fall back into each other (§24). It holds no business rules and makes no authority
decisions; `@kf/ui` states the same constraint for its components.

**KF-SAS-RQ-157.** The presentation layer SHALL contain no authority decision and no business
rule.

## 82. Agent tools

Eight reads and one rehearsal (§32). Stated as an interface because the shape is the guarantee:
there is no general write tool, and adding one would be an authority change.

## 83. Versioning and compatibility

The ontology carries a schema version, `1.2.0-draft.1` at this writing. The pack supersedes a
named predecessor. Digests are domain-separated by format tags — `kf-action-request-v1`,
`kf-projection-result-v2`, `kf-publication-v1` and the others §102 lists — so a format change is a
new tag rather than a silent reinterpretation of old bytes. `0.1.0-draft.8` exercised the rule
several times over: the audit chain's link became `kf-audit-link-v2` beside the `-v1` its recorded
links keep (§30), the projection result `-v2` (§59), the master-record payload and member `-v2`
(§58) and the document-parse receipt `-v2`, each recording per row or per manifest which format
it was computed under, so the old digests still verify as what they were.

**KF-SAS-RQ-158.** Every canonical format SHALL carry a version tag in its digest preimage, and
a format change SHALL produce a new tag rather than reinterpret existing digests.

---

# Part IX — Operations

## 84. The platform contract

**One platform: a GNU/FHS Linux host running systemd.**

The deployment artifacts are not portable to macOS, BSD, Windows, non-systemd Linux, or an
arbitrary container image. They rely on Bash with a GNU userland — `readlink -f`, `realpath -ms`,
`stat -Lc`, `find -printf`, `sha256sum`, `install` — and on FHS locations `/opt`, `/etc`,
`/var/lib`, `/run`, `/usr/bin`.

This is a trade, made deliberately. Portability was given up in exchange for being able to say
precisely what a host must provide, and then to check it. A contract that spans four platforms
is a contract that is verified on none of them.

**KF-SAS-RQ-160.** The deployment SHALL target exactly one declared platform contract, and SHALL
state it rather than implying portability.

## 85. Host requirements

The fact worth recording about the first six is that **every one was discovered by failure**, not
by design:

1. **pandoc**, in `/usr/local/bin`, `/usr/bin` or `/bin`, or at the absolute path
   `KF_PANDOC_PATH` names. The inherited `PATH` is deliberately not searched: a writable directory
   early on a service account's `PATH` would otherwise choose the program that parses evidence. A
   host without it answered every document import with HTTP 500. Undocumented until 2026-08-18.
   The version is deliberately unpinned (§52.3).
2. **A LaTeX engine** — `pdflatex`, from `texlive-latex-base`, `texlive-latex-recommended`,
   `texlive-fonts-recommended` and `lmodern` — for PDF rendering.
3. **python3**, on `PATH`. The fallback *is* the production path. Undocumented until 2026-08-20,
   the sixth of its kind, and found only by using a near-empty base image. A hosted runner with
   a fat default image would never have found it.
4. **Node.js** matching the engine range, as the real executable at `/usr/bin/node`. An `nvm`,
   `asdf`, shell alias or `PATH`-only installation does not satisfy the contract.
5. **bubblewrap** at `/usr/bin/bwrap`, with the kernel and unit qualified for the user, mount,
   PID, IPC, network, UTS and cgroup namespaces and the mount syscalls the worker permits.
6. **A PostgreSQL 18 client**, enforced by refusing any directory whose `psql`, `pg_dump`,
   `pg_dumpall` and `pg_restore` do not *all* report 18.

The 2026-09-23 hardening added three, and these were written down before a host needed them:

7. **gnupg**, because a backup is encrypted to a public key before it leaves the process that
   took it, and the drill decrypts it.
8. **rsync**, which ships the ciphertext off the host.
9. **The PostgreSQL 18 server binaries** `initdb` and `pg_ctl`, at `KF_POSTGRES_SERVER_DIR`, for the
   drill's throwaway cluster.

`scripts/deploy/provision-host.sh` creates the accounts, directories and generated secrets a
machine can create, and `--check` changes nothing and lists what only a person can supply, each
with the path it goes in. It is step zero of the host preflight (§91.3).

The general lesson is a requirement in its own right, because it is the reason five of the first
six were found late.

**KF-SAS-RQ-161.** Every host requirement SHALL be stated and probed, and provisioning SHALL be
exercised on a minimal image rather than on one whose defaults hide the dependency.

## 86. Release and promotion

The workstation build is promoted **byte-for-byte**. The private host does not run a build,
resolve a newer dependency, or substitute source from another checkout.

Installation is immutable: a release is installed at a new path, verified against its checksum
manifest, and `/opt/kf` is switched atomically. The previous release is retained for rollback.
Nothing is ever rebuilt under the live path.

Until `0.1.0-draft.8` the switch and the rollback were two sentences in the deployment document.
`scripts/deploy/install-release.sh` is those sentences made executable: `install` verifies the
release with `migrate-release.sh check`, records what it verified, and points `/opt/kf.previous`
at the live release and `/opt/kf` at the new one by `rename(2)`, so the live path never
momentarily does not exist, as it did under `ln -sfn`; `rollback` re-verifies the previous release
against its recorded digest before swapping the two. It changes files only — never a service,
never the database — because when an application-only rollback is allowed is a decision the
deployment document states, not one the script can make.

A release tree must not depend on anything outside itself, and the verifier must say so —
`tests/deployment/release-self-contained.test.ts` is the gate.

**KF-SAS-RQ-162.** The artifact tested SHALL be the artifact deployed, promoted without
rebuilding, and installation SHALL be atomic and reversible.

## 87. Services and timers

Each service has an unprivileged account (§37); the units are counted in
[`generated/measurements.md`](../../generated/measurements.md).

| Service | Does |
|---|---|
| `kf-api` | the API |
| `kf-attestor` | verifies a bearer token and vouches to the database that its person is present (§24); the API reaches it over a Unix socket only the two of them can open |
| `kf-web` | the web workbench |
| `kf-worker` | background work, including outbox delivery |
| `kf-migrate` | applies one verified migration set |
| `kf-checkpoint` | signs a Merkle checkpoint over the audit log |
| `kf-audit-verify` | verifies the audit log against every signed checkpoint, holding no signing key |
| `kf-storage` | replicates and re-verifies artifact copies, and collects and records orphaned evidence bytes (§49), as the storage service actor |
| `kf-backup` | takes and records a backup |
| `kf-backup-offsite` | ships the newest backup's ciphertext off the host and verifies it there |
| `kf-restore-drill` | as `kf-drill`, pulls the newest off-site ciphertext back, decrypts it, restores it into a throwaway PostgreSQL 18 cluster and proves it |
| `kf-readiness` | checks the system is in the state it is supposed to be in |
| `kf-alert-heartbeat` | proves the alert path still reaches a person |
| `kf-alert@` | reports that a named unit failed, to a person |

Timers: checkpoint hourly, readiness every fifteen minutes, backup, storage sweep, checkpoint
verification and alert heartbeat daily, restore drill monthly. A timer that stops firing is
noticed: each declares how long it may be silent, and `scripts/timer-liveness.sh` reports one
that has been silent longer.

Two of these deserve emphasis because they are unusual. **`kf-backup-offsite` verifies the copy
at the destination**, not at the source, because a backup verified only where it was written
proves the writer worked. And **`kf-alert-heartbeat` exists to prove the alert path itself**: an
alerting system that has never delivered an alert is an untested alerting system, and the first
real alert is a bad time to find out.

**KF-SAS-RQ-163.** Each service SHALL run under a distinct unprivileged account, sharing one only
where two units require identical secrets and identical data.

**KF-SAS-RQ-164.** The alerting path SHALL be exercised on a schedule independently of any
failure, and its delivery to a person SHALL be evidenced.

## 88. Backup and restore

Daily backup, off-site copy verified at the destination, monthly restore drill running the
shipped scripts. Backup scripts pass no password on a process command line;
`tests/backup-restore/script-credentials.test.ts` asserts it.

Three rules added on 2026-09-23, each closing a way a backup could exist without being one:

- **Encrypted before it leaves.** The archive is encrypted to a recovery public key before
  anything ships, and only ciphertext goes off the host; the off-site copy records its digest,
  re-measured at the destination, and the drill pulls back that exact object.
- **Local copies are pruned only once an off-site copy exists.** A backup whose only copy is on
  this host is never pruned, however old; free space is checked before one is taken.
- **A local path is not off-site** unless a person attested it as a separate physical failure
  domain. `ops.backup_copy.offsite_basis` records why a copy counts, from what the script did
  rather than what an operator typed.

And one found on 2026-09-24 that made every deployed backup fail, which is why it is stated as a
requirement below. **The backup is taken by a login holding only `kf_backup`**, as
`provision-host.sh` provisions it, and until `20260925130000` that login could not take one:
`pg_dump` locks every table whose definition it dumps, and `kf_backup` had no usage on `search`
or `retrieval` and no select on tables added since its grant, so the dump failed on its first
statement — while the restore drill, which ran the same script as the superuser, passed. Worse was
waiting behind that: a dump by a login row security binds reads only what policies admit, and
seventeen tables, `core.object` and `core.audit_event` among them, had no policy for the backup
login, so a dump that did run would have held no records at all. Now `backup.sh` passes
`--enable-row-security`; every table whose rows are dumped carries a policy letting `kf_backup`
read all of it, with no restrictive policy narrowing it; the tables whose rows are excluded —
transient observations (§64B), the seal key, attestations — are granted `MAINTAIN` only, enough to
take the lock and not to read; and `tests/backup-restore/drill.test.ts` runs the shipped script as
a `kf_backup` login, asserts no table is out of its reach, and asserts the export it takes holds
every object. A drill that runs as a more privileged login than the backup proves a different
backup.

Point-in-time recovery is available and **not the default posture**: `deploy/postgres/pitr.conf`
turns on WAL archiving for a deployment whose declared recovery objective requires it, and it
requires a restart because `archive_mode` cannot be reloaded.

One line in that file is a general lesson. The archive command is `test ! -f <dest> && cp <src>
<dest>`, and the comment states why `cp -n` is **not** a substitute: it exits 0 when it skips.
An archive command that reports success for a file it did not write is a backup that silently
has a hole.

WAL retention is deliberately not set there: WAL is deleted by oldest base backup, not by age,
because age-based deletion can remove the WAL a retained base backup still needs.

**KF-SAS-RQ-165.** A backup SHALL be verified at its destination, and restore SHALL be proven on
a schedule using the shipped procedure.

**KF-SAS-RQ-166.** An archiving command SHALL fail on a write it did not perform, and SHALL NOT
report success for a skipped file.

**KF-SAS-RQ-245.** A backup SHALL be taken by a login holding only the backup role, SHALL hold
every row the backup claims to include, and its restore SHALL be proven from a backup taken by
that same login.

## 89. Checkpoints

An hourly signed Merkle checkpoint over the audit log, produced by `apps/checkpoint` — a
**separate process precisely so the Ed25519 signing key is not reachable from the API**. It runs
in two modes, `--run` and `--verify`, so the same code that signs can check.

Host preflight includes proving that the API service account cannot read the private key.

**KF-SAS-RQ-167.** Audit checkpoint signing SHALL run in a process the serving application
cannot reach the key of, and that isolation SHALL be evidenced on the host.

## 90. Readiness and alerting

`kf-readiness` runs every fifteen minutes and checks the system is in the state it is supposed to
be in — not that it responds. §91.2 states the distinction that makes this worth having. Among
what it compares against what the release declares: the seeded ontology's digest
(`schema_release`, §45), the live planner settings (`planner_settings`, §40), row security against
the migrations' declared set (`row_security_reconciled`, §38), and the audit chain's links and
their formats (§30).

## 91. Commissioning

**91.1 The boundary.** `docs/deployment/private-host.md` is a deployment contract, and its own
first paragraph refuses to be read as anything else: it is not a production claim, a
commissioning record, or evidence of institutional readiness. A host may serve records only after
every required control has been exercised **with evidence from that host**.

**91.2 Availability is not approval.** The strongest sentence in the operational documentation is
the instruction never to treat service availability as institutional approval. A system that
answers requests has proven it is running. Whether it is authorised to hold records is a
different question and is answered by evidence, not by uptime.

**91.3 Preflight.** The numbered checks in `docs/deployment/private-host.md` before any shared
user is admitted — cited, not counted here, because they grow. They begin with
`provision-host.sh --check` exiting clean, and include: a valid bearer succeeds while a wrong
issuer, wrong audience, unknown subject and revoked identity all fail; fixed-identity headers are
ignored; the API account cannot read the checkpoint key; the API refuses to serve through a login
row-level security cannot bind, or one holding `kf_attestor` or `kf_service_actor`; and stopping
the attestor turns bearer requests into 503 `attestor_unavailable` — not 401, which would tell the
caller their token was refused, and not a request served by the API vouching for them itself
(§24). And then: **reboot the host and re-run them.** A
service that works only in the install shell is not deployed.

**91.4 What no check covers.** Recorded explicitly, because an earlier revision claimed blanket
coverage that was untrue of four items. Real-provider browser evidence has no check. Firewall
rules have no check. Filesystem denial of key access remains host evidence. And no person has yet
received an alert — there is no check for that, and none is possible from the repository.

**KF-SAS-RQ-168.** Commissioning SHALL require evidence produced on the host being commissioned,
and service availability SHALL NOT be accepted as evidence of authorisation.

**KF-SAS-RQ-169.** Controls that no automated check covers SHALL be enumerated as such.

## 92. Threat model

`docs/threat-model/` states controls as tables of *where* and *proven by*. That specificity is
what makes the document worth reading, and it is also a hand-maintained index into a moving tree.

So `tests/deployment/docs-references.test.ts` checks that every repo-relative path any document
cites **resolves**. A renamed test file does not break the build; it breaks the document,
silently, by leaving a claim pointing at nothing — and a control whose evidence cannot be found
is indistinguishable from one that was never true.

The test states its own limit, which is the honest thing to do: it checks the reference resolves,
not that the file says what the document claims. Reading those rows against their tests is human
review; the test automates the part that rots.

A path that resolves cannot catch a control that cites no path at all, and one did: a threat-model
row whose "Proven by" cell read `—` while a test had proved it all along.
`tests/deployment/threat-model-references.test.ts` now parses every table with a "Proven by"
column and requires each cell to name at least one backticked path that exists, or to say `same`
under a proven row of the same table, with a planted table that must yield exactly its three
findings.

**KF-SAS-RQ-170.** Every documented control SHALL cite the artifact that proves it, and a gate
SHALL verify that every cited path resolves.

## 93. What operations cannot supply

Three things that no amount of engineering in this repository produces, stated so that a plan
which assumes otherwise is recognisably wrong:

**93.1 A commissioned host.** Nothing here creates one. Four of the five v1.0 criteria queue
behind that single fact. ADR 0004's seven-day floor is waived ([ADR 0032](../decisions/0032-the-seven-day-floor-is-waived.md)),
so cutover is reachable on the day a host exists rather than a week after — at the cost of the one
condition that could observe a restart, a certificate rotation or a daily timer, which the
remaining three do not.

**93.2 Evidence from a real identity provider in a real browser.** The automated proof uses a
controlled OIDC fixture, which is the right tool for a regression test and is not evidence about
a production provider.

**93.3 An alert a person actually received.** The heartbeat proves the path can run. Only a
person confirming receipt proves it reaches them.

**KF-SAS-RQ-171.** Claims requiring host, provider or human evidence SHALL be marked as
outstanding until that evidence exists, and SHALL NOT be inferred from a passing test.

---

# Part X — Governance

## 94. Governance of this specification

**94.1** This specification is a controlled document of the Knowledge Fabric program.

**94.2** Accepted revisions are immutable. A revision records SHA-256 over this document's exact
bytes together with a snapshot of §106, and acceptance is performed by a human. An agent may
propose a revision of the document that governs it, and may not accept one.

**94.3** A revision that changes an architectural meaning, an authority boundary, a required
semantic, a state model or a compatibility guarantee requires a decision record (§96).

**94.4** Typographical, formatting and clearly non-semantic corrections use ordinary revision
history and do not require a new decision record. They still produce a new digest, and therefore
a new proposed revision.

**94.5** The official document identifier is allocated through the OpenHuman Identifier Registry.
Until then this file has no official enterprise identity, and its file name is not an allocation.
The Fabric can now allocate its own identifiers (§65); doing so for this document is a human act
and is deliberately outstanding.

**94.6** After acceptance, the accepted revision is normative. Every export, mirror and generated
copy states the exact revision it was compiled from and that revision's digest, and whether that
revision is accepted is read from its record under `docs/sas/revisions/`, never inferred from the
copy. Earlier wording said every copy states "the accepted revision", which the one generated copy
cannot honestly do: `docs/sas/generated/NORMATIVE.md` is compiled by `war compile` from the
document as it stands, which between a proposal and its acceptance is a proposed revision, and
`tests/deployment/normative-projection.test.ts` holds it to that document's digest and revision
record. KF-SAS-RQ-181 is clarified in place to say so. Where this document describes behaviour
the code does not have, the code is right and this document has drifted: the remedy is a new
revision, not an edit to the accepted one.

**KF-SAS-RQ-180.** This specification SHALL be governed by digest, its accepted revisions SHALL
be immutable, and acceptance SHALL be performed by a human actor.

**KF-SAS-RQ-181.** Every copy or export of this specification SHALL state the revision and digest
it reproduces, and SHALL NOT present a revision as accepted that its revision record does not
record as accepted.

## 95. Change procedure

1. Open a decision record stating the problem, the measurement and the options.
2. Propose a revision of this document; the proposal records the digest and the §106 diff.
3. Supersede or amend the Warrants the change affects.
4. Preserve the original requirement and its evidence history. A requirement that turned out to
   be wrong is superseded, never erased.

## 96. Decision records

The decision records in `docs/decisions/` — counted in
[`generated/measurements.md`](../../generated/measurements.md) — are the program's reasoning,
and this specification is downstream of them: where a section here states a rule, the ADR that
decided it says what was measured and what was rejected.

The supersession graph, which nothing else in the repository states in one place:

| Relation | Records |
|---|---|
| superseded | 0008 by 0011; 0009 by 0022 |
| partially superseded | 0004's licence half by 0005; the rest of 0004 stands |
| amended | 0011's identity key by 0013; 0004's seven-day floor, waived by 0032; 0015's read, which no longer compiles a stale master record, by 0033 |
| builds on | 0014→0013; 0015→0014; 0016→{0008, 0011, 0013}; 0017→{0004, 0006}; 0018→{0006, 0016}; 0019→0018; 0020→{0016, 0017}; 0021→{0006, 0016}; 0022→0009; 0027→{0011, 0016, 0025, 0026}; 0028→{0010, 0016, 0023, 0027}; 0029→{0016, 0024}; 0030→{0002, 0010, 0013, 0023, 0028} |
| supersedes a rationale rather than a record | 0028 supersedes the "no `pgvector`" reasoning in `database/migrations/20260811001800_search.sql`, on the condition that reasoning set |
| proposed, awaiting the owner | 0034→{0024, 0031}, 0035→{0020, 0033}, 0036→{0016, 0020} and 0037→{0027, 0029}, all implemented |

A superseded record is kept in full. ADR 0008 remains as the measured problem and the options
history even though its recommendation no longer applies, because deleting it would leave ADR
0011 asserting a fix to a defect nobody could read.

**KF-SAS-RQ-182.** Architectural decisions SHALL be recorded with their measurement and rejected
options, and a superseded record SHALL be retained in full.

## 97. The requirement ladder

**97.1** Each §106 row is one stable architectural requirement, referenced as
`sas://KF-SAS-RQ-<NNN>`.

**97.2** Identifiers are **append-only**. A row may be added and may be retitled. It may never be
removed or renumbered: a Warrant that implemented it would then reference nothing, and a
requirement that turned out to be wrong is evidence, not a mistake to be tidied away.

**97.3** Status is **derived**, never asserted here. What is satisfied is computed from the
Warrants and evidence that trace to each requirement. This document does not tick boxes, and the
absence of a status column in §106 is deliberate.

**97.4** Numbering leaves gaps between groups so a group can grow without renumbering.

**KF-SAS-RQ-183.** Requirement identifiers SHALL be append-only, and requirement status SHALL be
derived from evidence rather than recorded in this document.

## 98. Implementation phases

Eleven phases. Nine are delivered and two are not started, and the two that are not are the ones
that decide whether this is a system or a service.

Phases 0 through 6 correspond to the eight gates the repository has tracked since it was created;
phases 7 and 8 are the platform and institutional work of 2026-09; phases 9 and 10 are the v1.0
gate.

### Phase 0 — Repository, toolchain and local stack

Deliver:

- the pnpm workspace, TypeScript configuration and lint gate;
- a local PostgreSQL 18, object store and identity provider by compose;
- continuous integration running the same commands a developer runs.

Exit:

- a fresh clone reaches a running local stack and a green gate.

### Phase 1 — Ontology compiler and the R01 pack

Deliver:

- the YAML sources under `ontology/` as the canonical domain source;
- the compiler and its ten generated artifacts;
- the release pack, its manifest and its approval mechanism;
- R01 preservation with declared additions.

Exit:

- the ontology compiles, `generated/` reproduces byte-identically, and every approved R01
  definition is preserved.

### Phase 2 — The PostgreSQL authority kernel

Deliver:

- objects, actions, the audit chain and the outbox;
- row-level security on the object boundary, with policies scoped by organization and
  classification;
- the typed action dispatcher and its refusal codes;
- the registry mirror, so an undeclared token fails a key.

Exit:

- every planted violation in the kernel suite is refused, against a real PostgreSQL.

### Phase 3 — Evidence vault and preservation

Deliver:

- artifacts, versions and digest addressing;
- ingestion by copy or by reference;
- document parsing to atoms with recorded loss and parser identity;
- the preservation export, its closed inventory and its round trip.

Exit:

- an export imported into an empty database re-exports byte-identically.

### Phase 4 — Work control, product configuration and quality

Deliver:

- the path from a captured initiative to a closed project;
- products, configuration items and baselines;
- controlled documents, corrective actions, suppliers and training;
- separation of duty on the acts that judge other acts.

Exit:

- an end-to-end scenario walks initiative to closed project through declared actions only, with
  no direct table writes.

### Phase 5 — Search, federation and agent-safe interfaces

Deliver:

- one derived search index, filtered at read time;
- federation adapters that import metadata and digests without becoming an authority;
- eight agent read tools and one rollback-only rehearsal.

Exit:

- a federated record stays canonical in its own system, and an agent can determine what would
  happen without being able to make it happen.

### Phase 6 — Operational hardening

Deliver:

- the systemd units and timers, each under a distinct account;
- backup, off-site verification and the monthly restore drill;
- signed Merkle checkpoints from an isolated process;
- readiness checks and an alert path with its own heartbeat.

Exit:

- the shipped scripts restore a backup and prove it restored.

### Phase 7 — The corpus platform

Deliver:

- corpus identity for the master record, with truthful staleness;
- one projection engine, a closed grammar and pack-shipped definitions;
- Object Views for every object type from ontology metadata;
- access as a grant, with an explainable denial;
- storage locations, replication and verification.

Exit:

- a new object type added to the ontology is browsable with no presentation code, and a denial
  returns the path that caused it.

### Phase 8 — Institutional acts and external sources

Deliver:

- identifier allocation as an act, with a receipt channel;
- Warrants as institutional records while Git remains Source Holder;
- the act capability on institutional actions, and service actors barred from them;
- publication writing exactly one verified public copy;
- external Source Holders admitted per file with revision and exporter recorded.

Exit:

- the Fabric allocates a real enterprise identifier for a record whose bytes another system owns,
  and records the act.

### Phase 9 — A commissioned host and its operating evidence

Deliver:

- a production database and a migrator credential, created by a human decision;
- the release promoted byte-for-byte onto a host meeting §85;
- host preflight completed after a reboot, with evidence from that host;
- a real identity provider, TLS termination, key custody and an alert a person received.

Exit:

- the Fabric serves records from a commissioned host, and every control in the deployment
  contract has been exercised with evidence from it.

### Phase 10 — v1.0

Deliver:

- the parity window run to its declared floor on the commissioned host;
- an accepted cutover;
- a signed, approved schema pack in sync with the ontology it describes;
- a green continuous-integration run on the tagged commit.

Exit:

- every criterion in the v1.0 decision record is met, and the tag is cut.

## 99. System acceptance criteria

The Knowledge Fabric is acceptable when:

1. no controlled change can exist in a commit without a matching act and audit event;
2. an unbound connection reads nothing;
3. a caller cannot bind a classification ceiling higher than recorded clearance allows;
4. a person with clearance and no grant has an empty corpus;
5. every refusal carries a named code, and no refusal surfaces as an untyped error;
6. a retried act applies at most once, and its replayed receipt is re-read rather than rebuilt;
7. the audit chain verifies independently of the process that wrote it;
8. an institutional act is refused to a service actor whatever grants reach it;
9. an allocated identifier can never be named, suggested or influenced by its requester;
10. an unchanged corpus compiles to the same master record;
11. every reading of a corpus is a declared projection, its members a subset of that corpus;
12. every governed table carries an explicit master-record boundary classification;
13. an export imported into an empty database re-exports byte-identically;
14. a version's bytes are servable from a verified secondary copy when the primary fails;
15. a public copy exists only where a publication act put it, in a store declared public;
16. unpublishing, revocation and supersession leave the record in place;
17. every approved R01 definition is preserved byte-identically and every addition is declared;
18. `generated/` reproduces byte-identically from its source;
19. an external record's Source Holder is unchanged by KF recording it;
20. an external copy records the exact revision read and the converter that produced it;
21. every documented control cites an artifact, and every cited path resolves;
22. every host requirement is probed, on a minimal image;
23. restore is proven on a schedule using the shipped scripts;
24. an alert path is exercised independently of any failure;
25. every gate can be made to fail by a planted violation of the thing it checks;
26. a known gap is enumerable rather than an inline marker;
27. a human-only act cannot be performed by any automation in this repository;
28. this specification's accepted revision matches the bytes it governs.

## 100. Known gaps and accepted limits

Recorded here so that accepting this specification is an informed act, and so that §12's third
kind of claim has one home.

**100.1 The distributed validator checks three declared rules.** Narrowed in `0.1.0-draft.8`,
which first stated it as "six invariants exist only in prose". Every declared invariant is now
enforced in the database or the dispatcher, each with a planted test (§42,
`tests/database/rule-ledger.test.ts`). What remains is the R01 pack's `validate_graph.py`, frozen
byte-identical with the release, which checks KF-GRAPH-001, KF-FIN-001 and KF-FIN-003 and nothing
else; a consumer validating a graph offline with it gets no other rule, and it does not check
relation endpoint types either (§100.2). Changing it is a pack re-cut and a human signature. Bears
on KF-SAS-RQ-078.

**100.2 Relation types declare no source or target types — closed.** Closed in `0.1.0-draft.8`:
the ontology declares both ends of every relation, the compiler refuses one that omits either, and
the database refuses an edge of an undeclared shape (§35, `20260925030300`, KF-SAS-RQ-244). What
remains is §100.1's: the frozen `validate_graph.py` does not check endpoint types. Bears on
KF-SAS-RQ-070.

**100.3 The product/instance seam holds everywhere but one approved pin.** Narrowed in
`0.1.0-draft.8`, which found the old wording backwards (§70.2): a different registry compiles, and
the database accepts its identifiers once its namespaces are seeded; `registry-check` refuses it,
because `ontology/meta.yaml` pins `OH-` in an approved pack. The remaining pins are that file, the
two generated artifacts compiled from it, and `packages/ontology-compiler/src/damm.ts` — the last a
code coupling that can be fixed without the pack owner, the others not. Bears on KF-SAS-RQ-139,
and §70.2 explains why un-pinning `meta.yaml` is a governance act.

**100.4 Replication and verification are not scheduled anywhere.** The service and timer exist;
no host runs them. Bears on KF-SAS-RQ-097.

**100.5 Store addresses are bound by whoever presents them first.** Narrowed in
`0.1.0-draft.8`, which first recorded that the checkpoint runner and ingestion addressed the
working store directly. The checkpoint runner never did — its anchor bucket is not an artifact
store — and every process that holds a store now resolves it against its declared row and binds an
address through one seam that never rebinds (§50, `20260925160000`). Until then nothing but tests
had declared a `durable` store, so replication into one would have failed on a foreign key. What
remains: the first process to present a store's address binds it, and nothing checks that address
against an approved one; and the checkpoint anchor bucket is outside the registry by design. Bears
on KF-SAS-RQ-095 and RQ-249.

**100.6 Two schema packs are signed snapshots that no longer describe their source**, admitted
with reasons, and one registry pack is in the same state. Each is an admission that a re-cut and
a fresh human signature are owed. The `0.1.0-draft.8` ontology changes — observations, relation
endpoints, the product, quality and work-control create acts, the engagement lifecycle — widen the
first of those gaps; the re-cut is `pnpm ontology:pack 1.0.0-draft.5`, and the signature
(`pnpm ontology:approve release/knowledge-fabric-1.0.0-draft.5`) is the owner's.

**100.7 Three ML policy predicates are unmeasured — closed.** Closed in `0.1.0-draft.8`: measured
with rows by `tests/database/rls-read-cost.test.ts`, the figures in ADR 0007's dated section, none
near the 950 ms of their sibling (§39). Bears on KF-SAS-RQ-075.

**100.8 Delegation depth is unbounded — closed.** Closed in `0.1.0-draft.8`: the database
refuses a delegation of a delegated role assignment or access grant
([ADR 0036](../decisions/0036-delegation-is-one-level-and-assignments-expire.md), proposed and
implemented; §18, `20260925153600`). Bears on KF-SAS-RQ-039 and RQ-246.

**100.9 Role assignments and project memberships do not expire — closed.** Closed in
`0.1.0-draft.8`: every new one ends within 366 days, renewal being a new attributed assignment
(ADR 0036, §18, §76). What remains is what was made before the rule: those rows are grandfathered,
and readiness reports each as having no review date until it is renewed. Bears on KF-SAS-RQ-246.

**100.10 No host has ever been commissioned.** Phase 9 is not started. Four of the five v1.0
criteria queue behind it, and one carries a floor that cannot begin counting until it exists.

**100.11 Continuous integration has never been green on a tagged commit**, which is a v1.0
criterion in its own right. The criterion now covers this document too: a `sas` job runs
`war check --generated` on every change, so `docs/sas/generated/NORMATIVE.md` drifting from a
fresh compile fails the build, and an error passes only while `docs/sas/owner-pending.json` names
that exact rule and file and its review date has not passed.

**100.12 Cross-repository requirement resolution does not exist — closed.** Closed in
`0.1.0-draft.8`: `scripts/resolve-sas-citations.mjs` resolves every `KF-SAS-RQ-NNN` citation in
any tree against `docs/sas/generated/NORMATIVE.json`, reports one no revision has ever held as
unresolved and one a revision once held as retired, and refuses to report success when it found
no citation at all. A citation it has not been run over is still a claim; KF-SAS-RQ-184 stands.

**100.13 The release pack asserts its own manifest is unsigned** even after signing, because the
gap list is composed at build time and travels into the approval unchanged. Cosmetic, and
recorded rather than quietly corrected.

**100.14 This program's verification independence is nil.** All nine dimensions are recorded
`false` in `openwarrant.toml`. This repository is authored and verified by one person working
with one agent. Role separation by one person is not organizational independence, and an absent
field would read as unexamined where `false` reads as examined and absent.

**100.15 Forcing row-level security was decided, and is done.** Recorded here on 2026-09-04 as
seventy-three tables that enabled row-level security without forcing it, with the question left
open whether forcing should reach the domain tables. The 2026-09-23 red-team pass answered it:
the gap was the whole of what stood between a login inheriting the schema owner and every tenant's
rows. `20260924000200` forces every table that enables it and refuses to complete otherwise, and
`tests/database/row-security-forced.test.ts` gates the future; KF-SAS-RQ-239 states the rule. What
remains is a runtime measurement on a host after that migration, which none has had (§38).

**KF-SAS-RQ-184.** A requirement cited from another repository SHOULD be resolvable against this
document by a tool, and until it is, such a citation SHALL be treated as an unverified claim.

**100.16 The organization's legal name is compiled in, not configured — closed.** Closed in
`0.1.0-draft.8`: the dogfood bootstrap reads it from `KF_ORGANIZATION_LEGAL_NAME` and refuses to
start without it, and `apps/api/src/dogfood/legal-name.test.ts` refuses the name reappearing in
source. Bears on KF-SAS-RQ-192; §100.3 is what remains of the deployment's identity in the
product.

**100.17 The phase ladder is full against a hard cap.** §98 uses phases 0 through 10, and the
tooling that reads them caps a phase number at 10. A twelfth objective — a data-primitives phase,
for instance — cannot be added without restructuring the ladder. Recorded rather than worked
around, because renumbering objectives would break every reference to them.

**100.18 Two of ADR 0024's latency bars are unmeasured, no bar has a commissioned host's figure,
and there is no chat integration.** Narrowed in `0.1.0-draft.8`, which first stated that none was
measured and that the cheap capture path and the web capture form did not exist. The capture path
exists — `observation`, `POST /capture/observation`, `kf note`, the web capture form, one act each
([ADR 0034](../decisions/0034-an-observation-is-captured-then-promoted.md), proposed; §8A) — and
three of the five bars are measured by `scripts/latency-bars.mjs`, each within its bar on the
newest run (the object view only after its payload was read in one pass, §58). Still open:
recording an observation from intent to durable and attaching evidence are unmeasured, the first
because it includes a person; every recorded run is a workstation's; and there is no chat
integration. Bears on KF-SAS-RQ-200 through RQ-203.

**100.19 How an agent authenticates when acting for a named human is undecided — closed.** Closed
in `0.1.0-draft.8` by token exchange, the attestor's check of the `act` claim, declared agents and
`core.action.agent_participation` written by the database (§24,
[ADR 0035](../decisions/0035-an-agent-acts-for-a-named-human.md), proposed; `20260925100000`).
KF-SAS-RQ-204 is implemented; the decision awaits the owner.

**100.21 The retrieval architecture is built on the Fabric's side and largely unbuilt on the
engine's.** First recorded as "specified and largely unbuilt, on both sides": seven items, counted
rather than described, so that a later reader could tell a specified capability from a shipped
one — in the engine, a mask predicate of tenancy rather than clearance, no entry point for an
externally supplied mask, no socket server, no encryption at rest, and no write path storing a
vector without its text; here, no band-bitmap builder and no embed-on-ingest path.

Narrowed in `0.1.0-draft.8`: the Fabric's two items are built. The band-bitmap builder derives
masks per query from live rows (`@kf/retrieval`, over the band version of `20260914000200` and its epoch,
§64A); embed-on-ingest queues every record an act touched and a worker pump hands its text to the
engine's vectors-only path outside any transaction (`20260925071000`); the compiler composes the
two rankings, re-checks every engine identifier under the caller's grants, refuses an answer
naming anything outside the mask, records the disclosure digest and counts what was withheld
(§64A, §64B). What remains is the engine's, restated against what the Fabric now calls: a socket
server; slot addressing; a `write_vector` path that stores no text; a mask entry point with a
`none` ceiling; a capability handshake; a ranking that names itself and returns a trace digest; an
engine-side embedder pin; and encryption at rest. Until they exist the composed answer is the
lexical ranking with a withholding-ledger entry saying semantic ranking was unavailable, which is
RQ-216 working.

KF-SAS-RQ-218 is the exception and is noted as such: the engine refuses a non-local embedding
provider by default as of 2026-09-14, before this requirement was proposed. A requirement with a
conformant implementation already behind it is unusual here and worth marking, because the rest of
this section describes the opposite.

**100.22 Vectors are readable in the serving process.** Encryption at rest makes a stolen index
inert; it does not protect a running one. Anyone who can attach to the retrieval process or read a
core dump reconstructs a degraded version of everything embedded, and sentence embeddings invert
well enough for that to matter. This is the irreducible floor of performing compute outside the
kernel and no design removes it. Recorded as an accepted limit rather than left to be discovered.

**100.23 The demand aggregate is fed only by people replaying their own queries, and has a known
bias.** Narrowed in `0.1.0-draft.8`, which first stated that nothing recorded queries, expired them
or computed the aggregate. Queries are now recorded pseudonymously (`20260925070000`), every
transient table is swept at 90 days, and a person's replay of their own recorded query counts what
it recovers into `org.access_demand` (§64B), and somebody cleared higher replays other people's
queries server-side for the aggregate alone (`POST /search/demand/replay`, §100.31). The bias
stands: the aggregate measures demand only from people who searched for what they could
not find, so a quiet report is not evidence of no unmet demand. Bears on KF-SAS-RQ-220 through
RQ-222.

**100.24 No objective after v1.0 can be scheduled.** §98 numbers phases 0 through 10 and phase 10
is v1.0, while the roadmap reference grammar bounds a phase number at 10 — a constant derived from a
neighbouring program's own phase count and applied to every program that uses the scheme. So the
ladder is not merely full: nothing after v1.0 has a number, including the retrieval work in §64A.
Renumbering would cost every existing reference and buy one slot. Supersedes the narrower reading in
§100.17, which described this as a twelfth objective being unaddable.

**100.26 Verification is recorded, and labelled everywhere a record is shown; its basis is paced,
not proven.** Recorded first as "verification is not recorded anywhere", and before that as
"the draft lifecycle is a label", which `0.1.0-draft.6` corrected — `draft` is the initial state of
only some state machines, so lifecycle could never have carried this. Since `20260918000100`,
`core.object_verification` holds whether a record has been verified, by whom, by which act and on
which basis, beside the record rather than in it; absence is the unverified state. The master
record's rendering marks an unverified member, the preservation export carries verifications, and
since `20260920000100` an unverified record cannot be cited as evidence, however its id is wrapped.

Since `20260924000300` the basis is checked as well as recorded. `verified_at` is the database's
clock whatever the insert said; a second `reviewed_individually` by one verifier within
`core.individual_review_interval()` (one second) is refused; and `POST /verifications/bulk` stamps
`promoted_in_bulk` itself, so promoting many records has a supported path with no reason to
misdeclare. The pace makes a false claim of individual review slow and attributed, not impossible:
a script waiting more than a second between records can still make it.

The labelling half is resolved in `0.1.0-draft.8`, which first recorded it as outstanding:
`@kf/projections` carried no verification state, so a projection other than the master record's
own rendering did not label an unverified member. Every projection member now carries its
verification and the engine refuses one unlabelled as `unlabelled_member`, under
`kf-projection-result-v2` (§59); the Object View, every agent read and every search hit say the
same, read live; and a record whose verification the reader cannot see is labelled "no
verification is visible to this reader". What remains is the first paragraph's: a paced basis is
not a proven one. Bears on KF-SAS-RQ-229 and RQ-231.

**100.25 The composed ranking is unmeasured.** §64A composes a lexical ranking from this
repository with a semantic ranking from an engine tuned against a different lexical leg, on public
corpora with no clearances. The engine's published numbers therefore say nothing about how the
composition behaves here, and nothing yet measures it. Stated because the same transfer argument
decided against porting the engine onto this database, and it points at the Fabric as readily as it
pointed there. Bears on KF-SAS-RQ-224.

**100.27 Some digests are still not domain-separated as KF-SAS-RQ-016 requires.** Found while
reconciling §102 for `0.1.0-draft.8`, as two: the audit chain's link digest, with no format tag in
its preimage (`kf:audit-chain:v1`, which earlier revisions listed as its tag, is the key of the
advisory lock that serializes appends), and the access explanation's, tagged but taken over
`JSON.stringify` rather than RFC 8785. **Both are resolved in the same draft**: new links are
`kf-audit-link-v2`, the recorded ones labelled `-v1` and verified under it (§30), and the
explanation is `kf-access-explanation-v2` over RFC 8785.

Looking for the two found the rest. Production source now takes a digest through `taggedDigest`,
which puts the tag in the preimage, and `tests/conformance/digest-tags.test.ts` finds every other
way a SHA-256 is taken and requires each to be listed with its reason — raw bytes, self-tagged,
equality, a legacy format recorded rows are verified under, a protocol constant, a secret — so a
new untagged digest cannot land silently and the list can only shrink. Its `UNTAGGED` entries are
the work left, enumerated there and not here: the request digests of the owner-credential
administrative acts (hand-built strings, or `JSON.stringify` rather than RFC 8785); the AI
planner's instruction and content digests; the document compiler's protocol digests, which are
exchanged with the Liminal compiler and need a `kf-document-v1` protocol bump agreed with it; the
master record's corpus and permission line digests, reproduced in SQL; the master-record link
payload digest, over `JSON.stringify`; the ML registry's sub-digests inside its
`schemaVersion`-tagged receipts; and the ontology and registry source digests in the generated
packs. Each is a format change with a new tag where rows already record the old one. Bears on
KF-SAS-RQ-016 and RQ-158.

**100.28 The owner has not confirmed KF-SAS-RQ-038's reading.** `0.1.0-draft.8` clarifies it in
place from ADR 0011's rule — the effective ceiling is the minimum of the clearance and any
assignment ceiling — to what the code does under ADR 0027, accepted on 2026-09-11: the session
ceiling is the person's clearance, and an assignment ceiling caps only the read grant that
assignment confers (§17). The conformance audit recommended amending this document rather than the
code, because ADR 0027 is the later accepted decision and nothing widens under it. But the
requirement is the owner's, and a clarification that changes which of two rules a requirement
states is a decision, not a correction. Until the owner confirms it — by accepting this revision,
or by saying otherwise, in which case the code changes — this reading is the author's. Bears on
KF-SAS-RQ-038.

**100.29 A restore can bring back an earlier band version.** The band version is an (epoch, counter)
pair so a lost row can never reissue a version (§64A), but `retrieval.band_version` is included in
a backup, and a restore from one, or a point-in-time recovery, brings back an earlier row with its
epoch. The counter then climbs back through values issued after the backup under the same epoch,
and a bitmap cached at one of them in a process that outlived the restore becomes valid again.
Masks are memory-only (RQ-223), so restarting every process that holds one is the remedy, and the
restore procedure does not yet say so or force it. Bears on KF-SAS-RQ-214 and RQ-223.

**100.30 A key rotation splits one asker into two.** The demand aggregate tells many people from
one person by the pseudonym `asker_key` (§64B), and the key rotates with the 90-day window. A
person whose queries straddle a rotation is two askers to the aggregate, so a record's
distinct-person count can overstate its demand by the number of people who asked across a
rotation. Accepted as the cost of a pseudonym that expires; bears on KF-SAS-RQ-221.

**100.31 Nobody can replay another person's query — closed.** Closed in `0.1.0-draft.8` by the
aggregate-only replay (§64B, `POST /search/demand/replay`, ADR 0029 amended 2026-09-24): the
server re-runs lower-cleared queries at the caller's ceiling and returns records and distinct-person
counts, never a query or its asker. Listing another person's queries is deliberately not built,
and ADR 0029's "its own act requiring its own grant" for an attributed read is met only by the
owner credential. Bears on KF-SAS-RQ-221, RQ-222 and RQ-247.

**100.32 An archive exported before `20260925130100` is not shown to restore — narrowed.**
Narrowed in `0.1.0-draft.8`: an archive carrying `work.deliverable`'s old columns is converted on
import as the migration converted it, and a format-2 archive written before any of the forty-one
sections `section-eras.ts` names — every section added since the format went to 2 (bffc6739,
2026-08-15) — restores (`tests/round-trip/deliverable-upconversion.test.ts`, §56). Each name is
checked against the migration that created its table, and every such table was created in the commit
that added its section; none was renamed from an earlier section. For thirty-eight the migration
created the table empty and seeded nothing, so absence means no rows (access grants included:
`20260902000100` presents role assignments through a view and copies none). For
`deliverable-retired-attributes` the rows come from the old `deliverables`, above; for
`artifact-stores` and `artifact-locations` absence does not mean none either: `20260902000200`
declared the `working` store and recorded every addressed version's working location, and the
importer does the same from the archive's `artifact-versions`; the store's `declared_at` is the
restoring database's, because the archive predates the row. A section's absence is accepted only
together with the sections that arrived in its commit and every section after it. A format-1 archive
is not refused outright, as this entry said: the verifier requires `allowUnsignedLegacyV1` with a
warning, deliberately, because a format-1 manifest has no signature, and with it the importer's
format-1 path runs (`tests/round-trip/export.test.ts`). A role a later migration seeded is kept
when the archive predates it — `20260911000100`'s `customer_contact` and `partner_contact` — because
the restore adds back any seeded role the archive's roles lack. What remains: the tests cut an old
archive from a current one by removing sections and rewriting `deliverables`; they do not revert the
columns later migrations added to sections that already existed. Bears on KF-SAS-RQ-104 and RQ-248.

**100.33 Agent declarations do not travel in the export.** `org.declared_agent` is left out of
the canonical export by design — a restore target has its own realm and its owner declares its own
agents — and the participation each act recorded does travel, in `actions.json`. The consequence
is operational rather than evidential: after an import, no agent can act until the owner declares
it again. Recorded so that a restore runbook does not discover it. The backup, which restores this
host rather than seeding another, does carry them (`20260925135000`). Bears on KF-SAS-RQ-103 and
RQ-204.

**100.34 Closing an engagement does not check its work — closed.** Closed in `0.1.0-draft.8`
by rule KF-ENG-001: an engagement cannot close or terminate while a non-terminal work order
references it, and no work order is issued under an ended engagement — a precondition, and a
database trigger behind it (§73, `20260925142100`). The domain decision the entry named is the
author's and is the owner's to confirm with this revision. Bears on KF-SAS-RQ-142.

**100.35 Compilation is checked for reproduction, not proven deterministic.** A requalified
compiler's run that fails to reproduce an earlier run over the same sources is refused (§54), but
nothing re-runs the compiler on a schedule to test determinism, so a nondeterministic compiler is
caught only when something happens to compile the same sources again; and the views a refused run
materialized stay in the store, unreferenced.
Bears on KF-SAS-RQ-102.

**100.36 A history read still pays the audit policy per event.** The ledger lookup is by index
(§61, `20260925142200`); the audit events it leads to are read under `core.audit_event`'s row
security, whose object check grows with the corpus, and no commissioned host has measured it.
Bears on KF-SAS-RQ-117.

**KF-SAS-RQ-186.** The set of tables forced under row-level security SHALL be derivable from the
migrations, and any difference between that set and the running database SHALL be reconciled.

## 101. Refusal vocabulary

The named refusals a caller may encounter, gathered so that "what can this system say no with" is
answerable in one place. The dispatcher's thirteen codes are in §28. Beyond them:

| Refusal | Raised by |
|---|---|
| `unknown_subject` | an authenticated identity not linked to a person |
| `not_attested` (HTTP 401) | `core.bind_principal`, on a read or a write, when no current attestation from `kf-attestor` matches the principal (§24) |
| `attestor_unavailable` (HTTP 503) | the API, on every bearer request, when `kf-attestor` cannot be reached, does not answer in time or answers 5xx; nobody is bound and nothing falls back (§24) |
| `undeclared_agent` (HTTP 401) | `kf-attestor` and `core.issue_attestation`, on a delegated token naming a client that is not a live declared agent, or a declared agent's token carrying no `act` (§24) |
| a write under no recorded act | the act write guard, on every table the application or the worker can write (§25) |
| a change to a closed record's identity, or a decided decision's words | the object guards (§41) |
| an edge whose source or target type its relation does not declare | the relation-endpoint trigger, for every session (§35) |
| `budget_exceeded`, `unbounded_definition`, `unlabelled_member` | the projection engine (§59, §60) |
| a bind that is not a principal, or widens one | `core.bind_principal` and `core.set_access_context`, to an application session (§17) |
| a forged ledger row, audit digest, interval reopening or identity link | the database's context checks (§17, §20, §30, §33) |
| `effective_at_out_of_bounds` (HTTP 400) | the action route, before dispatch (§13) |
| `master_record_stale` (HTTP 409) | `GET /objects/:id` and the master-record reads, which never compile (§61) |
| `content_refused` | `POST /ingest` and `POST /documents`, on content that must never enter (§48); the `kf ingest` and sync planners refuse the same content before they plan |
| `document_refused` (HTTP 422) | the pandoc parser, on a source that hits a time, memory or output bound |
| a second `reviewed_individually` within the pace | `object_verification_paced`, surfaced by the dispatcher as `precondition_failed` (§100.26) |
| an unclassified boundary table | the master-record boundary check, before compilation |
| a coverage or subset violation | the projection engine |
| an undeclared namespace | identifier allocation |
| a non-public store, or a non-publication act | the public-copy triggers |
| a non-head revision of a native document | the external-source adapter |
| an unstated ingestion mode | the ingestion planner, before any side effect |
| an undeclared ontology addition | R01 preservation |
| a removed requirement identifier | this document's revision check |

## 102. Digest and canonicalization conventions

Everything digested is canonicalized by RFC 8785 and domain-separated by a format tag that is
part of the preimage. Digests are SHA-256. Signatures are Ed25519.

Reconciled with the code for `0.1.0-draft.8`; earlier revisions listed tags that were not
digest tags and omitted most that were. Production source takes a digest through `taggedDigest`,
which places the tag in the preimage as a `format` property; a digest that is stored and later
re-verified records its format per row or per manifest, so a new format is added beside the old
rather than reinterpreting it, and a chain or sequence never moves back to an older one.

- **Tags versioning a digested or signed structure:** `kf-action-request-v1` (the idempotency
  digest), `kf-action-state-v1` (an act's before and after target states), `kf-audit-link-v2` (an
  audit-chain link since `20260924001100`), `kf-projection-result-v2`, `kf-publication-v1`,
  `kf-master-record-v1`, `kf-master-record-v2` and `kf-master-record-v3`,
  `kf-master-record-member-v1` and `-v2`, `kf-master-record-payload-v1` and `-v2`,
  `kf-document-compilation-run-v2`, `kf-compilation-dependencies-v1`, `kf-document-parse-v2` with
  its `kf-document-atom-v1`, `kf-document-loss-source-v1`, `kf-document-conversion-loss-v1` and
  `kf-document-projection-v1`, `kf-citation-excerpt-v1`, `kf-citation-briefing-v1`,
  `kf-ai-proposal-context-v2`, `kf-access-explanation-v2`,
  `kf-preservation-manifest-signature-v1`, `kf-backup-manifest-v1`,
  `kf-backup-manifest-signature-v1`, `kf-overview-v1`, and this document's revision schema
  `oh.war/sas-revision/v1`.
- **Recorded labels for formats that carried no tag, kept so what was recorded still verifies:**
  `kf-audit-link-v1` (every link before `20260924001100`), `kf-document-parse-v1` (every parse
  receipt before `20260925114000`), and `kf-ai-proposal-context-v1` (the untagged context digest,
  still accepted for stored proposals). A label names what those bytes always were; it is not in their preimage,
  and no new row is written under one.
- **Tags versioning a protocol or envelope, not a digest:** `kf-document-v1` (the compiler
  protocol), `kf-liminal-runtime-closure-v1`, `kf-migration-rollback-rehearsal-v3`,
  `kf-migration-028-state-v1`, and the web's cookie envelopes `kf-web-session-v1`,
  `kf-oidc-transaction-v1` and `kf-id-token-hint-v1`.
- **Listed before, and not digest tags:** `kf:audit-chain:v1` and `kf-action-idempotency-lock-v1`
  key advisory locks; `kf-master-record-boundary-v1` labels
  `docs/architecture/master-record-boundary.json` and no code reads it.

§100.27's two digests are resolved: the audit link by `kf-audit-link-v2`, the access explanation
by `kf-access-explanation-v2` over RFC 8785. The digests that remain untagged are enumerated, with
where each lives, by `tests/conformance/digest-tags.test.ts`, which fails on one it does not list;
§100.27 names their kinds.

## 103. Document conventions and provenance

**103.1** Section numbers are stable. A section may be added at the end of a part; existing
numbers are not reused for different content.

**103.2** Requirement identifiers are append-only (§97.2) and are the only stable reference this
document offers to outside work. Cite a requirement, not a section number, from another
repository.

**103.3 Counts.** Two kinds exist and they answer different questions. A **source count** is
derived from the repository — migrations, statements, declared types — and moves when the source
moves. A **runtime count** is measured against a running database and appears only where the
runtime is the subject, as in §38 and §40, carrying its measurement date and host.

**This document states no source count.** It cites
[`generated/measurements.md`](../../generated/measurements.md), which is derived from the checkout
and gated on drift. The earlier revisions wrote the figures into prose with a disclaimer saying
they were perishable, and they duly rotted: this document claimed 88 migrations against 91, 168
tables against 174 and 438 policies against 463, and those same wrong figures had been copied into
the dogfood host document and into a Warrant's compilation basis, where each rotted separately. The
disclaimer prevented none of it; it only meant nobody was surprised.

Transclusion — substituting the number at build time — is the obvious repair and is the wrong one
here. §94.2 digests this document's exact bytes and acceptance freezes that digest, so a
build-time substitution would break an accepted revision every time a migration landed. A signed
artifact cannot also be a generated one. Citing a generated file keeps this document's bytes stable
and makes a wrong number fail the build, which is what the disclaimer could never do.

The database source counts are derived by taking each migration's up-section only — everything
before its `-- migrate:down` marker — with SQL comments removed, and counting literal statements
across the concatenation. Comments are removed because the migrations explain themselves at
length and name what they explain: until `0.1.0-draft.8` the `SECURITY DEFINER` count included
the comment lines saying why a function was or was not one. The
per-file truncation matters: every `drop table` statement in this repository is in a
down-section, so a count that reads whole files reports a schema that is created and then
destroyed. Truncating the concatenation instead of each file is worse and quieter: the
first down-marker ends the stream, and every count after it reads zero, which looks like a
finding rather than a mistake.

**103.4** File paths cited in this document resolve in this repository, and a gate asserts it
(§92).

**103.5** This document was drafted by an agent under direction, and accepted by a human. §100.14
records what that means for independence.

## 104. Neighbouring programs

Each is a separate program with its own specification, its own requirement prefix and its own
Warrants. None of them traces to this document, and this document does not trace to any of them.

**104.1 OpenWarrant** owns the work primitive: how a bounded intervention is authorized, executed,
verified and resolved. It defines the document class this specification belongs to. KF is its
institutional authority — allocating identity and recording the organizational fact — while its
Git repository remains Source Holder (§66). Its SAS §67 action names are implemented here as
typed actions.

**104.2 Liminal** is the document and context substrate. ADR 0010 defers the Liminal-backed
compiler; v1.0 ships the native one.

**104.3 Katana** is the agent runtime. KF duplicates none of its authority.

**104.4 BLUT** is the typed computational runtime. KF duplicates none of its authority.

The rule across all four is Law 1. Where a neighbour owns a fact, KF records metadata, a digest
and a locator, and says whose it is.

**KF-SAS-RQ-185.** KF SHALL NOT duplicate the authority of a neighbouring program, and SHALL
record which program owns each federated fact.

## 105. Amendment history

| Revision | Date | Change |
|---|---|---|
| `0.1.0-draft.8` | 2026-09-24 | Brings this document in line with the security hardening of 2026-09-23/24 and with everything built on it before acceptance. The hardening began with a red-team pass run as `kf_app`, which showed that row-level security held against a buggy API and not a hostile one: every `kf.*` setting the policies read was the application's to write, and the ledger, the audit chain, role assignments, identity links and verifications all accepted rows no act had made. §17 now states that the database binds the principal — a sealed context, `core.bind_principal` deriving organization and ceiling from a live assignment and clearance, the application only narrowing — and §24 the attestation boundary: `kf-attestor` verifies RS256 and the database binds a person for the API's login only on its current attestation, the replay window being the token's life, which commissioning now caps at 300 s, and an attestor that cannot be asked is a 503 outage with no fallback. The database also recomputes audit digests (§30), checks act authority on the ledger row (§20), forces row security on every table that enables it and reconciles a running database against the migrations' declared set (§38), so KF-SAS-RQ-073 is met and §100.15 is closed; refuses a domain write that belongs to no recorded act (§25); fixes a closed record's identity and a decided decision's words (§41); and refuses an edge whose endpoint types its relation does not declare (§35). Authority rows are minted only by the owner credential, and an identity link is withdrawn only there, as `kf:revoke-identity`'s recorded act (§33, §76). An agent acts for a named person on an exchanged token, its participation written into the ledger by the database (§24, ADR 0035). An observation is captured in one gesture on three surfaces (§8A, ADR 0034); three of ADR 0024's five latency bars are measured (§8A). Every projection, Object View, agent read and search hit labels an unverified record (§59, `kf-projection-result-v2`); agent reads and the AI planner ask the read grant and consume the reader's `agent_context` projection (§32, §59); the projection grammar is closed and bounded in depth, size and runtime (§60). The retrieval index's Fabric half is built — per-query masks, a band version that never repeats, embed-on-ingest, composed rankings, a withheld count within the asker's ceiling (§64A, §64B, ADR 0037) — and queries are recorded under an expiring pseudonym and replayable by their asker. §43, §45 and §86 state the install and migration scripts, correcting a false claim that a test pinned the seeded ontology's digest; §88 the backup login that until then could not take a backup. §13 and §29 state the database clock and the caller's `effectiveAt` bounds; §48–§49 the ingest order and the recorded orphan sweep; §61 ADR 0033's amendment of ADR 0015. §28 gains `not_attested`, HTTP 401, as a thirteenth code. Every remaining source count is removed in favour of [`generated/measurements.md`](../../generated/measurements.md), which gains schemas, triggers, views, indexes, foreign keys, checks, group roles, forward-only migrations, packages and systemd units, and excludes SQL comments. §102's format tags are reconciled with the code, and §100.27's two untagged digests are resolved in the same draft, the remaining untagged ones enumerated by a gate. Delegation is one level deep and every new assignment ends within a year (§18, ADR 0036); every process resolves its stores against their declared, bound address (§50); a requalified compiler must reproduce the run before it (§54); an archive from an earlier exporter imports (§56); another person's recorded queries are replayed only as the aggregate (§64B); an object's history is read by index (§61); and an engagement cannot close over live work (§73). §100 closes .2, .7, .8, .9, .12, .15, .16, .19, .31 and .34 and the labelling half of .26; narrows .1, .3, .5, .18, .21, .23, .27 and .32; and appends .28–.36, the first of which records that the owner has not confirmed KF-SAS-RQ-038's clarified reading. Seventeen requirements appended (KF-SAS-RQ-233 to RQ-249); six retitled in place (RQ-038 to ADR 0027's session ceiling, RQ-042, RQ-044, RQ-150, RQ-181 and RQ-222), because the earlier wording was wrong about the design or narrower than what was built, and each keeps its identifier; none removed. Architecture-changing under §94.3, carrying [ADR 0033](../decisions/0033-the-database-binds-the-principal.md), and citing ADRs 0034 to 0037, which are proposed and await the owner. |
| `0.1.0-draft.7` | 2026-09-20 | Records the owner's waiver of ADR 0004's seven-day floor on compiler cutover ([ADR 0032](../decisions/0032-the-seven-day-floor-is-waived.md)). The other three conditions stand: twice-compiled byte-identical output, five action paths exercised, zero unexplained drift. §93.1 restated, because it asserted a floor that no longer applies. No requirement added, removed or retitled; not architecture-changing under §94.3 — the waived condition was a procedural floor rather than an architectural rule, and what it gave up is recorded in the ADR rather than in a requirement. |
| `0.1.0-draft.6` | 2026-09-18 | Corrects a conflation in `draft.5`. §48A used "draft" and "unverified" interchangeably, and they are not the same: `draft` is the initial state of 8 of the 24 state machines in `ontology/state-machines.yaml`, while the rest begin at `planned`, `proposed`, `active`, `open`, `captured`, `prospective`, `in_service` or `received`. A work order that begins at `planned` was never a draft, so the previous wording's rules did not reach it — and "any initial state" is wrong in the other direction, since equipment beginning at `in_service` is not unverified. Verification is therefore orthogonal to lifecycle: a record may be `active` and unverified, or `draft` and verified. KF-SAS-RQ-228 is retitled from "a draft" to "an unverified record", RQ-232 is appended stating the orthogonality, §48A's prose and title are corrected, and §100.26 is restated — it had recorded the same error. One requirement appended, one retitled, none removed; architecture-changing under §94.3, carrying [ADR 0031](../decisions/0031-a-draft-is-a-record-that-says-so.md), corrected in place while proposed. |
| `0.1.0-draft.5` | 2026-09-14 | Adds §48A, which settles whether a low-friction capture path is compatible with KF-SAS-RQ-021's refusal to admit a container. It is, under one rule: a gesture may produce many acts, never zero and never one covering many. Records what an unverified record is — a record under Law 6, exported marked, a labelled member of a master record rather than a silent omission, and not citable as evidence — and requires a promotion act to say whether it was reviewed individually or promoted in bulk, so that "verified" keeps its meaning. Adds §100.26: the draft state is presently a label that nothing filters on, which inverts the build order, because a capture path filling a store whose rules do not exist puts unverified material into master records and into the permanent export. Five requirements appended, none removed or retitled; architecture-changing under §94.3, carrying [ADR 0031](../decisions/0031-a-draft-is-a-record-that-says-so.md). |
| `0.1.0-draft.4` | 2026-09-14 | States the architecture in one place for the first time: §8B names the three layers and pins the invariants that hold across them ([ADR 0030](../decisions/0030-three-layers.md)), after the observation that a reader had to assemble the structure from five documents and a README, and that the README had consequently outrun this document on a structural claim. Adds §64A, the retrieval index — inside the trust boundary, outside the authority boundary, holding a vector and an identifier and no authorization input, with authorization computed per query and applied during scoring ([ADR 0028](../decisions/0028-the-retrieval-index-is-masked-not-copied.md)); this supersedes the reasoning that refused embeddings in `database/migrations/20260811001800_search.sql`, on the condition that reasoning itself set. Adds §64B, transient observations, a third category of stored thing that is neither authoritative nor rebuildable, with the four exclusions that make an expiry mean anything ([ADR 0029](../decisions/0029-transient-observations-are-a-third-category.md)). Removes every source count from this document in favour of a generated, gated measurement file, after four figures here were found stale and had been copied into two other documents and a Warrant basis; §103.3 records why transclusion was rejected. Five gaps appended, including that revocation in the search index is asynchronous and unmeasured, and that no objective after v1.0 can be scheduled. Seventeen requirements appended, none removed or retitled. One defect found and closed in the same revision: `search.document`'s read policy decided visibility from a denormalised classification refreshed by a worker documented as permitted to be late, so a reclassification did not take effect until the drain ran; `20260914000100` makes the policy defer to `core.object`, and a test reproduces the window by reclassifying without reindexing; architecture-changing under §94.3, carrying ADRs 0028, 0029 and 0030. |
| `0.1.0-draft.3` | 2026-09-04 | Corrects §38's row-level security figures against the first ever install of this schema on a host — 143 enabled, 70 forced, the 73 unforced reconciling exactly with the migrations, and the previously cited 113 of 139 wrong in both halves. Adds §8A and five requirements making speed of capture and retrieval architectural rather than product polish, after the observation that a records system engineers skip records nothing ([ADR 0024](../decisions/0024-friction-is-an-architectural-property.md)). Records that capture is cheap and governance applies at promotion, that several surfaces share one act model, and that an agent may act for a named human. Five requirements appended, none removed or retitled; architecture-changing, carrying ADR 0024. |
| `0.1.0-draft.2` | 2026-09-04 | Records two scope decisions that pull in opposite directions and were made together: business logic is an application above the Fabric (§8.10), and dataset, transform and lineage capability, if ever built, belongs in the core rather than above it (§8.11). Adds the organization-as-configuration requirement. Three requirements appended, none removed or retitled. Architecture-changing under §94.3 and carrying [ADR 0023](../decisions/0023-business-logic-above-data-primitives-within.md): the draft asserted it was not, and `war sas propose` derived otherwise from the §106 diff and required a decision record. The tool was right. |
| `0.1.0-draft.1` | 2026-09-03 | First revision. Establishes the Knowledge Fabric as a program with its own specification, 132 requirements and an eleven-phase ladder. No predecessor. |

## 106. Architecture requirements index

The stable identifiers implementation Warrants reference. Append-only (§97.2). Status is derived
from evidence, never recorded here (§97.3).

### Purpose and thesis

| ID | Requirement |
|---|---|
| KF-SAS-RQ-001 | One coherent typed graph over records whose authorities remain distinct |
| KF-SAS-RQ-002 | Visibility, immutability and integrity enforced in the database |
| KF-SAS-RQ-003 | An unbound access context reads nothing |

### Design laws

| ID | Requirement |
|---|---|
| KF-SAS-RQ-010 | Every record names its authority; a mirror is distinguishable from the original |
| KF-SAS-RQ-011 | Every controlled write is an attributed act in the transaction that applies it |
| KF-SAS-RQ-012 | Every refusal carries a named code and a detail object |
| KF-SAS-RQ-013 | Where a check cannot be performed, refuse; a gate that compared nothing fails |
| KF-SAS-RQ-014 | An allocated identifier is never reissued; a retired namespace stays resolvable |
| KF-SAS-RQ-015 | Withdrawal, supersession, revocation and unpublication are state changes, not deletes |
| KF-SAS-RQ-016 | Every digest is over an RFC 8785 canonical form under a named format tag |
| KF-SAS-RQ-017 | A generated artifact is reproducible, and a difference fails the build |
| KF-SAS-RQ-018 | A known gap is recorded somewhere enumerable, never as an inline marker |
| KF-SAS-RQ-019 | The human-only acts are refused to a service actor by name |
| KF-SAS-RQ-020 | No generic authenticated write path accepting a caller-supplied action type |
| KF-SAS-RQ-021 | External content is admitted one named item at a time, never by container sync |
| KF-SAS-RQ-022 | The ontology preserves every approved R01 definition and declares every addition |
| KF-SAS-RQ-023 | One package opens connections; one package provides the controlled write path |

### Identity, authority and access

| ID | Requirement |
|---|---|
| KF-SAS-RQ-030 | Every governed record has exactly one object row carrying its governed fields |
| KF-SAS-RQ-031 | Event time and record time are separate, and record time is server-assigned |
| KF-SAS-RQ-032 | An enterprise identifier is opaque and carries an error-detecting check character |
| KF-SAS-RQ-033 | The allocation request has no field for a caller-supplied identifier |
| KF-SAS-RQ-034 | Every act names a live acting role assignment, verified first |
| KF-SAS-RQ-035 | Only a human person carries an external authentication identity |
| KF-SAS-RQ-036 | Classification is a closed, totally ordered set compared by rank |
| KF-SAS-RQ-037 | A requested ceiling is resolved against recorded clearance before it is bound |
| KF-SAS-RQ-038 | Clearance is organization-scoped and effective-dated; the session ceiling is at most the clearance, and an assignment ceiling caps only its role's grant |
| KF-SAS-RQ-039 | Read authorization is row visibility intersected with live grant coverage |
| KF-SAS-RQ-040 | Live grants for one principal, scope and capability do not overlap in time |
| KF-SAS-RQ-041 | The read path and the write path consult the same grant view |
| KF-SAS-RQ-042 | Any access decision is explainable as a path to the deciding grant, exclusion, principal-kind bar or separation-of-duty rule |
| KF-SAS-RQ-043 | An institutional act requires an act grant reaching every locked target |
| KF-SAS-RQ-044 | Which actions are institutional is declared in the ontology and consulted by the database, not encoded in control flow |
| KF-SAS-RQ-045 | Automated work acts as a declared service actor through the same write path |
| KF-SAS-RQ-046 | A service actor is refused every institutional act, whatever grants reach it |
| KF-SAS-RQ-047 | An act that judges another act is refused to the actor who performed it |
| KF-SAS-RQ-048 | Authentication establishes only the subject; authorization comes from the database |
| KF-SAS-RQ-049 | A fixed-identity profile is unreachable by configuration from a serving profile |

### The write path

| ID | Requirement |
|---|---|
| KF-SAS-RQ-050 | All controlled writes pass one dispatcher, one transaction per act |
| KF-SAS-RQ-051 | Authority resolves before materialization; coverage is asserted after locking |
| KF-SAS-RQ-052 | Targets lock in canonical order; an invisible target is refused |
| KF-SAS-RQ-053 | A stale expected row version is refused |
| KF-SAS-RQ-054 | A refused act raises; the result type cannot represent a refusal |
| KF-SAS-RQ-055 | A retried act applies at most once; the replayed result is re-read from state |
| KF-SAS-RQ-056 | The idempotency digest covers semantics only, excluding transport and read scope |
| KF-SAS-RQ-057 | A replay re-verifies the prior act's audit receipt before returning it |
| KF-SAS-RQ-058 | Every act appends one audit event, by one implementation, in the same transaction |
| KF-SAS-RQ-059 | The audit chain is independently verifiable |
| KF-SAS-RQ-060 | External side effects are driven from a durable record written inside the act |
| KF-SAS-RQ-061 | A rehearsal uses the real write path in a transaction that cannot commit |
| KF-SAS-RQ-062 | A bootstrap act still extends the audit chain, and is enumerable |

### The database as the authority

| ID | Requirement |
|---|---|
| KF-SAS-RQ-070 | An undeclared type, state or action token fails a referential constraint |
| KF-SAS-RQ-071 | Each schema names one authority; a derived schema is reconstructible |
| KF-SAS-RQ-072 | One role may change schema, and it is not the application role |
| KF-SAS-RQ-073 | Row-level security is forced, not merely enabled, on governed tables |
| KF-SAS-RQ-074 | A table brought under row-level security is statically discoverable |
| KF-SAS-RQ-075 | A predicate refactored for plan shape preserves visibility and uses invoker rights |
| KF-SAS-RQ-076 | Load-bearing planner settings are identical across environments, and gated |
| KF-SAS-RQ-077 | A record asserting an event is immutable but for later verification fields |
| KF-SAS-RQ-078 | Every declared invariant is enforced, and the mapping is asserted by a test |
| KF-SAS-RQ-079 | Schema changes are ordered and applied from one declared sequence |
| KF-SAS-RQ-080 | An irreversible migration is identified as such and offers no false safe path |
| KF-SAS-RQ-081 | A fresh install verifies the seeded ontology by digest and refuses a mismatch |

### Content and preservation

| ID | Requirement |
|---|---|
| KF-SAS-RQ-090 | An artifact version is immutable; a change produces a new version |
| KF-SAS-RQ-091 | Content is addressed by digest, and the producing toolchain is recorded |
| KF-SAS-RQ-092 | Ingestion requires an explicit copy-or-reference intent |
| KF-SAS-RQ-093 | An external artifact can be recorded by digest and locator without its bytes |
| KF-SAS-RQ-094 | Object writes are create-only; a failed act leaves no unreferenced content |
| KF-SAS-RQ-095 | A version's bytes may exist in several stores, each with role and verification |
| KF-SAS-RQ-096 | A fallback read serves only a copy whose digest has been verified |
| KF-SAS-RQ-097 | Replication and verification are recorded acts; a failure is recorded |
| KF-SAS-RQ-098 | A parse records the executable identity of its tool, not only the data format |
| KF-SAS-RQ-099 | A cross-host golden is frozen only over measured agreement |
| KF-SAS-RQ-100 | Conversion loss is enumerated and recorded with the parse |
| KF-SAS-RQ-101 | A controlled document's effective state changes only by institutional act |
| KF-SAS-RQ-102 | Compilation is deterministic and addressed by digest |
| KF-SAS-RQ-103 | The preservation inventory is closed; an omitted governed table fails a gate |
| KF-SAS-RQ-104 | An export imported into an empty database re-exports byte-identically |
| KF-SAS-RQ-105 | Restore is exercised on a schedule using the shipped scripts |

### Corpus and disclosure

| ID | Requirement |
|---|---|
| KF-SAS-RQ-110 | A person can obtain the complete set of records about them they may see |
| KF-SAS-RQ-111 | A master record's identity is its corpus; an unchanged corpus replays |
| KF-SAS-RQ-112 | Staleness is computed from the current corpus, not asserted by the writer |
| KF-SAS-RQ-113 | Every reading is a declared projection whose members subset the corpus |
| KF-SAS-RQ-114 | Projection sections cover the corpus with an explicit remainder |
| KF-SAS-RQ-115 | Agent context is a projection under the same invariants as a human reading |
| KF-SAS-RQ-116 | The projection grammar is closed, non-executable and statically bounded |
| KF-SAS-RQ-117 | Every object type has a read view derived from ontology metadata |
| KF-SAS-RQ-118 | Every governed table carries a boundary classification; unclassified fails |
| KF-SAS-RQ-119 | No external system is resolved live into a master record |
| KF-SAS-RQ-120 | A compiled record enumerates what was withheld and on what basis |
| KF-SAS-RQ-121 | One search index for all audiences, filtered by the same context at read time |

### Institutional acts and federation

| ID | Requirement |
|---|---|
| KF-SAS-RQ-130 | Allocation is atomic with its act, skips occupied numbers, refuses unknown namespaces |
| KF-SAS-RQ-131 | An act can return a computed value read back from durable state, stable on replay |
| KF-SAS-RQ-132 | KF is institutional authority without becoming Source Holder, and records their digests |
| KF-SAS-RQ-133 | A federated record's identity here is the identity its Source Holder uses |
| KF-SAS-RQ-134 | Publication writes exactly one verified public copy; the database refuses others |
| KF-SAS-RQ-135 | Unpublication is a recorded state change over the copy, never a delete |
| KF-SAS-RQ-136 | An external copy records the source, the exact revision, and any converter |
| KF-SAS-RQ-137 | A conversion impossible at the cited revision is refused, not relabelled |
| KF-SAS-RQ-138 | A federation adapter creates no writable local copy that could diverge |
| KF-SAS-RQ-139 | The product is separable from one deployment's registry; couplings are recorded |
| KF-SAS-RQ-140 | Model lineage is append-only and holds measurements, not underlying data |
| KF-SAS-RQ-141 | Secure-object access is by issued, recorded capability with a declared purpose |
| KF-SAS-RQ-142 | The work-control path is reachable through declared actions alone |
| KF-SAS-RQ-143 | Product, quality and engineering records use the same model, with no privileged path |

### Interfaces

| ID | Requirement |
|---|---|
| KF-SAS-RQ-150 | The HTTP layer holds no authority and permits nothing the write path refuses; its own refusals are admission checks that grant nothing |
| KF-SAS-RQ-151 | Operator commands take secrets by file only, refusing an inline secret by name |
| KF-SAS-RQ-152 | A release package carries its gaps, and an approval commits to them |
| KF-SAS-RQ-153 | A manifest does not contain its own digest; verifying it is a distinct act |
| KF-SAS-RQ-154 | Approved definitions preserved, additions declared, divergences exhaustive |
| KF-SAS-RQ-155 | A rule that cannot be machine-enforced is recorded as such |
| KF-SAS-RQ-156 | Generated artifacts contain nothing non-deterministic and are verified by rebuild |
| KF-SAS-RQ-157 | The presentation layer contains no authority decision or business rule |
| KF-SAS-RQ-158 | Every canonical format carries a version tag inside its digest preimage |

### Operations

| ID | Requirement |
|---|---|
| KF-SAS-RQ-160 | One declared platform contract, stated rather than implied |
| KF-SAS-RQ-161 | Every host requirement is stated and probed, on a minimal image |
| KF-SAS-RQ-162 | The artifact tested is the artifact deployed; installation is atomic and reversible |
| KF-SAS-RQ-163 | Each service runs under a distinct unprivileged account |
| KF-SAS-RQ-164 | The alert path is exercised on a schedule and its delivery evidenced |
| KF-SAS-RQ-165 | A backup is verified at its destination and restore proven on a schedule |
| KF-SAS-RQ-166 | An archiving command fails on a write it did not perform |
| KF-SAS-RQ-167 | Checkpoint signing runs where the serving application cannot reach the key |
| KF-SAS-RQ-168 | Commissioning requires host evidence; availability is not authorisation |
| KF-SAS-RQ-169 | Controls no automated check covers are enumerated as such |
| KF-SAS-RQ-170 | Every documented control cites an artifact, and a gate verifies the path resolves |
| KF-SAS-RQ-171 | Claims needing host, provider or human evidence are outstanding until it exists |

### Governance

| ID | Requirement |
|---|---|
| KF-SAS-RQ-180 | This specification is governed by digest; accepted revisions are immutable |
| KF-SAS-RQ-181 | Every copy states the revision and digest it reproduces, and presents no revision as accepted that its record does not |
| KF-SAS-RQ-182 | Decisions record measurement and rejected options; superseded records are retained |
| KF-SAS-RQ-183 | Requirement identifiers are append-only; status is derived from evidence |
| KF-SAS-RQ-184 | A cross-repository requirement citation is unverified until a tool resolves it |
| KF-SAS-RQ-185 | KF duplicates no neighbouring program's authority and records who owns each fact |
| KF-SAS-RQ-186 | The forced-RLS set is derivable from migrations and reconciled with the database |

### Scope decisions of 2026-09-04

| ID | Requirement |
|---|---|
| KF-SAS-RQ-190 | Business logic is computed by callers and reaches the Fabric only as acts |
| KF-SAS-RQ-191 | Dataset, transform and lineage capability, if built, is a core primitive |
| KF-SAS-RQ-192 | The deploying organization's identity is configuration, not compiled in |

### Friction and use, 2026-09-04 (ADR 0024)

| ID | Requirement |
|---|---|
| KF-SAS-RQ-200 | Recording an observation asks the actor for no authority, concurrency or idempotency detail |
| KF-SAS-RQ-201 | Capture and retrieval latency are stated as bars, measured, and architectural |
| KF-SAS-RQ-202 | An observation is recordable as a draft, attributed from the first moment; promotion is a separate act |
| KF-SAS-RQ-203 | Every capture surface dispatches the same acts through the same seam |
| KF-SAS-RQ-204 | An agent can act on behalf of a named human, attributed to them, with its participation recorded |

### The three layers, 2026-09-14 (ADR 0030)

| ID | Requirement |
|---|---|
| KF-SAS-RQ-210 | A kernel holds the rules, consumers project, callers reach records only through acts; no layer above the kernel can widen what a reader sees |
| KF-SAS-RQ-211 | A layer above the kernel writes only as an attributed act, never to storage directly |
| KF-SAS-RQ-212 | Each layer reads only what the layer below authorised, and is replaceable without changing the layers below |

### Retrieval, 2026-09-14 (ADR 0028)

| ID | Requirement |
|---|---|
| KF-SAS-RQ-213 | The retrieval index holds a vector and an identifier, no authorization input, and every hit passes the same grant check as every other read |
| KF-SAS-RQ-214 | Retrieval authorization is computed from live records and applied during scoring; no derived copy of an authorization input is stored |
| KF-SAS-RQ-215 | A short mask excludes the unaddressed slots; a long mask is refused |
| KF-SAS-RQ-216 | A retrieval engine that cannot serve refuses, and a result without semantic ranking says so in the withholding ledger |
| KF-SAS-RQ-217 | Near misses are returned only on request, separately labelled, naming the scoring function |
| KF-SAS-RQ-218 | Controlled content never leaves the host to be embedded; a non-local provider is refused, and the embedder binding is registered once |
| KF-SAS-RQ-219 | The retrieval trace is derived and disposable; the kernel holds the record of what was disclosed as its digest |
| KF-SAS-RQ-223 | A band bitmap or derived scope tag lives only for the life of its process and never reaches durable storage |
| KF-SAS-RQ-224 | Lexical and semantic rankings are composed rather than merged, the lexical one stays exhaustive, and each result names the ranking that produced it |
| KF-SAS-RQ-225 | Text may transit to an on-host embedder and is never persisted there; a controlled record offered to a persisting path is refused |
| KF-SAS-RQ-226 | A derived index never decides visibility from a denormalised copy; the decision is taken against the record in the same statement |

### Capture and verification, 2026-09-14 (ADR 0031)

| ID | Requirement |
|---|---|
| KF-SAS-RQ-227 | One gesture may dispatch many acts; at least one per item, never one covering several |
| KF-SAS-RQ-228 | An unverified record is a record under Law 6, attributed from the first moment, exported marked unverified |
| KF-SAS-RQ-229 | A projection labels an unverified member and never omits it silently |
| KF-SAS-RQ-230 | An unverified record is not citable as evidence |
| KF-SAS-RQ-231 | A promotion act records whether the item was reviewed individually or in bulk |
| KF-SAS-RQ-232 | Verification is recorded independently of lifecycle state, never inferred from it |

### Transient observations, 2026-09-14 (ADR 0029)

| ID | Requirement |
|---|---|
| KF-SAS-RQ-220 | A stored thing that is neither authoritative nor rebuildable is a transient observation with a stated expiry, excluded from the export, the boundary, checkpoints and long backups |
| KF-SAS-RQ-221 | Recorded queries are transient observations; the durable demand aggregate names records and counts of distinct persons, never which persons |
| KF-SAS-RQ-222 | What a query withheld is computed on demand at the asking person's ceiling, never persisted, and disclosed to them only as one count within their ceiling |

### The database binds the principal, 2026-09-24 (ADR 0033)

| ID | Requirement |
|---|---|
| KF-SAS-RQ-233 | The transaction context is written only by the database's binding functions, sealed, and readable only as sealed |
| KF-SAS-RQ-234 | The application binds only a principal derived from a live assignment and recorded clearance, and may then only narrow |
| KF-SAS-RQ-235 | An application bind requires a current attestation from a separate process that verified the person's token |
| KF-SAS-RQ-236 | People, role assignments and identity links are created only through the owner credential; an identity link is revoked only there, as a recorded act with its reason |
| KF-SAS-RQ-237 | The database recomputes each audit event's digest and refuses a mismatch |
| KF-SAS-RQ-238 | The database refuses a ledger row for an institutional act no live act grant covers, or by a service actor |
| KF-SAS-RQ-239 | Every table that enables row-level security forces it, and a gate fails on one that does not |

### What the principal binding left open, 2026-09-24 (ADR 0033)

| ID | Requirement |
|---|---|
| KF-SAS-RQ-240 | An unreachable attestor refuses a bearer request as unavailable, binds nobody, and has no in-process fallback outside development |
| KF-SAS-RQ-241 | Commissioning refuses an access-token lifetime, realm-wide or per client, above the attestation replay bound |
| KF-SAS-RQ-242 | The database refuses an application or service write that belongs to no act recorded by the sealed actor; exemptions are declared with reasons |
| KF-SAS-RQ-243 | A closed record's identity-bearing fields are immutable for every session, the owner's included |
| KF-SAS-RQ-244 | Every relation declares its endpoint types, and the database refuses an edge of an undeclared shape |
| KF-SAS-RQ-245 | A backup is taken by a backup-only login, holds every row it claims, and its restore is proven from that login's backup |
| KF-SAS-RQ-246 | Delegation goes one level deep, and every new role assignment and project membership ends within 366 days |
| KF-SAS-RQ-247 | A recorded query is disclosed only to its asker; another person's replay returns only the aggregate |
| KF-SAS-RQ-248 | An export from an earlier exporter of the same format imports, converted as its migrations converted |
| KF-SAS-RQ-249 | A process addresses a store only at its declared, bound address, which never changes and carries no credential |
