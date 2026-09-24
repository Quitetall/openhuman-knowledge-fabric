# @kf/documents

Parses verified document bytes into ordered, independently digested atoms and supplies draft
controlled-document action atoms plus read projections.

Authority: owns no source fact. Object storage owns source bytes; PostgreSQL owns artifact,
document, lifecycle and provenance facts. Parsed atoms are disposable projections.

## Model proposal context claims

A model proposal's `model_provenance.context` is digested under `kf-ai-proposal-context-v2`: the
tag sits inside the RFC 8785 preimage as a `format` property (KF-SAS-RQ-016), and the claim names
the `agent_context` Result the planner drew the context from — definition id and version, corpus
digest and projection digest (KF-SAS-RQ-115). `@kf/agent-tools` refuses to build a
`record_document_proposal` payload whose projection is not the one its plan recorded, and
`record_document_proposal` refuses any claim that is not v2 (`KF-DOC-PROPOSAL-017`).
`kf-ai-proposal-context-v1` names the earlier, untagged preimage — the same fields with no `format`
and no `projection` — which proposals recorded before v2 carry in `content.proposal_overlay`. A
stored claim is re-verified under its own format whenever the proposal is read, so v1 still
verifies; it is never recorded again.
