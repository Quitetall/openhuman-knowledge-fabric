# ADR 0028 — The retrieval index holds vectors and identifiers; authorization crosses the wire as a mask

- **Status:** proposed, 2026-09-14
- **Extends:** ADR 0016 (access is a grant), ADR 0027 (access is a grant on every read),
  ADR 0010 (the Liminal-backed compiler is deferred), ADR 0023 (business logic above,
  data primitives within).
- **Supersedes:** the "no `pgvector`" rationale recorded in
  `database/migrations/20260811001800_search.sql`, on the condition that rationale set.

## Context

The README named a retrieval database inside the compiler's boundary and the specification had
never heard of one. `\bRAG\b`, `\bLAMU\b` and `\bvector\b` each return zero files across
`docs/sas` and `docs/decisions`. §104 lists four neighbouring programs and the retrieval engine
is not among them. So the question was not how to build retrieval — it was whether the thing
already written into the README had any architectural home at all.

The code was ahead of both. `20260811001800_search.sql:7-13` refused `pgvector` with reasons and
named the condition for revisiting: "Canonical search has to work first… Embeddings can be added
later, ON TOP, and the shape here is what makes that safe: this table is derivable, so a second
index alongside it changes nothing about where authority lives." Canonical search shipped. The
condition is met, which is why this record supersedes that rationale rather than contradicting it.

**What made the question hard.** An embedding is a lossy copy of content, and KF's access model
is built on the opposite of copies. A pointer whose target you may not read shows you nothing; a
copy you already hold shows you everything, and revocation becomes a distributed protocol rather
than a commit. KF never deletes — Law 6 retires by sequester — so `on delete cascade`, the one
mechanism that would have been free, never fires. Revocation here means reclassification or a
withdrawn grant, and both must take effect on the next read.

**The precedent, and a defect found while looking for it.** KF has already made this bargain
once. `search.document` holds `body text` — the assembled plaintext of every controlled document
since `20260812000100` folded parsed atoms into it — and `search_document_read` filters on the
table's own **denormalised** `classification`, not on a join back to `core.object`. The column is
refreshed by `search.index_object` through the outbox, and `apps/worker/src/outbox.ts` states, at its head,
that delivery "is allowed to be late." So between a reclassification committing and the outbox
draining, the search index evaluates a stale rank over live plaintext. Recorded as a gap in its
own right; it is the failure this decision exists to avoid repeating one level down.

**Measurement of the candidate engine.** LAMU persists to SQLite. Counting call sites in
`lamu-memory/src` gives 100 in `lifetime_memory.rs`, 87 in `store.rs`, 46 in `tv_store.rs`, 34 in
`ppr.rs`, 31 in `causal_graph.rs`, 22 in `entity_store.rs` and 14 in `hyper_store.rs` — on the
order of three hundred, with the two sessions that measured independently agreeing on the
distribution and differing on the total by counting method. Ten capabilities are feature-gated:
`turbovec`, `hyperbolic`, `entities`, `assoc`, `consolidate`, `query_expand`, `rerank`,
`retrieval_engine`, `learned_fusion`, `hyte`. A vector store substitution replaces exactly one of
the ten — the semantic cosine leg. The three-geometry model and the BRIGHT-validated gains
(`query_expand` +9-24% nDCG@10, `rerank` +7.6%) do not come from the index.

**The correction that decided it.** This record initially asserted that an approximate index
returns a global top-k and filters afterwards, collapsing recall for a caller cleared for a small
fraction of the corpus, and that the engine had no mechanism for it. That was wrong. LAMU
ADR 0043, accepted 2026-06-14, ships `search_with_mask(q, k, mask: Option<&[bool]>)` with SIMD
block-skip, in its own words "masked-out vectors are never scored, not merely post-filtered", and
the brute-force backend honours the mask too, so the mechanism is not gated behind an optional
feature. Filtering happens **inside** the scan. §64's "one index, many audiences, filtered at read
time" is therefore satisfied more literally by a masked scan than by any post-filter.

## Decision

**The retrieval index is inside KF's trust boundary and outside its authority boundary.** It is
derived, disposable and rebuildable in full from authoritative rows, exactly as `search.document`
is, and KF-SAS-RQ-010 already forbids it from being authoritative for anything. It is not a
neighbouring program under §104 and Law 1 does not apply to it; it is a second derived index
beside the first.

**The role is named; the implementation is not.** The specification names a _retrieval index_.
LAMU is the engine run in that role. A specification that names an implementation cannot change
the implementation without a revision.

**The index holds `(vector, object_id)` and nothing else.** No body, no title, no classification,
no metadata — and specifically no authorization input at rest. Every hit is resolved through
`read-grant.ts` before anything reaches a person or an agent.

**Authorization crosses the wire as a mask, computed per query from live rows.** KF derives band
membership bitmaps from `core.object`, keyed `(band_version, lamu_generation)`, and ships them by
version rather than per query. The engine caches them **in memory only**, ORs the bands at or
below the caller's ceiling, applies the per-object allow bits, and scores only unmasked slots.
There is no denormalised copy of the decision and no denormalised copy of the decision's input,
so reclassification takes effect on the next query with no outbox, no window and nothing to
coordinate.

The shape this relies on is already present: `enumerateAccessCoverage` runs **once per request**
against `org.effective_access_grant` under the caller's RLS, and `AccessCoverage` reduces to one
ceiling over four bands plus a small explicit per-object allow map, with `coveringGrants` pure and
synchronous thereafter. A session's read authority is a compact predicate, not an enumeration.

**A short mask pads false, never true.** Slots are append-only and positional — a stated contract
at `tv_store.rs:1306` — so a mask shorter than the index means exactly "the newest vectors are not
authorized yet". Fail-closed by construction, and it cannot produce a rebuild storm the way
refusing the query could. The cost is that freshly embedded content is briefly unsearchable, which
is a recall delay on new data rather than a disclosure. The length check is a hard runtime
refusal, not the `debug_assert_eq!` that ADR 0043 records, which compiles out of release builds and
would let a short mask mis-scope silently.

**The version token covers both sides.** A bitmap is indexed by slot order, so it is invalid if
the slot map moved even when nothing was reclassified. `(band_version, lamu_generation)` covers
both, published at the existing `meta.json` commit point, and any mismatch takes the pad-false
path rather than serving a mask built against a different slot order.

**A degraded engine refuses; it never returns a short result set.** `retrieval_unavailable` is an
explicit error. Where KF falls back to lexical search, the response carries a withholding-ledger
entry under KF-SAS-RQ-120 stating that semantic ranking was unavailable. This is not a new flag:
a ledger entry carries its basis and a boolean does not, and an agent that cannot distinguish a
degraded answer from a complete one acts on it as complete.

**The trace is derived and stays derived.** "What was disclosed to whom" is an authorization fact
and belongs to KF under Law 1. KF's read audit records a digest of the engine's retrieval trace;
the trace itself is disposable in the engine. No requirement names the retrieval engine as an
authority for anything inside KF.

**Vectors are encrypted at rest under a key KF releases at startup**, making "the engine is a
compute dependency, not a store" literally true: without KF the index is inert. No date is
recorded here, because the work needs its own Warrant and a date not yet earned is not evidence.

**No controlled content leaves the host to be embedded.** The embedder is pinned local-only, a
non-local provider resolving is a hard startup refusal rather than a warning or a null, and
`kf-commissioning` asserts the binding. Enforcement is on both sides: the engine, because only it
knows which provider actually resolved, and KF, because a control the engine enforces is a control
the engine can be built without. A control on one of two paths gets missed on the other, which is
the lesson `20260816000100_search_visibility_boundary.sql` already wrote down in this repository.

**The composition root registers the embedder exactly once.** A second registration with a
differing identity is refused, and clearing the registration does not enable a non-local provider.
This is stated as an obligation rather than an observation deliberately: the engine's own
`set_global` documents "a second call replaces the first (last registration wins… the identity is
the same _in practice_)", and `clear_global` is documented as a seam for a composition root that
wants to force the keyed fallback. First-use model validation is sufficient only while the chain
is single-registration, so the constraint has to bind the code rather than describe it.

**The socket protocol is the compatibility contract.** KF pins a protocol version, never an engine
version. Everything behind it — all ten arms, new fusion, new rerankers, index format changes, the
compressed-index work — ships on the engine's cadence with no KF deployment.

## Options rejected, with what killed each

**A Postgres extension via `pgrx`.** Attractive because it dissolves the boundary entirely:
algorithms run in the backend, over KF's tables, under KF's RLS, in KF's transaction. Two
structural blockers. The recall path is async and the embedder trait is `async fn embed` over HTTP
to an inference server, so a backend would hold a transaction snapshot open across a GPU round
trip — bloat and vacuum starvation, not a tuning matter. And a panic in ranking code is not a lost
session: PostgreSQL treats any backend crash as possible shared-memory corruption and restarts the
whole cluster.

**Porting the engine onto PostgreSQL.** Preserves all ten arms and puts everything in one
transaction domain. Costs the three hundred call sites and the three persistent index lifecycles,
and trades a compressed quantized index for `pgvector`'s. Decided against on the engine's own
recorded scope: its ADR 0078 already assigns authorization to KF and context assembly to itself,
and its ADR 0074/0075 targets are public million-scale corpora with no clearances, where the
compressed-index work has to win. KF is one consumer, so the port buys KF a great deal and costs
the engine its reason for existing.

**`pgvector` alone.** Cheapest, and the access story is free. Replaces one of ten capabilities and
discards nine, including the three-geometry model and both BRIGHT-validated gains. Rejected as a
trade of nine working things for one boundary that a mask already closes.

**SQLite with an emulated row-security convention.** Rejected on four grounds, in descending
severity. SQLite has no policies, so enforcement reduces to "the application only reads views",
and KF-SAS-RQ-002's whole value is that the rule holds when the application is defective. It has
no session GUCs, so the natural workaround is a per-connection temp table — and the engine pools
connections, so a pooled connection hands its state to the next borrower, which is a cross-caller
leak by construction and intermittent. The quantized index sidecars are flat files outside SQLite
with no access control at all. And the engine's `owner` is tenancy — one string equality — where
KF clearance is a lattice with per-record grants, delegation, effective dating and a withholding
ledger; that is not a port but a replacement of the access model.

**Generation stamps alone, without masks.** Closes the revocation window by refusing service on a
stale index. Kept as a component — the version token above is exactly this — but rejected as the
primary mechanism, because refusing service on every reclassification produces rebuild storms
where masking produces nothing at all.

## Consequences

- Revocation is a commit, not a protocol. Reclassify a record and the next query masks it out.
- The recall-collapse failure does not arise: masked slots are never scored, so a caller cleared
  for a small fraction of the corpus asking for fifty receives fifty.
- The withholding ledger does not apply to near misses. An unauthorized record never becomes a
  candidate, so there is nothing withheld to report — which matters, because "four near misses
  withheld" would disclose the shape of a semantic neighbourhood that is unbounded and steerable
  by choice of query, a far worse bargain than §63's fixed-corpus disclosure.
- The engine keeps its release cadence. Roughly a dozen versioned messages cross the boundary;
  everything else is internal.
- A global approximate index over the whole corpus remains possible, because masking happens
  during the scan rather than after it. The scale ceiling that filter-first would have imposed
  does not apply.

**The residue, stated rather than implied.** Vectors are plaintext in the engine's address space
while it serves. Anyone who can attach to the process or read a core dump reconstructs a degraded
version of the embedded content, and sentence embeddings invert well enough for that to matter.
At-rest encryption does not remove it. It is the irreducible floor of doing compute outside the
kernel, no design on the list above removes it, and it is recorded as an accepted limit with a
named remedy rather than left to be discovered.

**Unwritten at the time of this record**, so that nothing here reads as existing. On the engine's
side: the mask predicate is one string equality on tenancy rather than clearance; there is no
entry point accepting an externally supplied mask; there is no socket server; at-rest encryption
does not exist; the embedder is not pinned. On KF's side: there is no band-bitmap builder and no
embed-on-ingest path. Seven items.

**Retroactive exposure, measured 2026-09-14.** 2070 rows embedded through the external provider,
all of them LongMemEval haystack turns — public benchmark data — in a single 91-minute burst on
2026-07-10 that the engine's own project record identifies as a deliberate launch-validation run
with an external-embed arm. Repository RAG over source trees: zero rows, never populated.
Conversation memory: zero rows, and no embedding column. Non-benchmark memories: fifteen, all
local models. No private content, no source, no conversation history. The measurement speaks only
to what the store holds now. It does not weaken the pin: nothing sensitive was disclosed because
the local path happened to be registered, not because the fallthrough was closed.

## Provenance

Drafted by an agent under direction, per §103.5. The masked-scoring correction, the two `pgrx`
blockers, the bands-by-version design and the `set_global` finding came from the session working
on the retrieval engine, which reviewed and corrected this analysis in four exchanges; the
`search.document` staleness finding, the `AccessCoverage` measurement, the stale-scope-tag defect
in the first form of the mask design and the embedder disclosure path came from this side. Both
sessions verified the other's load-bearing claims against source before accepting them, and two
claims were retracted in the process. Acceptance is a human act under §94.2.
