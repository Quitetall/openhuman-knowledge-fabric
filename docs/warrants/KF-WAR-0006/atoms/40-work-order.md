---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a2-73d3-9dc7-10e81c41b4a3
role: work_order
jurisdiction: authored
order: 40
classification: internal
---

# Work order

## Deliverables

1. **Chat over the context source.** A chat panel in the web app (on the dashboard and as its own
   page). Each turn: the server retrieves through the context source and the fused ranking under
   the reader's grants, composes an answer from those records only, and returns it with a citation
   per claim (record and revision) and the withheld count within the reader's ceiling. Every
   context read is recorded as a disclosure (KF-SAS-RQ-250). An answer that could not use semantic
   ranking says so (KF-SAS-RQ-216).
2. **Form-filling drafts.** When asked to record something, the agent selects a declared create
   act, fills its real form, and shows it as a draft; one click commits it as the person's act with
   the agent's participation. Institutional acts are proposed into Needs you (KF-WAR-0004), never
   committed from chat.
3. **The backend router.** Per organization, a configured classification threshold (default:
   public and internal may go to a provider model; confidential and restricted only to LAMU on the
   host). The router computes the highest classification of everything in a turn's context and
   chooses accordingly, before any content leaves the process. The answer names the backend. A
   provider key is read from a credential file, never the environment, like every other secret.
4. **The email digest.** Daily, per person, of their Needs-you queue, honouring the same threshold:
   items above it appear as a count and a link. Send time and recipients are ADR 0040's open
   choice.
5. **The urgent push.** ntfy, through the existing alert path, for the urgent kinds ADR 0040 names
   (default: a person blocked on the organization, an approval someone is waiting on, a failed
   backup or alert). The message carries no record content: a generic line and a link.
6. **SAS §100.44**: the embedding pump sends batches, bounded, so a large ingest becomes findable
   by meaning in bounded time; measured on the Véracier corpus before and after.
7. **SAS §100.45**: fusion weights (or a floor on weak word matches) so the fused list stops
   falling below the semantic list alone on Véracier and TheAgentCompany; the method named and
   stated (KF-SAS-RQ-224), the four baselines re-run, nothing tuned to one corpus.

## Owner-only

- Choose and supply the provider account and key (into the secrets store), or choose none.
- Set the organization's classification threshold if not the default.
- Decide the digest time, recipients and urgent kinds (ADR 0040's open choices).
- Authorize and resolve this Warrant.

## Depends on

KF-WAR-0004 (M2: acts, verification policy, Needs you) and KF-WAR-0005 (M3: the dashboard the chat
sits on, and scope as presets).
