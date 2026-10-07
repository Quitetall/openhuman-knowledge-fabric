---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a2-73d3-9dc7-10e81c41b4a3
role: basis
jurisdiction: authored
order: 20
classification: internal
---

# Basis

## The contract

- **ADR 0040** (to be written by KF-WAR-0003) and decisions 2, 3, 9 and 11 of `docs/ROADMAP.md`.
  Their requirements (restricted content never reaches a provider model; every answer cites and
  states what was withheld; notifications carry no record content over a channel the deployment
  does not control) **do not exist in §106 yet**; KF-WAR-0003 adds them to this manifest when it
  lands.
- **ADR 0028** and KF-SAS-RQ-218: controlled content never leaves the host to be embedded. The
  router extends that stance from embeddings to answers, by classification.
- **ADR 0037**: what a query withheld is one count within the asker's ceiling (KF-SAS-RQ-222).
- **ADR 0035**: the chat agent acts for the signed-in person; its drafts carry agent
  participation.
- **ADR 0031** and **ADR 0034**: a filled form is a draft, attributed from the first moment
  (KF-SAS-RQ-202); committing it is the person's act.
- SAS §64A to §64C (retrieval, the demand aggregate, the context source). The context source serves
  only a direct loopback caller (KF-SAS-RQ-253), so the chat backend calls it from the host.
- `docs/deployment/phone-alerts.md`: the owner chose free hosted ntfy and accepted that anyone who
  learns the topic can read or forge a notification. **So a push says that something needs you and
  links to it; it never carries a title, a name or any record content.** The email digest follows
  the same classification threshold as provider models: above it, an item is a count and a link.

## Existing code this reuses

| Need | Where it already is |
|---|---|
| Context reads, recorded as disclosures | `apps/api/src/routes/context-source.ts`, `apps/api/src/routes/context-source/record.ts`; `tests/database/context-source.test.ts` |
| Fused ranking | `packages/search/src/compose.ts`; `packages/retrieval/src/client.ts`, `packages/retrieval/src/engine.ts` |
| Search UI | `apps/web/src/app/search` |
| The embedding pump | `apps/worker/src/embedding.ts` (one request at a time, §100.44) |
| Fixture baselines for fusion | `fixtures/veracier/reports/search-baseline.md` and the three other corpora's |
| The alert path | `deploy/systemd/kf-alert@.service`, `scripts/alert-dispatch.sh`, `deploy/systemd/alert-ntfy-healthchecks.conf`, `docs/deployment/phone-alerts.md` |
| Capture and drafts | `apps/api/src/routes/capture.ts`; the act contracts in `apps/api/src/routes/actions/contracts.ts` |
| The LAMU engine | pinned at `26923afb` by KF-WAR-0002 |

## The unknown

Which local model LAMU serves for answers on a 4 vCPU, 8 GB host (ADR 0039) at a speed a person
will wait for. Semantic retrieval on that CPU is settled; generation is not. If no local model is
usable there, confidential and restricted questions get retrieval results with citations and no
generated answer, and the answer says so. That is the fallback, not a provider.
