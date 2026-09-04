# KF Software Architecture Specification

## OpenHuman Knowledge Fabric: one coherent institutional record, where the database is the authority and every write is an attributable act

| Field | Value |
|---|---|
| Document class | Software Architecture Specification |
| Short name | KF SAS |
| Status | Draft for acceptance |
| Version | `0.1.0-draft.3` |
| Date | 2026-09-04 |
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

The measured shape of that authority, from the migrations in `database/migrations/`:

| | |
|---|---|
| Migrations | 88 |
| Schemas | 13 |
| Tables | 168 |
| Row-level security policies | 438 |
| Triggers | 152 |
| Functions | 158 distinct |
| Foreign keys | 431 |
| Check constraints | 724 occurrences |
| Indexes | 85 |
| Views | 16, none materialized |
| Group roles | 10, all `NOLOGIN` |

Against that: roughly 47 000 lines of TypeScript whose job is orchestration, action dispatch and
HTTP. The ratio is the thesis. **Performance work in this system is database work**, and §40
records what that cost when it was first measured.

Three corollaries that the rest of this document depends on:

1. **A read is authorized by the same predicate that authorizes a write.** There is no
   application-side filter that a second code path could forget.
2. **An unbound context sees nothing.** `core.current_classification_rank()` defaults to `-1`,
   below `public`, so a connection that has not bound an access context reads an empty database
   rather than an unfiltered one.
3. **The application is not a second way in.** The HTTP surface makes no refusal the dispatcher
   does not, and `tests/permissions/api-actions.test.ts` asserts that against a real database.

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

Every refusal has a name. There are twelve refusal codes (§28), each distinct so that a caller
can respond rather than only log. A system that fails with a generic error teaches its operators
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
requirement. None of them is measured today; §100.18 records that.

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

**10.3 A pnpm workspace of 29 packages, built as a composed monolith.** 24 libraries under
`packages/` and 5 executables under `apps/`. The composition root is `@kf/orchestrator`. The
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

Counts in this document were measured on 2026-09-03 against the repository at that date. A count
is the most perishable kind of claim; §103.3 says which counts are gated and which are not.

---

# Part II — Identity, authority and access

## 13. Objects and identity

Every governed record is a row in `core.object`. The row carries the identity, the type, the
lifecycle state, the owning organization, the classification and a row version. The typed table
that holds the record's own fields references it.

That split is the reason row-level security is affordable. ADR 0003 records the decision: RLS
stops at `core.object`, and 77 typed tables carry none. A typed row is reachable only through
its object, so a policy on the object governs the record without 77 more policies to keep in
agreement. `tests/database/classification-predicate-equivalence.test.ts` asserts the predicate
has exactly one meaning however it is written.

Identity is a UUIDv7. The ordering property is used; the timestamp inside it is not treated as
an authoritative time. `effective_at` on the act is the time the event happened, which can
differ from the time it was recorded, and both are kept.

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

ADR 0011 replaced it. Clearance is organization-scoped and effective-dated. A role assignment
may carry its own ceiling. The effective rank is the minimum of the two, resolved at point of
use by `org.resolve_effective_classification`, and the resolved value — never the requested one
— is what is bound into the row-level security context. A request may narrow; it can never
widen.

The seam is one function, `setResolvedAccessContext`, and the comment on it states the rule the
code enforces: the caller never gets to bind an unverified classification directly. A refusal
surfaces as `classification_not_granted`.

**KF-SAS-RQ-037.** A caller-supplied classification ceiling SHALL be resolved against recorded
clearance before it is bound, and the resolved value SHALL be the one enforced.

**KF-SAS-RQ-038.** A clearance SHALL be organization-scoped and effective-dated, and the
effective ceiling SHALL be the minimum of the clearance and any assignment ceiling.

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

**KF-SAS-RQ-039.** Read authorization SHALL be the intersection of row-level visibility and live
grant coverage, and a principal with no grant SHALL have an empty corpus.

**KF-SAS-RQ-040.** Two live grants for the same principal, scope and capability SHALL NOT
overlap in time.

**KF-SAS-RQ-041.** The read path and the write path SHALL consult the same grant view.

## 19. Explaining a denial

A denial that cannot be explained is indistinguishable from a bug, and it teaches people to ask
an administrator rather than to understand the model.

`explainAccess` returns the policy path: which grants were considered, which reached, and where
the chain ended. It is exposed at `GET /objects/:id/access?person=` and it answers "why can't
this person see this" with the exclusion that caused it rather than with a boolean.

**KF-SAS-RQ-042.** The system SHALL be able to explain any access decision as a path ending in
the specific grant or exclusion that determined it.

## 20. Institutional acts and the act capability

Not every action is equal. Some change what the organization asserts: authorize, approve, grant,
revoke, allocate, issue, publish, supersede, deprecate, annul, make-effective, resolve.

An action type may declare `requires: act` in the ontology, carried into
`registry.action_type.requires_capability`. 43 of the 145 action types declare it. For those,
the dispatcher requires a live `act` grant reaching every target — or the organization — before
the act is applied, through `org.act_grant_reaches`, over the same view the read side uses.
A refusal is `act_not_granted`, surfaced as HTTP 403.

The check runs **after the targets are locked**, because a check against a target set that could
still change is a check against nothing.

Other actions remain role-only. The distinction is what makes "institutional act" a mechanised
category rather than a description.

**KF-SAS-RQ-043.** An institutional act SHALL require a live act grant reaching every target or
the organization, checked after targets are locked.

**KF-SAS-RQ-044.** Which actions are institutional SHALL be declared in the ontology and carried
into the database, not encoded in application control flow.

## 21. Service actors

Scheduled work has to act as somebody. The alternatives are worse than the problem: a shared
human account destroys attribution, and a path around the dispatcher destroys everything.

ADR 0020 declares a service actor as a person of kind `service`, with an organization-scoped
role and a clearance ceiling, created by a recorded act. It authenticates by holding a
permission-checked key file on the host. It goes through the same dispatcher as everybody else.

And it is barred from institutional acts. Whatever grants reach it, the dispatcher refuses any
action declaring `requires: act` to an actor whose `person_kind` is `service`, by name and with
a message that says why. A service actor does routine work under authority somebody granted; it
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

The web boundary has two identity profiles and they never fall back into each other. A
`development` profile may explicitly enable a fixed non-authoritative identity. The `dogfood`
profile refuses that path entirely and requires verified OIDC identity plus a database-backed
role assignment; `KF_ALLOW_FIXED_IDENTITY=1` cannot enable it there.

**KF-SAS-RQ-048.** Authentication SHALL establish only the subject, and every authorization
question SHALL be answered from recorded state in the database.

**KF-SAS-RQ-049.** A deployment profile that permits fixed non-authoritative identity SHALL be
distinct from every profile that serves records, and SHALL NOT be reachable from one by
configuration.

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

**KF-SAS-RQ-050.** All controlled writes SHALL pass through one dispatcher, in one transaction
per act, and no other path SHALL be able to apply a controlled change.

## 26. The action lifecycle

`createTransactionalDispatcher` runs these steps in this order. The order is load-bearing and
each step is named here because a reordering is an authority change.

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
7. **The access context is resolved and bound** (§17). Resolved before any context exists,
   because the caller's requested value is untrusted and must never reach RLS directly.
8. **A reason is present** where the action type requires one.
9. **A prior action is replayed** if this key was already used (§29). Replay happens after
   clearance is resolved, so an idempotency retry cannot bypass the authority boundary.
10. **The action id is minted** and the effective time settled.
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
  overlapping targets cannot deadlock by ordering;
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

Twelve, closed, each distinct so a caller can respond rather than only log:

| Code | Meaning |
|---|---|
| `unknown_action` | the action type is not available in this process |
| `actor_not_authorized` | the actor may not perform this act |
| `classification_not_granted` | the requested ceiling exceeds resolved clearance |
| `role_not_held` | the acting role assignment is not live for this actor |
| `act_not_granted` | no live act grant reaches the targets (§20), or the actor is a service (§21) |
| `object_not_visible` | a target is missing, or invisible under the bound context |
| `version_conflict` | the expected row version is stale |
| `illegal_transition` | the lifecycle does not permit this transition |
| `precondition_failed` | an action-specific precondition did not hold |
| `idempotency_conflict` | this key was used for different act semantics |
| `separation_of_duty` | the actor performed the act this one judges |
| `reason_required` | this action type requires a stated reason |

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
operate over a set. An omitted event time stays null, so the dispatcher's wall clock cannot make
two otherwise identical retries differ.

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
the act's attributed fields, under a named format tag.

Two properties are enforced structurally:

- **One implementation of the chain arithmetic.** `appendAuditEvent` is the only place that
  computes `prev_digest`. Two hand-written appends would be two chances to compute it
  differently, and a chain that disagrees with itself is indistinguishable from a tampered one.
- **The chain lock is taken as late as possible.** It serializes every act in the system, so it
  is held for the shortest interval the arithmetic allows.

`tests/audit-verification/ledger.test.ts` verifies the ledger against a real database,
including from the position of someone who can write to the audit table.

Above the chain sit signed Merkle checkpoints (§89), produced by a separate process.

**KF-SAS-RQ-058.** Every act SHALL append exactly one event to an append-only chain, computed by
one implementation, in the same transaction as the act.

**KF-SAS-RQ-059.** The audit chain SHALL be independently verifiable from its recorded events
without trusting the process that wrote them.

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

**KF-SAS-RQ-061.** A rehearsal SHALL exercise the real write path inside a transaction that
cannot commit, and SHALL NOT confer authority on any subsequent request.

## 33. Bootstrap acts

There is one honest exception to §25, and it is documented where it is exported rather than
hidden.

Dispatch binds authoritative clearance before effects run. So the **first** clearance in an
organization cannot be granted through the dispatcher: there is no clearance yet to bind. That
grant happens outside it — and it still has to extend the same audit chain, with the same
arithmetic, or the chain disagrees with itself.

`appendAuditEvent` is exported for exactly this, with that reasoning attached.

**KF-SAS-RQ-062.** Any act that cannot pass through the dispatcher SHALL still extend the audit
chain using the same implementation, and SHALL be enumerable.

## 34. What the dispatcher does not do

Stated so that its guarantees are not read as broader than they are.

**34.1 It does not decide what an action means.** The action's materializer and effect own the
typed writes. The dispatcher owns authority, ordering, atomicity and recording.

**34.2 It does not validate payload shape beyond what an action's own code requires.** There is
no schema layer between the caller and the effect; each action reads what it needs and refuses
what it cannot use.

**34.3 It does not enforce row visibility.** PostgreSQL does. The dispatcher binds the context;
the policies decide. This is the point of §5, and it is why a dispatcher bug cannot widen a
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
| what may reference what | 431 foreign keys |
| what values are legal | 724 check constraints |
| what may never change again | triggers that refuse `update` and `delete` on immutable rows |
| what may not overlap | exclusion constraints over validity intervals |
| that an unknown token is unknown | foreign keys into `registry.*`, so an unknown state or action fails a key rather than an application check |

That last row is the pattern worth naming. The ontology is **mirrored into the database**, so a
typed row referencing a lifecycle state or an action type references a registry row. An
application that invents a state token gets a foreign key violation, not a silently accepted
value that fails somewhere else later.

**KF-SAS-RQ-070.** The declared ontology SHALL be mirrored into the database such that an
undeclared type, state or action token fails a referential constraint.

## 36. Schemas as authority boundaries

Thirteen schemas. They are authority boundaries, not folders: each names the domain that owns
the facts inside it, so "which system may write this" is answerable from the table name.

| Schema | Tables | Owns |
|---|---|---|
| `registry` | 13 | the ontology, mirrored from the YAML sources under `ontology/` |
| `core` | 12 | object identity, typed relations, actions, approvals, snapshots, audit, outbox |
| `org` | 10 | people, organizations, engagements, roles, clearance, grants |
| `product` | 7 | products, configuration items, baselines |
| `work` | 27 | projects, work packages, work orders, execution, warrants |
| `engineering` | 7 | decisions, changes, requirements, risks, tests |
| `content` | 40 | artifacts, versions, locations, documents, publications |
| `finance` | 4 | invoices, payments, allocations |
| `quality` | 14 | controlled documents, CAPA, suppliers, training |
| `ops` | 6 | backup runs, recovery objectives, readiness evidence |
| `search` | 1 | a derived, disposable index |
| `ml` | 19 | append-only ML lineage, typed metrics, run seals, signed promotions |
| `secure_object` | 8 | secure-object capabilities, authority keys, erasure |

`search` carries its own statement of what it is not: nothing there is a source of truth, and
`search.rebuild()` reconstructs every row from `core.object` and the typed tables. A derived
index that could not be rebuilt would be a second authority by accident.

**KF-SAS-RQ-071.** Each schema SHALL name exactly one authority domain, and a derived schema
SHALL be reconstructible from authoritative rows.

## 37. Roles and DDL

Ten group roles, all `NOLOGIN`, so a role is a set of privileges rather than an account:
`kf_owner_role`, `kf_migrator`, `kf_app`, `kf_api`, `kf_worker`, `kf_checkpoint`, `kf_readonly`,
`kf_auditor`, `kf_backup`, `kf_ml_promoter`.

`kf_migrator` owns structure and is **the only role permitted DDL**. `kf_app` is the API: it
reads, and writes domain rows through actions only. The separation means a compromised
application role cannot alter a policy, drop a constraint or add a table outside the boundary
registry.

The deployment gives each service a distinct unprivileged system account, with one deliberate
exception: backup and restore-drill share one, because they need exactly the same secrets and
the same archive, and inventing a second identity for the same authority would be theatre.

**KF-SAS-RQ-072.** Exactly one database role SHALL be permitted schema changes, and the
application role SHALL NOT hold it.

## 38. Row-level security

RLS is **enabled** on 139 distinct tables by literal statement, and **forced** — so that even a
table's owner is subject to it — on 66 of them, with one `format()` loop covering `ml.*`
dynamically. The live database reports 113 of 139 forced, measured on the running instance and
recorded in `deploy/postgres/planner.conf`.

Those two figures do not reconcile from the migrations alone, and §100.15 records that as an
open item rather than assuming the difference away. **73 tables are enabled by a literal
statement and forced by none**, and enabled-without-forced means the table's owner bypasses the
policy. The owner is `kf_migrator`, which the application does not run as (§37), so this is not
an application-visible hole — but it is not the guarantee KF-SAS-RQ-073 states either, and it is
recorded here rather than left to be discovered.

Two kinds of count appear in this document because two things are being counted: statements in
migrations, and tables in a running database. §103.3 says which to cite for what.

The policies scope every read to the bound organization and classification rank. ADR 0003
records why they sit on `core.object` and not on the 77 typed tables that hang off it.

A caution that is part of the architecture, not an accident: the boundary registry
(`docs/architecture/master-record-boundary.json`) is built by reading `alter table … enable row
level security` statements **literally** from the migrations. A table brought under RLS by a
`DO` loop is invisible to that scan. That is why the loop over `ml.*` is called out here, and
why §62 requires new RLS statements to be literal.

**KF-SAS-RQ-073.** Row-level security SHALL be forced, not merely enabled, on every table
holding governed records.

**KF-SAS-RQ-074.** A table brought under row-level security SHALL be declared in a form the
boundary registry can discover statically.

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

A census found 4 of the 438 policies with three or more `EXISTS` clauses. Three siblings in
`ml.*` are unmeasured because their tables are empty, and that is recorded rather than assumed
benign.

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
slower.

**KF-SAS-RQ-076.** Planner settings that a measurement showed to be load-bearing SHALL be
applied identically in development, test and production, and a gate SHALL assert they agree.

## 41. Triggers and immutability

152 triggers. The pattern they implement is Law 6: a record that states something happened
cannot be edited to state that it happened differently.

An artifact version is a statement that a specific set of bytes existed and was used, so it is
append-only. An audit event cannot be updated. A location may be updated only to record
verification. A public copy may be written only by a publication act and only into a store
declared public, and unpublishing marks it rather than removing it.

Triggers are used where a `CHECK` cannot reach, because a check constraint cannot read another
table. That is a deliberate and repeated pattern, and it is why the count is high.

**KF-SAS-RQ-077.** A record asserting that an event occurred SHALL be immutable after it is
written, except for fields that record subsequent verification of it.

## 42. Check constraints and invariants

`ontology/rules.yaml` declares 15 invariants. Ten came from R01 and are asserted byte-identical
and in order; five are declared additions.

The intent is that every declared invariant is enforced by a database constraint or an action
precondition, and `tests/conformance/rule-implementation.test.ts` maps each refusal code to the
invariant it implements.

The gap is recorded rather than glossed: the R01 pack shipped a `validate_graph.py` that
implements 4 of 10 invariants, and the remaining six exist only in prose — which the
specification's own §27.1 calls nonconforming. Closing that is Phase 2 work that is done in the
database and outstanding in the shipped validator. §100.1 carries it.

**KF-SAS-RQ-078.** Every declared invariant SHALL be enforced by a database constraint or an
action precondition, and the mapping from invariant to enforcement SHALL be asserted by a test.

## 43. Migrations

88 forward migrations, each with a `migrate:down` section. Structure lives only in
`database/migrations/`; the sibling directories for constraints, functions, row security,
triggers and seeds are empty by design, because DDL split across directories is DDL applied in
an order nobody declared.

A migration is promoted, never re-run in place. The deployment installs an immutable release,
verifies its checksum manifest, and switches a symlink atomically, retaining the previous
release for rollback.

**KF-SAS-RQ-079.** Schema changes SHALL be ordered, forward-only in application, and applied
from one declared sequence.

## 44. Reversibility

Seven migrations are not reversible, and that is stated by a test rather than discovered during
an incident. `tests/deployment/migration-reversibility.test.ts` names them.

Irreversibility is acceptable when it is known. A `down` section that silently loses data is
worse than no `down` section, because it invites a rollback that cannot be undone.

**KF-SAS-RQ-080.** A migration that cannot be reversed without loss SHALL be identified as such
by a test, and SHALL NOT present a `down` path that appears safe.

## 45. The registry mirror

`registry` holds the ontology as rows: object types, relation types, action types, state
machines, transitions, and the `requires_capability` column that makes §20 mechanical.

It is seeded from `generated/sql-registry/001-ontology-seed.sql`, which the compiler produces
from the YAML sources under `ontology/`. `tests/database/fresh-install.test.ts` pins the seed's source digest and
the schema version literals, so an ontology change that does not reach the database is caught at
install rather than at first use.

That pinning has bitten, usefully: an earlier literal was stale in a way that made the assertion
a no-op, and the fix was to re-pin on every ontology change. A pinned constant that nobody
updates is a test that stops testing.

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

## 49. Object storage and the working store

Bytes go to an object store with **create-only** semantics: a put to an existing key is refused
rather than overwriting. Combined with digest addressing, this means a key can only ever hold
one set of bytes.

Ingestion distinguishes an authority refusal from a storage failure, so that a failed act does
not leave unreferenced data in the bucket.

**KF-SAS-RQ-094.** Object writes SHALL be create-only, and a failed act SHALL NOT leave
unreferenced content in a store.

## 50. Storage locations

ADR 0017. Where the bytes are is a **set of locations**, each verifiable on its own.

`content.artifact_store` declares a store: an id, a kind, an endpoint, whether it is writable,
and whether it is public. `content.artifact_location` records one version's presence in one
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
drill that restores the newest off-site backup into a scratch database and proves it restored.
A backup is not valid until it has been restored, so the drill runs the **shipped scripts**
rather than a test-only path.

**KF-SAS-RQ-104.** An export imported into an empty database SHALL re-export byte-identically.

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

**KF-SAS-RQ-111.** A master record's identity SHALL be its corpus, and an unchanged corpus SHALL
compile to the same record rather than a conflict.

**KF-SAS-RQ-112.** Staleness SHALL be computed by comparing the current corpus to the recorded
one, not asserted by the writer.

## 59. Projections

ADR 0014. **Master is the exact authorized corpus; everything else is a projection over it.**

`@kf/projections` is one engine. `project(master, definition, params)` returns a canonical
`kf-projection-result-v1` — members, sections, provenance, digests — and `render(result,
format)` turns that into Markdown, HTML, PDF, DOCX or JSON. The web application renders results
generically, so a new definition needs no UI code.

Two invariants hold over every result, and both are planted against:

- **⊆-corpus.** Every member of a projection is a member of the master corpus. A definition that
  reaches outside it fails.
- **Coverage.** Sections partition the corpus; a Raw Corpus remainder is always appended, so a
  definition that omits a member fails rather than hiding it.

Core definitions are pack-shipped in `ontology/projections.yaml` — four today — so they are
compiled, R01-gated and signed with the pack. Organization-authored custom definitions are
controlled database records referencing the pack-declared grammar.

`agent_context` is a projection definition, not a format. That is the point: a reading for an
agent is subject to the same two invariants as a reading for a person.

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

**KF-SAS-RQ-116.** The projection grammar SHALL be closed and non-executable, and every
definition SHALL be statically bounded in depth, size and runtime.

## 61. Object Views

ADR 0015. An Object View is a projection anchored at one object, over the reader's own corpus.

The family is generated from ontology metadata, so **every** object type is browsable with no
per-type code: overview, relationships at depth one in both directions — which yields backlinks
for free — provenance, history from audit events, documents, and the actions the ontology
declares for that type.

`GET /objects/:id` is the read. Adding a new object type to the ontology makes it browsable
without a UI change, and that is the acceptance test for the design.

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
explicit rather than incidental.

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

**KF-SAS-RQ-121.** Search SHALL use one index for all audiences, filtered at read time by the
same authorization context as every other read.

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

`@kf/warrants` owns all 32 §67 action names, in four groups: eight contract acts, twelve
execution acts, six evidence acts and six terminal acts. Every one of them now performs a typed
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

The leak is stated rather than glossed: **a different registry compiles and is then rejected by
the database.** The seam is real in the compiler and absent below it. `ontology/meta.yaml` still
pins an `OH-` enterprise identifier pattern, and `generated/` inherits it.

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

**KF-SAS-RQ-142.** The full work-control path SHALL be reachable through declared actions alone,
and an end-to-end test SHALL exercise it without direct table writes.

## 74. Product configuration and quality

`product` holds products, configuration items and baselines. `quality` holds controlled
documents, corrective actions, suppliers and training records. `engineering` holds decisions,
changes, requirements, risks and tests.

The same restriction as §73 applies to their end-to-end test, for the same reason.

**KF-SAS-RQ-143.** Product configuration, quality and engineering records SHALL be governed by
the same object, act and audit model as every other record, with no privileged path.

---

# Part VIII — Interfaces

## 75. The HTTP surface

`@kf/api` exposes typed reads and typed actions. It holds no authority of its own: every write
is a dispatcher call and every read is bound to a resolved access context.

`tests/permissions/api-actions.test.ts` asserts the property that matters — **the API is not a
second way in.** Every refusal the dispatcher makes, the API makes.

Notable reads: `GET /master-record` and `POST /master-record/compile`; `GET /objects/:id` and
`GET /objects/:id/access?person=`; `GET /documents/:id/source`; `GET /identifiers/:id`; the
signed public publication route.

**KF-SAS-RQ-150.** The HTTP layer SHALL hold no authority of its own, and SHALL make no refusal
the write path does not.

## 76. The command line

`kf` is the operator and ingestion interface. `kf ingest` drives the planner and the typed
document actions. `kf:grant-authority` performs the three acts that used to stand between a
verified token and a usable session — link the subject to a person, assign a role, grant a
clearance — as one command that records a real act and extends the audit chain.
`kf:declare-service-actor` declares a service person (§21).

Two rules the CLI enforces because they are cheap there and expensive later: **no inline bearer
tokens** — `--token-file` only, refusing `--token` by name — and refusals printed verbatim
before any credential or database is opened.

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
`kf-projection-result-v1`, `kf-master-record-boundary-v1`, `kf-publication-v1` — so a format
change is a new tag rather than a silent reinterpretation of old bytes.

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

Six of them, and the fact worth recording is that **every one was discovered by failure**, not
by design:

1. **pandoc**, on `PATH`. A host without it answered every document import with HTTP 500 and
   logged `spawn pandoc ENOENT`. Undocumented until 2026-08-18. The version is deliberately
   unpinned (§52.3).
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

The general lesson is a requirement in its own right, because it is the reason five of the six
were found late.

**KF-SAS-RQ-161.** Every host requirement SHALL be stated and probed, and provisioning SHALL be
exercised on a minimal image rather than on one whose defaults hide the dependency.

## 86. Release and promotion

The workstation build is promoted **byte-for-byte**. The private host does not run a build,
resolve a newer dependency, or substitute source from another checkout.

Installation is immutable: a release is installed at a new path, verified against its checksum
manifest, and `/opt/kf` is switched atomically. The previous release is retained for rollback.
Nothing is ever rebuilt under the live path.

A release tree must not depend on anything outside itself, and the verifier must say so —
`tests/deployment/release-self-contained.test.ts` is the gate.

**KF-SAS-RQ-162.** The artifact tested SHALL be the artifact deployed, promoted without
rebuilding, and installation SHALL be atomic and reversible.

## 87. Services and timers

Twelve services and six timers, each with an unprivileged account.

| Service | Does |
|---|---|
| `kf-api` | the API |
| `kf-web` | the web workbench |
| `kf-worker` | background work, including outbox delivery |
| `kf-migrate` | applies one verified migration set |
| `kf-checkpoint` | signs a Merkle checkpoint over the audit log |
| `kf-storage` | replicates and re-verifies artifact copies as the storage service actor |
| `kf-backup` | takes and records a backup |
| `kf-backup-offsite` | copies the newest backup off the host and verifies it there |
| `kf-restore-drill` | restores the newest off-site backup into a scratch database and proves it |
| `kf-readiness` | checks the system is in the state it is supposed to be in |
| `kf-alert-heartbeat` | proves the alert path still reaches a person |
| `kf-alert@` | reports that a named unit failed, to a person |

Timers: checkpoint hourly, readiness every fifteen minutes, backup and storage sweep daily,
alert heartbeat daily, restore drill monthly.

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

## 89. Checkpoints

An hourly signed Merkle checkpoint over the audit log, produced by `apps/checkpoint` — a
**separate process precisely so the Ed25519 signing key is not reachable from the API**. It runs
in two modes, `--run` and `--verify`, so the same code that signs can check.

Host preflight includes proving that the API service account cannot read the private key.

**KF-SAS-RQ-167.** Audit checkpoint signing SHALL run in a process the serving application
cannot reach the key of, and that isolation SHALL be evidenced on the host.

## 90. Readiness and alerting

`kf-readiness` runs every fifteen minutes and checks the system is in the state it is supposed to
be in — not that it responds. §91.2 states the distinction that makes this worth having.

## 91. Commissioning

**91.1 The boundary.** `docs/deployment/private-host.md` is a deployment contract, and its own
first paragraph refuses to be read as anything else: it is not a production claim, a
commissioning record, or evidence of institutional readiness. A host may serve records only after
every required control has been exercised **with evidence from that host**.

**91.2 Availability is not approval.** The strongest sentence in the operational documentation is
the instruction never to treat service availability as institutional approval. A system that
answers requests has proven it is running. Whether it is authorised to hold records is a
different question and is answered by evidence, not by uptime.

**91.3 Preflight.** Nine numbered checks before any shared user is admitted, including: a valid
bearer succeeds while a wrong issuer, wrong audience, unknown subject and revoked identity all
fail; fixed-identity headers are ignored; the API account cannot read the checkpoint key. And
then: **reboot the host and re-run them.** A service that works only in the install shell is not
deployed.

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

**KF-SAS-RQ-170.** Every documented control SHALL cite the artifact that proves it, and a gate
SHALL verify that every cited path resolves.

## 93. What operations cannot supply

Three things that no amount of engineering in this repository produces, stated so that a plan
which assumes otherwise is recognisably wrong:

**93.1 A commissioned host.** Nothing here creates one. Four of the five v1.0 criteria queue
behind that single fact, and one of them carries a seven-day floor that cannot begin counting
until a host exists.

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
copy states the exact accepted revision and its digest. Where this document describes behaviour
the code does not have, the code is right and this document has drifted: the remedy is a new
revision, not an edit to the accepted one.

**KF-SAS-RQ-180.** This specification SHALL be governed by digest, its accepted revisions SHALL
be immutable, and acceptance SHALL be performed by a human actor.

**KF-SAS-RQ-181.** Every copy or export of this specification SHALL state the accepted revision
and digest it reproduces.

## 95. Change procedure

1. Open a decision record stating the problem, the measurement and the options.
2. Propose a revision of this document; the proposal records the digest and the §106 diff.
3. Supersede or amend the Warrants the change affects.
4. Preserve the original requirement and its evidence history. A requirement that turned out to
   be wrong is superseded, never erased.

## 96. Decision records

Twenty-two accepted decision records live in `docs/decisions/`. They are the program's reasoning,
and this specification is downstream of them: where a section here states a rule, the ADR that
decided it says what was measured and what was rejected.

The supersession graph, which nothing else in the repository states in one place:

| Relation | Records |
|---|---|
| superseded | 0008 by 0011; 0009 by 0022 |
| partially superseded | 0004's licence half by 0005; the rest of 0004 stands |
| amended | 0011's identity key by 0013 |
| builds on | 0014→0013; 0015→0014; 0016→{0008, 0011, 0013}; 0017→{0004, 0006}; 0018→{0006, 0016}; 0019→0018; 0020→{0016, 0017}; 0021→{0006, 0016}; 0022→0009 |

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

**100.1 Six invariants exist only in prose.** The shipped `validate_graph.py` implements 4 of 10.
The database enforces them; the distributed validator does not. Bears on KF-SAS-RQ-078.

**100.2 Relation types declare no source or target types.** Nothing constrains which object types
an edge may connect. 41 relation types raise the warning, counted rather than forgotten. Bears on
KF-SAS-RQ-070.

**100.3 The product/instance seam holds in the compiler and not below it.** A different registry
compiles and is then rejected by the database, because an `OH-` pattern remains pinned in an
approved pack. Bears on KF-SAS-RQ-139, and §70.2 explains why un-pinning it is a governance act.

**100.4 Replication and verification are not scheduled anywhere.** The service and timer exist;
no host runs them. Bears on KF-SAS-RQ-097.

**100.5 The checkpoint runner and the ingestion path address the working store directly**, rather
than through the store registry. Reads degrade correctly; writes reach one store. Bears on
KF-SAS-RQ-095.

**100.6 Two schema packs are signed snapshots that no longer describe their source**, admitted
with reasons, and one registry pack is in the same state. Each is an admission that a re-cut and
a fresh human signature are owed.

**100.7 Three ML policy predicates are unmeasured** because their tables are empty. They are
siblings of the one that cost 950 ms to count three rows. Bears on KF-SAS-RQ-075.

**100.8 Delegation depth is unbounded.** `delegated_from` is recorded; no rule yet says how far a
delegated grant may go. Bears on KF-SAS-RQ-039.

**100.9 Role assignments and project memberships do not expire.** Grants are effective-dated; the
two mechanisms that project into them are not.

**100.10 No host has ever been commissioned.** Phase 9 is not started. Four of the five v1.0
criteria queue behind it, and one carries a floor that cannot begin counting until it exists.

**100.11 Continuous integration has never been green on a tagged commit**, which is a v1.0
criterion in its own right.

**100.12 Cross-repository requirement resolution does not exist.** A Warrant in another
repository can cite `sas://KF-SAS-RQ-NNN`, and no tool resolves it against this document. The
citation is a claim, not a checked reference. Bears on KF-SAS-RQ-184.

**100.13 The release pack asserts its own manifest is unsigned** even after signing, because the
gap list is composed at build time and travels into the approval unchanged. Cosmetic, and
recorded rather than quietly corrected.

**100.14 This program's verification independence is nil.** All nine dimensions are recorded
`false` in `openwarrant.toml`. This repository is authored and verified by one person working
with one agent. Role separation by one person is not organizational independence, and an absent
field would read as unexamined where `false` reads as examined and absent.

**100.15 Seventy-three tables are enabled for row-level security and forced by no literal
statement.** The live database reports more tables forced than the migrations statically force,
and the difference is not reconciled. Until it is, KF-SAS-RQ-073 is not evidenced for those
tables. §38 states what is known. Found by the review of this revision, which is the reason it
appears in the first revision rather than a later one.

**KF-SAS-RQ-184.** A requirement cited from another repository SHOULD be resolvable against this
document by a tool, and until it is, such a citation SHALL be treated as an unverified claim.

**100.16 The organization's legal name is compiled in, not configured.** Three lines in the
dogfood bootstrap name OpenHuman Technologies LLC. Bears on KF-SAS-RQ-192 and on §100.3, of which
it is the remaining application-side half.

**100.17 The phase ladder is full against a hard cap.** §98 uses phases 0 through 10, and the
tooling that reads them caps a phase number at 10. A twelfth objective — a data-primitives phase,
for instance — cannot be added without restructuring the ladder. Recorded rather than worked
around, because renumbering objectives would break every reference to them.

**100.18 None of ADR 0024's latency bars is measured, and two of its capture surfaces do not
exist.** There is no chat integration and no cheap capture path; the command line writes through
full acts and the web application has no capture form at all. The bars are stated so they can
fail; today nothing evaluates them. Bears on KF-SAS-RQ-200 through RQ-203.

**100.19 How an agent authenticates when acting for a named human is undecided.** ADR 0020's
service actor acts for itself and is barred from institutional acts, which is a different case
from an agent forming an act on a person's behalf. KF-SAS-RQ-204 states the requirement; nothing
implements it.

**KF-SAS-RQ-186.** The set of tables forced under row-level security SHALL be derivable from the
migrations, and any difference between that set and the running database SHALL be reconciled.

## 101. Refusal vocabulary

The named refusals a caller may encounter, gathered so that "what can this system say no with" is
answerable in one place. The dispatcher's twelve codes are in §28. Beyond them:

| Refusal | Raised by |
|---|---|
| `unknown_subject` | an authenticated identity not linked to a person |
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

Named formats in use: `kf-action-request-v1`, `kf-action-idempotency-lock-v1`, `kf:audit-chain:v1`,
`kf-projection-result-v1`, `kf-master-record-boundary-v1`, `kf-publication-v1`, and this
document's revision schema `oh.war/sas-revision/v1`.

## 103. Document conventions and provenance

**103.1** Section numbers are stable. A section may be added at the end of a part; existing
numbers are not reused for different content.

**103.2** Requirement identifiers are append-only (§97.2) and are the only stable reference this
document offers to outside work. Cite a requirement, not a section number, from another
repository.

**103.3 Counts.** Two kinds appear here and they answer different questions. A **source count** is
derived from the repository — migrations, statements, declared types — and moves when the source
moves. A **runtime count** is measured against a running database and is cited only where the
runtime is the subject, as in §38 and §40. Where they differ, both are given and labelled. Counts
in this revision were taken on 2026-09-03 and are not gated: they are the most perishable claims
here, and a reader checking one should re-derive it rather than trust it.

The database source counts were derived by taking each migration's up-section only — everything
before its `-- migrate:down` marker — and counting statements across the concatenation. The
per-file truncation matters: 124 `drop table` statements exist in this repository and every one
of them is in a down-section, so a count that reads whole files reports a schema that is created
and then destroyed. Truncating the concatenation instead of each file is worse and quieter: the
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
| `0.1.0-draft.3` | 2026-09-04 | Adds §8A and five requirements making speed of capture and retrieval architectural rather than product polish, after the observation that a records system engineers skip records nothing ([ADR 0024](../decisions/0024-friction-is-an-architectural-property.md)). Records that capture is cheap and governance applies at promotion, that several surfaces share one act model, and that an agent may act for a named human. Five requirements appended, none removed or retitled; architecture-changing, carrying ADR 0024. |
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
| KF-SAS-RQ-038 | Clearance is organization-scoped and effective-dated; the ceiling is the minimum |
| KF-SAS-RQ-039 | Read authorization is row visibility intersected with live grant coverage |
| KF-SAS-RQ-040 | Live grants for one principal, scope and capability do not overlap in time |
| KF-SAS-RQ-041 | The read path and the write path consult the same grant view |
| KF-SAS-RQ-042 | Any access decision is explainable as a path to the deciding grant or exclusion |
| KF-SAS-RQ-043 | An institutional act requires an act grant reaching every locked target |
| KF-SAS-RQ-044 | Which actions are institutional is declared in the ontology, not in control flow |
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
| KF-SAS-RQ-150 | The HTTP layer holds no authority and makes no refusal the write path does not |
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
| KF-SAS-RQ-181 | Every copy states the accepted revision and digest it reproduces |
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
