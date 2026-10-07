---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-339e-7463-afe2-e09d9261e893
role: intent
jurisdiction: authored
order: 10
classification: internal
---

# Intent

Make an agent a colleague under the same rules as a person: it reads the slice of the record its
person may read, it writes back into the same record through the same acts, and what it writes is
**submitted, not trusted**, until someone with authority verifies it.

This is milestone **M2, Agents as colleagues**. Three deliverables:

1. **The KF MCP server**, so Claude Code, LAMU and Codex read and write KF from where the owner
   already works (his Q2 answer: the agent via MCP, the web app as home).
2. **The verification policy**: per record kind and per agent, default "verification required",
   and institutional acts never verified automatically.
3. **Needs you**: an API and a web panel listing what waits on this person, with one-click
   verify and approve.

## The rule it implements

From the owner's Q4 and Q5 answers: agents capture freely, attributed to them acting for their
person; anything institutional they propose waits in that person's queue for an explicit click.
Captures may later be set to commit verified once the person trusts an agent for a kind of record;
an institutional act never may.

## What is deliberately not in scope

- The in-app chat agent (M4, KF-WAR-0006). It will use this Warrant's acts and queue, not its MCP
  transport.
- Dashboard layout beyond the Needs-you panel (M3, KF-WAR-0005).
- Qualification evidence in the queue (M5, KF-WAR-0007 adds that kind).
