# ADR 0030 — The system is three layers, and the specification says so in one place

- **Status:** proposed, 2026-09-14
- **Builds on:** ADR 0002, ADR 0010, ADR 0013 (the compiler is a consumer),
  ADR 0023 (business logic above, data primitives within), ADR 0028 (the retrieval index).

## Context

Anyone asking "how is this built" had to assemble the answer from ADRs 0002, 0010 and 0013 for
the compiler, §8.10 and KF-SAS-RQ-190 for business logic, ADR 0023 for the scope boundary, and a
README for the shape that holds them together. Every piece was written down. The structure they
form was not, anywhere, with an identifier.

That is the failure a Software Architecture Specification exists to prevent. A specification whose
architecture must be reconstructed from fifty documents is not doing the one job it has, and the
clearest statement of this system's structure existed in conversation and in a README rather than
in the document that governs it.

The README's account then outran the specification on a structural claim — it placed the retrieval
index inside the compiler's boundary, which the specification had never heard of. That is the
predictable consequence of leaving the architecture unstated: the informal description becomes the
only description, and it drifts without a gate.

## Decision

**§8B states the three layers normatively, in one place, with requirements.**

**Layer 1, the kernel.** PostgreSQL holds the rules. Row-level security, triggers, check
constraints and foreign keys decide what a caller may see and change. One dispatcher is the only
way to write. A defect in any layer above cannot widen what a reader may see — which is
KF-SAS-RQ-002 restated as a property of the structure rather than of one mechanism.

**Layer 2, the compiler.** Reads the kernel and writes nothing to it. Produces the master record —
exactly the set of records one person may see at one moment — and projections over it: a page for
a person, a context bundle for an agent, a view of one object and its neighbours. The retrieval
index sits inside this boundary under ADR 0028, derived and never authoritative.

**Layer 3, workflows.** Business rules, integrations, and every surface through which a person or
an agent reaches the Fabric. Invoicing arithmetic, scheduling, CRM, the web application, the
command line, chat, agents. All of them dispatch the same acts through the same seam, and none
touches storage directly. This is ADR 0023's §8.10 stated positively rather than only as a
non-goal.

**The invariants that hold across the layers**, and which are what the requirements pin:

- no layer above the kernel may widen what a reader sees;
- no layer may write except as an attributed act through the dispatcher;
- each layer above reads only what the layer below authorised it to read;
- a layer may be replaced without the layers below it changing.

**The description is normative; the vocabulary is explanatory.** §103 records that the prose
describing the layers may be rewritten by a later revision, while the requirements pinning the
invariants may not. Framings are refined and this one has been refined twice in a week; the
invariants have not moved. Requirement identifiers are append-only under §97.2, so what is
appended must be the part that is stable.

## Consequences

- "How is this built" is answerable from the specification, at a section number, without
  reconstruction.
- The README becomes a projection of §8B rather than an independent account, so the two can be
  checked against each other instead of drifting.
- The layer model is refinable. Rewriting the prose is an ordinary revision; changing an invariant
  is a decision record.
- A fourth layer, or a split of an existing one, is an ordinary appended requirement rather than a
  restructuring, because the invariants are stated over layers generally rather than over three
  named ones.

## Provenance

Drafted by an agent under direction, per §103.5. The three-layer framing is the owner's, stated in
their own words before any document carried it; this record writes it down and pins the part that
should not move. Acceptance is a human act under §94.2.
