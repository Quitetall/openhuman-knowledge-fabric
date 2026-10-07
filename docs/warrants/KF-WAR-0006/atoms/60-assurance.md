---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a2-73d3-9dc7-10e81c41b4a3
role: assurance
jurisdiction: authored
order: 60
classification: internal
---

# Assurance

No registered gate covers this work; `kf.chat.routing` is proposed below as a candidate.

## Acceptance obligations

### OBL-001 — restricted content never reaches a provider
- **scope:** KF-SAS-RQ-218 (extended); the M1 requirement on provider models.
- **checks:** a router test with a provider adapter that records every byte it is sent.
- **evidence:** for every Véracier persona and every classification, a question whose context
  includes one record above the threshold sends nothing to the recording provider and is answered
  by LAMU, and the answer names LAMU.
- **falsification:** lower the threshold check by one rank; the test must fail naming the record
  that reached the provider.

### OBL-002 — every answer cites, and says what it withheld
- **scope:** KF-SAS-RQ-115, RQ-120, RQ-216, RQ-222, RQ-250.
- **evidence:** each claim in an answer carries a citation to a record and revision the reader may
  read; the withheld count equals the one the search route reports for the same query and reader;
  each context read appears as a recorded disclosure.
- **falsification:** plant an answer citing a record outside the reader's grants; the server must
  refuse to return it (the compiler's existing refusal, §64A), not filter it silently.

### OBL-003 — the agent drafts; the person commits
- **scope:** KF-SAS-RQ-202, RQ-204; KF-WAR-0004's agent-submission requirement.
- **evidence:** a chat-filled form exists as a draft with agent participation until the person's
  click; an institutional act from chat lands in Needs you and is not performed.

### OBL-004 — notifications reach a person and carry nothing
- **scope:** KF-SAS-RQ-164 (partial); the M1 requirement on notification content.
- **evidence:** a digest and a push delivered to the owner, confirmed by him; a test that fails if
  a push body or a digest item above the threshold contains a title, an identifier or any field of
  a record.

### OBL-005 — retrieval is bounded and fused honestly
- **scope:** KF-SAS-RQ-201, RQ-224; SAS §100.44, §100.45.
- **checks:** `scripts/latency-bars.mjs`; the four fixture search baselines.
- **evidence:** ingest-to-findable on Véracier before and after; the fused list no longer below
  the semantic list on Véracier and TheAgentCompany, on all four baselines re-run with the method
  named.
- **candidate gate (not registered):** `kf.chat.routing`, running OBL-001 and OBL-002 with their
  plants.

## Gate Adequacy

Required at `controlled` (§39.4).

**Adversarial question: could restricted content leave the host through chat without any check
failing?** Through four doors, each closed or named: the provider adapter (OBL-001 routes by the
highest classification in the context, before anything is sent); a follow-up turn whose context
carries an earlier restricted answer (the router must count conversation history as context; OBL-001
covers it with a two-turn plant); the notification channels (OBL-004); and a person pasting content
into a provider-routed turn themselves, which no check can see and which is recorded as a limit.

**Could the checks be blind?** OBL-001's provider is a recorder, so the test observes what was
sent, not what the router claims it sent.

**Executed attacks:** none yet.

- **outcome:** gap_accepted

A person can still paste anything they can read into a provider-routed question. The router
classifies what KF put in the context, not what the person typed.

## Residual risk

**RR-001 — what a person types is not classified.** Accepted, as above.

**RR-002 — hosted ntfy is public to whoever learns the topic.** Accepted by the owner in
`docs/deployment/phone-alerts.md`; OBL-004 keeps record content out of it.

## Independence

None (`openwarrant.toml`).
