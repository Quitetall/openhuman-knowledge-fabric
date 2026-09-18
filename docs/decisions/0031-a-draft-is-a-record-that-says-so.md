# ADR 0031 — A draft is a record that says it is unverified, and one gesture may produce many acts

- **Status:** proposed, 2026-09-14
- **Extends:** ADR 0012 (ingestion: copy or reference), ADR 0024 (friction is architectural),
  ADR 0029 (transient observations).
- **Bears on:** KF-SAS-RQ-021, RQ-202, §48 ingestion, §62 the master-record boundary, §63 the
  withholding ledger.

## Context

The corpus is meant to be browsable, downloadable, and worked on offline, with a single gesture
to put changes back. Stated that way it collides head-on with KF-SAS-RQ-021, accepted since
`0.1.0-draft.1`: _ingestion SHALL admit external content one named item at a time, and SHALL NOT
provide recursive synchronisation of an external container._ "Sync my folder into the store" is
the named non-goal, almost word for word.

The collision turned out to be in the mechanism and not the intent, and resolving it took two
exchanges of reasoning that neither the specification nor this repository records anywhere. That
is the argument for this record: the next person will re-derive it, and may derive it differently.

**What RQ-021 actually forbids** is a container becoming a record set with no decision in it. It
says nothing about how many acts one gesture may produce. ADR 0024 already made low friction
architectural rather than product polish, and KF-SAS-RQ-202 already permits cheap capture as a
draft, attributed from the first moment, with promotion as a separate act. The three are
consistent once the distinction is drawn explicitly.

**What the investigation found, and what changed the sequencing.** `draft` is the initial state of
every state machine in `ontology/state-machines.yaml`, and **nothing filters on it anywhere** —
not master-record membership, not the preservation export, not projections. A draft is a full
corpus member today, distinguishable from a decided record only by a column no reader consults.

So the "special set of rules" that unverified material was assumed to have does not exist. It is a
label. Building the fast capture path first would put unverified material inside master records and
inside the permanent preservation export, indistinguishable from records somebody checked — which
is worse than the folder of files this program exists to replace, because the folder never claimed
to be the record.

## Decision

**One gesture may produce many acts. It may not produce zero, and it may not produce one act
covering many items.**

Zero acts is folder synchronisation: unattributable, and what RQ-021 forbids. One act covering
many items is "I admitted this folder", which is the same container decision reached by a
different route. Many acts from one gesture is cheap capture with full attribution, which is what
RQ-202 already blesses. The person clicks once; the ledger receives one entry per item, each
naming them.

**A draft is a record.** Law 6 applies to it, it is attributed and audited from the moment it is
written, and it appears in the preservation export marked as a draft. Excluding it would create a
class of stored thing that can vanish, and ADR 0029 defined that category deliberately narrowly.

**A draft is a member of a master record, and the projection says it is unverified.** A master
record that silently omits is the failure §63's withholding ledger was written against, so
omission is not available. What is available — and required — is that the reader can tell which
members nobody has checked. An unlabelled draft inside "everything you may see" is worse than an
absent one, because it borrows the credibility of the records around it.

**A draft SHALL NOT be citable as evidence.** A Warrant tracing to an unverified document is a
claim resting on something nobody has checked, which is the ticked box §97.3 exists to prevent.
This is the one place where a draft is not a record like any other, and it is the place where the
distinction earns its keep.

**A promotion act records its basis: reviewed individually, or promoted in bulk.** Reviewing five
hundred documents one at a time and promoting five hundred in one click are different facts. A
ledger that writes "verified" for both has made the word carry no information, and an auditor
asking "did a person look at this document" then has no answer available. Recording the basis costs
the fast path nothing; it stops the fast path from misrepresenting itself.

## Consequences

- Sync is a fast path **through** the existing machinery rather than around it. Each file becomes
  one draft and one act; verification becomes one act per item from one gesture.
- The sequencing inverts from what it feels like. The lifecycle rules and the projection labelling
  must exist before the capture path that fills them, because the visible part is the last part.
- A mistaken sync is cheap and is recorded as a mistake: drafts withdraw, and the withdrawal is
  evidence rather than an absence.
- Two operational controls are needed and are not decided here: a ceiling above which a bulk
  capture is refused without an explicit override, so pointing sync at the wrong directory does not
  produce ten thousand drafts; and a classification for captured files, which can only default to
  the capturing person's own ceiling, because anything lower is a widening nobody decided.

## Provenance

Drafted by an agent under direction, per §103.5. The low-friction sync model and the
unverified-store framing are the owner's; the gesture-to-acts formulation, the finding that `draft`
is filtered nowhere, and the individually-versus-bulk requirement came from this side. The owner
decided that drafts appear in master records with a label rather than being omitted. Acceptance is
a human act under §94.2.
