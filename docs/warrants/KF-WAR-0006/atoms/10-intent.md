---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a2-73d3-9dc7-10e81c41b4a3
role: intent
jurisdiction: authored
order: 10
classification: internal
---

# Intent

Put the agent inside the web app: a chat window that answers from the record the reader may see,
cites every source, says what it could not show, fills real forms as drafts for one-click commit,
and never sends restricted content to a provider's model. And tell people when something needs
them, without nagging and without leaking.

This is milestone **M4, The agent at home**. The owner's answers it builds: Q3 ("a chat window so
you can get RAG + fill out the forms automatically to add to the record"), Q2 ("LAMU perhaps can
provide local AI assistance … or regular provider agent tokens"), Q13 (by classification: public
and internal may reach a provider; confidential and restricted are answered by LAMU only, and the
answer says which backend answered), Q10 and Q11 (a daily email digest, plus an immediate ntfy push
only for urgent items, sharing the alert path).

## Deliverables, in one line each

1. In-app chat over the context source: fused and semantic retrieval, citations, withheld counts.
2. Form-filling: the agent fills the real form as a draft; one click commits.
3. The backend router: LAMU or a provider, chosen by the highest classification in the context,
   configured per organization, named in every answer.
4. Notifications: email digest and ntfy urgent push.
5. The two retrieval gaps that make chat slow or worse than it should be: the embedding pump
   (SAS §100.44) and the fusion weights (§100.45).

## What is deliberately not in scope

- The MCP transport (M2). Chat uses M2's acts, verification policy and Needs-you queue.
- Onboarding guidance (M5). KF-WAR-0007 points this chat at a person's Start Here; it does not
  change how chat works.
