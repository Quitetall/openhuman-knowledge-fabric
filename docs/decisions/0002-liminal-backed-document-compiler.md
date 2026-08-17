# Liminal-backed document compiler supersedes the LamQuant documentation model

**Status:** accepted
**Date proposed:** 2026-08-13
**Date accepted:** 2026-08-16
**Decision owner:** technical authority
**Scope:** document source, composition, compilation, projection, ADR integration, editing,
search, publication and AI context planning
**Does not:** approve R01, allocate an enterprise identifier, or resolve
`0001-r01-schema-pack-defects.md`

> **Accepted 2026-08-16.** The compiler slice built against this record — Compilation Basis,
> the pinned Liminal process adapter, HIR and CIR provenance, projection capability levels,
> the document workbench and AI context planning — is the fabric's document model rather than
> a proposal to be judged. The exclusions above are unaffected: acceptance approves an
> architecture, not a release, and it allocates no identifier.
>
> Two consequences a reader should not have to infer. The "considered and rejected"
> alternatives below stay as written and are now decisions: reopening one needs a new record,
> not an argument. And the LamQuant compatibility oracle
> (`packages/documents/src/lamquant-compat/`) is migration evidence for the measured shadow
> cutover this record requires — not a permanent second compiler. The record is explicit that
> two production compilers would be two definitions of current documentation.

---

## Context

The Knowledge Fabric is intended to be the complete integrated authority and user experience
for OpenHuman information. Its document slice currently preserves verified source bytes,
records controlled-document lifecycle facts, parses supported files into ordered and digested
blocks, indexes their text, and exposes them through the API and web UI. Those parsed blocks
are disposable projections. They are not an authoring or composition model.

LamQuant already has a stronger Git-native documentation compiler. It provides authored
section atoms, ordered composition manifests, generated parents, one rooted documentation
tree, closed topic vocabulary, truth-ledger key references, deprecation by sequestering,
append-only ADRs with runnable gates and supersession, generated topic and ADR views,
traceability, and deterministic book output. Replacing LamQuant with the current Fabric would
therefore be a regression.

Liminal defines a broader compiler model: exact-source CST, Human IR, resolved graph IR,
entity/version/anchor identity, immutable Workspace Bases, incremental queries, source maps,
projection capability levels, managed text and rich graph editing, visible overlays, semantic
operations, and separate human, machine and AI compiler targets. That is the intended
compiler substrate for the Fabric. Liminal's present implementation is not yet a production
dependency: its text subsystem remains incomplete and its HAQP-1 packet is proposed,
unratified and `NOT_RUN` at this decision's date.

The systems also have different authority models. PostgreSQL is the Fabric's constitutional
kernel; object storage holds immutable bytes; controlled changes occur through typed actions.
Liminal's graph and Holder machinery must not become a competing operational authority.

## Decision

The Knowledge Fabric SHALL supersede the LamQuant documentation system by implementing a
strict superset of its observable behavior, then extending it with Liminal compilation,
Fabric-native control, web editing, machine projections and AI context planning.

The Fabric owns the product boundary and all institutional authority. Liminal owns document
compiler semantics behind a versioned, pure process interface. LamQuant becomes the locked
compatibility corpus and migration oracle; it does not remain a second production compiler
after cutover.

### 1. Authority and source Holders

Every authored subject SHALL have exactly one declared **Source Holder**:

- `fabric_native`: immutable source revisions controlled by Fabric actions;
- `git`: bytes at one full commit SHA and path, including submodule commit identity;
- `external`: bytes and revision identity supplied by another named document authority.

Fabric-native SHALL be the default for institutional controlled documents. Git SHALL remain
a first-class Holder for engineering sources, compatibility, collaboration and reuse. Git is
not the version-control system for the whole Fabric: approvals, access policy, audit events,
finance, personnel, operational work and other database-owned facts SHALL NOT be mirrored
into a repository as a competing authority.

Changing a subject's Holder requires a typed `change_document_source_holder` action that
records old and new identities, exact content digests, conversion loss, actor, reason and a
reversible migration plan. No dual-write mode is permitted. Git writeback, when later
supported, is an explicit prestate-checked repair; it is never an automatic side effect of a
database edit.

An ordinary source revision does not transfer authority. It appends an exact Holder snapshot
under the same logical authority in the same action as the new Authored Fragment or Composition
Revision: Fabric-native sources remain in the subject organization, Git sources keep repository
and path, and external sources keep authority. Changing those identities is a Holder transfer
and requires the separate migration action above.

### 2. Canonical document vocabulary

The following terms are normative:

- **Authored Fragment** — independently versioned human-maintained source that may be
  composed. This is the successor to a LamQuant documentation atom.
- **Parsed Block** — ordered syntax projection rebuilt from source bytes. Current
  `content.document_atom` rows become Parsed Blocks; they remain uneditable and
  non-authoritative. Every parse records a versioned KF projection contract and a
  stable-path, source-digest-addressed conversion-loss list. `kf.pandoc-atoms.v2` commits
  projection contract, atom claims and that loss list in one content digest; pre-contract
  parses are marked `legacy_parse_loss_unmeasured`, never silently treated as lossless.
- **Composition Revision** — immutable ordered DAG of exact fragment, child-composition,
  resource and binding versions that produces one document revision.
- **Typed Binding** — reference to an authoritative Fabric fact at an exact object revision or
  snapshot, with a declared renderer and expected value type. It supersedes free-form
  truth-ledger substitution.
- **Compilation Basis** — complete immutable input identity: sources, compositions, bindings,
  resources, ontology, policy, target profiles and compiler.
- **Compilation Run** — append-only receipt for one pure compiler invocation.
- **Compiled View** — derived Markdown, HTML, print, ebook, index, traceability, graph, search
  or AI output.
- **Controlled Document Revision** — approval and effectivity unit that freezes one
  Composition Revision and its accepted Compilation Run.
- **Proposal Overlay** — durable derived edit or semantic-operation proposal that has not
  become authored source.

`DocumentAtom` MAY remain as a compatibility type for one release, but new interfaces and
schema SHALL use `ParsedBlock`. Parsed Blocks and Authored Fragments SHALL never share a table
or mutation interface.

### 3. Liminal language and compiler representation

Liminal SHALL be the canonical compiler language and internal document representation. Its
ordinary human authoring profile SHALL be a Markdown-compatible Liminal subset. Explicit
Liminal syntax SHALL represent structures that Markdown cannot express without loss.

Markdown export is lossless only when every selected feature belongs to the declared
Markdown projection profile. A richer document SHALL either emit explicit Liminal or return
a machine-readable conversion-loss report. The system SHALL never silently flatten an
unsupported relation, identity, directive, annotation, transclusion, structured value or
resource.

All inputs lower through the same conceptual pipeline:

```text
source bytes
  -> exact-source CST / imported syntax tree
  -> Liminal Human IR
  -> schema, directive, macro and binding resolution
  -> basis-bound resolved graph IR
  -> validation and analysis
  -> target-specific compiled views
```

DOCX, ODT, PDF, HTML and other formats enter through import adapters with declared projection
capability and conversion loss. Import does not grant those formats canonical round-trip
status. Original bytes always remain preserved as immutable evidence.

### 4. Composition and organized documentation

Composition SHALL be an ordered DAG, not text concatenation hidden in callers. Each edge pins
an exact input version and carries an explicit role such as fragment, child document,
resource, generated view or binding.

The compiler SHALL enforce:

- no cycles or missing inputs;
- no implicit branch, latest-version or mutable-path references in reproducible builds;
- stable declared order;
- resolved internal links and references;
- ontology-controlled topics and document kinds;
- explicit roots and reachability for published documentation spaces;
- classification no lower than the highest visible input;
- no orphaned LamQuant-compatible fragments;
- no ambiguous generated-view ownership;
- no stale accepted output relative to its recorded Basis.

Authored Fragments MAY be reused by multiple compositions when each use is explicit and
version-pinned. The LamQuant compatibility profile SHALL retain its stricter rule that each
atom appears in exactly one parent, because changing that behavior during import could hide a
manifest defect.

Retirement SHALL sequester rather than delete. A retired fragment remains addressable from
its replacement and audit history, contributes nothing to active composition or topics, and
cannot be silently restored by a later build.

### 5. Typed truth bindings

Native source SHALL bind values from typed authoritative Fabric records, not parse a Markdown
table as institutional truth. A binding names object identity, field or projection, expected
type, formatting policy and exact revision/snapshot used by the run.

During draft work, a composition MAY request the current visible value, but every Compilation
Run resolves it to an exact immutable version. A changed fact creates a new stale-input signal
and a new draft run; it never rewrites a prior run. Approval freezes every resolved binding.

LamQuant `{{ledger:ID}}` expressions SHALL remain accepted by the compatibility profile. Each
ledger ID maps to a typed binding alias with recorded provenance. Unknown, ambiguous,
untyped, unauthorized or stale bindings fail closed.

### 6. ADR integration

LamQuant ADRs combine decision rationale, implementation plan, append-only progress, a
runnable gate, resolution and supersession in one file. The Fabric SHALL preserve that
experience while storing its meanings as linked authoritative records:

```text
Decision Record
  -> authored ADR document revision
  -> implementation work or change record
  -> append-only progress events
  -> test definition and execution evidence
  -> completion, rejection or falsification result
  -> typed supersedes / amends / extends relations
```

The imported authored body remains byte-preserved and attributable. Decision lifecycle uses
the Fabric `decision_record` state machine. Completion claims are derived from linked
verification evidence; a textual `gate_cmd` without an execution does not prove completion.
Accepted bodies are immutable. Reconsideration creates a new decision and explicit relation.

Generated ADR overview, work board, digest, topic views and runnable-gate debt SHALL be
Compiled Views, never manually maintained lists.

### 7. Approval and preservation

Approval and effectivity attach to a **Controlled Document Revision**, not independently to
every fragment. Approval freezes:

- Composition Revision and every transitive input version;
- all Typed Binding resolutions;
- compiler protocol, Liminal commit, executable digest, runtime-closure digest and qualification
  receipt;
- ontology and policy digests;
- diagnostics and conversion-loss report;
- semantic graph digest;
- accepted human, machine and publication views.

A later source, binding, ontology, policy or compiler change creates a new draft. An effective
revision remains byte- and meaning-stable until explicitly superseded or withdrawn.

All new authoritative tables and receipts SHALL join the preservation export/import order.
Source and retained-view bytes SHALL remain in versioned object storage with digests in the
export. Export into an empty database, reconnect preserved bytes, re-export and compare SHALL
round-trip without losing composition, bindings, provenance, lifecycle or compiler identity.

### 8. Compiler seam and Liminal pin

KF SHALL depend on a versioned process protocol, not Liminal's unstable Rust crate layout.
The Liminal repository SHALL provide:

```text
liminal-compiler --protocol kf-document-v1
```

It reads one RFC 8785 canonical JSON request from standard input, writes one canonical JSON
result to standard output, and reserves standard error for bounded diagnostics. Request
contains protocol version, Compilation Basis, supplied source/resource bytes or digests,
composition graph, resolved typed bindings, targets, policy and optional prior-run/edit data.
Result contains typed diagnostics, semantic and dependency digests, HIR/CIR provenance,
compiled outputs, unresolved references, omitted subgraphs, projection capabilities and
conversion loss.

Each enabled compiler is pinned by full Liminal commit, `Cargo.lock` digest, executable SHA-256,
ordered native runtime-closure digest, protocol version and qualification receipt. Runtime closure
digest is RFC 8785 digest of ordered `{path, contentDigest}` records after first-occurrence path
deduplication. KF SHALL reject an unlisted or mismatched binary or runtime closure. Production
adapters SHALL execute a native Linux ELF artifact captured in memory from verified bytes;
script/shebang artifacts are test-only because they introduce an unpinned interpreter. The
captured bytes SHALL cross a one-way descriptor pipe into Bubblewrap `--ro-bind-data` and become
read-only `/compiler` inside the new sandbox, never a same-identity writable host path. Runtime
libraries SHALL likewise be opened, byte-hashed and bound from captured read-only file
descriptors before execution. Deployment preflight SHALL prove Bubblewrap, procfs and exact
verified-byte execution. Compiler runtimes SHALL implement `--protocol kf-document-v1
--preflight`, exit zero, and emit exactly
`{"protocol":"kf-document-v1","status":"ready"}\n` only when their pinned runtime closure is
ready. Any other stdout, including empty stdout, fails closed. Deployment and worker startup
SHALL execute that self-check against the descriptor-materialized artifact; `/usr/bin/true`, `/dev/null`, and
equivalent placeholder probes are not compiler qualification or readiness evidence. Compiler
runs without database credentials, network access, ambient source discovery or approval
authority; KF supplies all authorized inputs. Timeout, crash, oversized output, malformed
response or digest mismatch records one failed run and publishes no partial view.

KF SHALL expose this through one deep document-compiler interface with two adapters: pinned
Liminal process for production and deterministic in-memory adapter for tests. Pandoc and
other importers feed source IR; they do not bypass the compiler interface.

Until applicable Liminal qualification closes, Liminal-backed runs are draft-only dogfood.
They cannot produce an approved/effective revision. Promotion requires the pinned commit's
applicable conformance suite and HAQP evidence to be complete and ratified; planned Liminal
features are not evidence.

### 9. Web, website and machine projections

One Fabric document workspace SHALL provide:

- source and structured-fragment navigation;
- composition outline and transclusion provenance;
- source/preview editing with diagnostics;
- revision and semantic diff;
- topic, backlink, ADR and traceability views;
- classification-aware full-text and identifier search;
- HTML website, Markdown, print/PDF, ebook and source downloads;
- machine JSON/JSON-LD graph and typed relation views;
- approval, effectivity, supersession and training context;
- exact source, Basis, compiler and output digests for auditors.

Generated website assets are derived. Publishing records which Compiled View digest and
Controlled Document Revision were deployed. Website edits return through typed source actions
or Proposal Overlays; deployed HTML never becomes source authority.

### 10. AI compiler and semantic-operation loop

This decision includes the full AI planner, not only a reserved interface. The planner SHALL
compile a task-scoped subgraph from caller request, current document/cursor, typed relations,
lexical search, derived vector retrieval, recency, provenance, verification state, security
policy and token budget.

AI MIR and outputs SHALL support normalized Markdown, tagged text, canonical JSON, edge
tables, graph streams and multimodal bundles. Every context records exact Basis, included
subjects, omitted subgraphs, source revisions, provenance, model profile, tokenizer, budget,
provider and policy decision.

Lexical/typed search remains canonical and explainable. Embeddings, summaries and rankings
are disposable projections. Authorization and classification filtering occur before context
selection and again before provider dispatch.

Provider routing is classification-aware:

- local adapters may receive only data allowed by their deployment policy;
- remote adapters require an explicit provider/model allowlist, classification ceiling,
  retention and training-use policy, transport policy and per-run provenance;
- absent or indeterminate policy refuses dispatch;
- no model provider becomes authoritative for a Fabric fact.

Models receive no generic write tool. They may return revision-preconditioned semantic
operations or source patches. KF validates and rehearses them under the target Source Holder,
ontology, lifecycle, classification and action rules, then records them through a typed
`record_document_proposal` action as Proposal Overlays. A human-authorized
`apply_document_proposal` action may convert selected output into a new authored draft while
preserving model and source provenance. AI cannot approve, make effective, allocate an
identifier, or silently mutate Git.

AI evaluation SHALL measure retrieval accuracy, reference resolution, structural and table
understanding, graph-operation success, hallucination rate, provenance retention,
classification leakage and tokens per semantic fact. A model/profile cannot be promoted on
token savings alone.

## Required typed actions

Implementation SHALL add narrow actions rather than generic document mutation:

- `add_authored_fragment`
- `revise_authored_fragment`
- `retire_authored_fragment`
- `add_document_composition`
- `revise_document_composition`
- `change_document_source_holder`
- `request_document_compilation`
- `accept_document_compilation`
- `publish_document_view`
- `record_document_proposal`
- `apply_document_proposal`

Existing controlled-document review, approval, effectivity, supersession and withdrawal
actions remain the only lifecycle path. Compilation workers may materialize derived rows and
artifacts only for a previously authorized compilation request.

## Delivery and replacement gates

Delivery SHALL proceed in this order:

1. **Authority and preservation:** add source Holder, fragment, composition, binding,
   compilation, projection and proposal records; append-only controls; classification
   propagation; complete export/import coverage.
2. **Strict LamQuant compatibility:** ingest an unmodified clean LamQuant checkout with all
   pinned submodules; reproduce atoms, manifests, parents, topics, ledger bindings,
   deprecation, ADRs, generated views, traceability and book ordering.
3. **KF-native authoring:** ship fragment/composition editing, preview, diagnostics, typed
   bindings, diff, provenance and approval handoff in the web UI and machine interface.
4. **Liminal incremental editing:** activate exact-source CST/HIR/CIR, stable identities,
   source maps, incremental preview, semantic diff, managed projections and visible overlays
   after their qualification gates close.
5. **AI compiler:** ship scoped retrieval, AI MIR, model profiles, multimodal projections,
   semantic proposals, provider routing and evaluation.
6. **Cutover:** shadow LamQuant and KF compilers after strict parity passes. Zero unexplained
   semantic drift is required. **The "30 consecutive days" this step originally specified is
   superseded by decision 0004**, which replaces the duration with a count — every constitution
   document compiled twice with byte-identical output, every document-lifecycle action path
   exercised, and a seven-day floor. The reasoning is in 0004: drift is evidence produced per
   compilation, and a quiet month records "no drift observed" and "nothing was observed"
   identically. The zero-drift requirement itself is unchanged. Then freeze LamQuant compiler tools
   read-only and preserve their final source, fixtures and expected outputs as migration
   evidence.

Replacement is complete only when all following gates pass:

- generated parent bodies match LamQuant after declared banner and line-ending normalization;
- parent membership/order, topic membership, links, ADR views, traceability and book ordering
  match exactly;
- planted orphan, duplicate-owner, cycle, unknown-topic, dangling-binding, stale-parent,
  illegal-lifecycle and frozen-record mutations fail;
- same Basis and compiler produce byte-identical semantic and view digests;
- source or binding changes cannot alter an approved/effective revision;
- classification propagates to every output and refuses an unsafe publication/provider;
- import/export round-trip retains every authoritative fact and preserved byte identity;
- compiler crash, stale binding, rewritten Git history, missing source, unsupported syntax and
  lossy export fail visibly without partial publication;
- AI contexts remain inside caller/provider scope and all AI changes remain derived until a
  human-authorized action;
- rollback can reactivate LamQuant generation during shadow period without losing Fabric
  records created meanwhile.

## Consequences

The Fabric becomes a composed monolith at the product boundary while keeping compiler,
authority, source adapters, projections, UI and model providers independently auditable and
replaceable.

This adds a substantial schema, compiler protocol, compatibility harness and UI surface. It
also makes the intended replacement claim testable: LamQuant behavior is a corpus gate, not a
feature checklist, and unqualified Liminal plans cannot be mistaken for shipped capability.

PostgreSQL remains the only institutional write authority. Liminal graph IR, parsed blocks,
search indexes, embeddings, summaries and compiled views remain derived and rebuildable.
Retained approved outputs are immutable evidence of what was reviewed, not an alternate edit
surface.

## Considered alternatives

### Make every Fabric record Git-backed

Rejected. Repository history cannot enforce Fabric row security or safely hold personnel,
finance and operational records. It would also create a second approval and audit mechanism.

### Make KF-native source the only Holder

Rejected. It would break LamQuant compatibility, ordinary engineering workflows, external
tool sovereignty and portable source reuse.

### Keep LamQuant compiler permanently beside KF

Rejected. Two production compilers become two definitions of current documentation. LamQuant
survives as locked migration evidence after measured shadow cutover.

### Depend directly on Liminal Rust crates now

Rejected. Current interfaces and qualification are not stable enough for an institutional
authority. Versioned process interchange contains that risk and preserves independent
release cadence.

### Copy Liminal concepts into a separate KF compiler

Rejected. It would create two implementations of identity, Basis, IR and projection laws,
then force both projects to rediscover the same failures independently.

### Approve every fragment independently

Rejected as the default. Review meaning attaches to the exact composed revision people read.
Fragments retain attribution and immutable input history, while stricter document classes may
add fragment review as a policy without changing the approval unit.
