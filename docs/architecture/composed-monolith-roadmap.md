# Composed-monolith completion roadmap

**Status:** executable implementation map; decision acceptance remains with named authorities

KF is one product, registry and authority surface. Its components remain independently
auditable and replaceable. PostgreSQL owns institutional facts; object storage owns immutable
bytes; compiler, search, website, AI, BLUT and secure-vault services operate through narrow
contracts.

## Delivery order

1. Close explicit runtime profiles, real dogfood identity and split readiness.
2. Implement authority-preserving document records from proposed ADR 0002.
3. Load constitution drafts under truthful Holder identity: current non-Git corpus is
   `fabric_native`, while Git sources remain Git-held at exact commits.
4. Pass strict LamQuant compatibility corpus.
5. Add pinned Liminal compiler adapter; keep its outputs draft-only until qualification.
6. Ship source/preview workbench, diagnostics, semantic diff and proposal-only Git workflow.
7. Add signed approved-public bundles and read-only public projection API.
8. Add provider-neutral AI proposal boundary with LAMU as first local adapter.
9. Qualify Secure Object Authority and full BLUT/KF lineage and metric flow.
10. Run the zero-drift LamQuant shadow to the criterion in decision 0004, prove rollback,
    then request human cutover. **The thirty days in earlier revisions of this line is
    superseded**: drift is observed per compilation, not per day, so the gate is now a
    count of compilations and exercised action paths with a seven-day floor. See
    `docs/decisions/0004-production-release.md`.

## Human-only actions

Agents and services cannot accept ADRs, allocate identifiers, sign R01, resolve schema-pack
defects, approve/effect documents, transfer Source Holders, approve restricted-data use,
release regulated/clinical models, change key custody or provider allowlists, authorize PHI
admission, or accept final cutover.
