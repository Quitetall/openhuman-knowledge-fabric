# ADR 0032: LAMU runtime and KF source contract

Status: proposed, 2026-09-15. Owner-directed documentation amendment, not accepted
deployment or implementation evidence.

## Decision

LAMU is an application-facing AI runtime. It compiles context and coordinates
model, memory, retrieval and compute services. KF owns institutional records,
permissions, disclosure and writes. Katana owns application action loops.

KF can supply authorized source material to LAMU and call LAMU for AI operations.
These are separate interfaces. Source authorization must not call LAMU recursively
to authorize the same read. No generated response approves an authoritative write.

Share versioned source identity, revision, provenance, context and refusal
contracts with conformance fixtures. Do not merge repositories or mutable tables,
copy KF policy into LAMU, or extract a shared executable kernel before evidence
shows that both callers need identical behavior. PostgreSQL remains KF authority.

Controlled retrieval is a derived operation. An eligible implementation filters
while scoring, binds positional masks to index generations and lets KF resolve
and reauthorize hits. Controlled embedding stays local. Persist neither source
text nor authorization inputs in the derived index. Apply retention restrictions
to caches, logs, compiled packages and generated summaries as well.

## Proof and limits

Prove local-memory operation without KF, then KF source access, then a Katana
consumer. Exercise concurrent scopes, revision change, deletion, revocation,
partial disclosure outage, lost-response retries and prohibited remote fallback.
Missing authority fails closed; record the dispatch/disclosure decision point.

This branch starts from origin/main at d2be4d2d. It does not include the owner's
13 unpublished commits or claim their retrieval implementation is present.
SAS draft.5 is a separate candidate after published draft.3, not a supersession
of unpublished draft.4. Reconcile both candidates before acceptance. No new
requirement IDs are allocated; section 104A refines existing authority/refusal
requirements. The tool's index-only diff cannot assess this semantic change.

## Alternatives

An immediate shared database would couple release and migration authority before
interfaces are proved. A thin provider proxy would leave context and failure
coordination to every application. Contract-first integration preserves each
program's authority while testing whether LAMU removes that repeated work.
