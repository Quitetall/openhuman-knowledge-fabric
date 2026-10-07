---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a7-7583-b041-90230e3158dc
role: work_order
jurisdiction: authored
order: 40
classification: internal
---

# Work order

## Deliverables

1. **Parity and cutover (criterion 4).** On the commissioned host, compile each constitution
   document in `dogfood/document-constitution.json` twice and record byte-identity; exercise each
   of `request_document_compilation`, `accept_document_compilation`, `record_document_proposal`,
   `apply_document_proposal` and `publish_document_view` once; record zero unexplained drift, or
   stop.
2. **A current, signed schema pack (criterion 2, §100.6, §100.13).** `pnpm ontology:pack` at the
   next version, with every addition since the last signed pack declared (qualification included,
   from KF-WAR-0007); the release pack's gap list no longer claims its own manifest unsigned.
3. **§100 triage.** Every entry in the basis atom's table closed by work with a test, or proposed as
   an accepted limit with its reason, in one SAS revision. The pieces that are work: §100.3's
   `damm.ts` coupling, §100.27's remaining untagged digests, §100.32's reverted-column archive test,
   §100.35's scheduled determinism re-run, §100.36's host measurement.
4. **Independent verification (§100.14).** Arrange a verifier outside the author and the agent for
   at least the Phase 9 and Phase 10 Warrants, or record the owner's decision to tag without one.
5. **The tag (criteria 1 and 5).** A release commit on `main` whose CI run is green, every job
   executed; the tag cut on that commit; the release workflow green on the tag.
6. **The record.** ADR 0004's "What was measured" gains the v1.0 lines, each measured; KF-WAR-0001,
   KF-WAR-0008 and this Warrant resolved.

## Owner-only

- Accept cutover (an institutional act; `CONTRIBUTING.md`, "What is not yours to do").
- Approve and sign the schema pack (`pnpm ontology:approve`).
- Accept the SAS revision carrying the §100 dispositions, including each accepted limit, and
  confirm §100.28's reading.
- Arrange the independent verifier, or decide to tag without one.
- Cut the tag, and resolve this Warrant.

## Depends on

KF-WAR-0008 (M7), and through it KF-WAR-0001 (M6) and every earlier milestone.
