---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-339e-7463-afe2-e09d9261e893
role: work_order
jurisdiction: authored
order: 40
classification: internal
---

# Work order

## Deliverables

1. **The KF MCP server**, a new app (apps/mcp, beside `apps/api`), a thin adapter that holds no
   authority (KF-SAS-RQ-150): every call becomes one call to the API under the person's delegated
   token. Tools:
   - **read:** `search` (lexical, semantic and fused, as served), `read_record`, `read_history`,
     `master_record` (the caller's), `context` (the context source), `trace_relations`,
     `verification_of`, `evidence_for`: built on `AGENT_TOOLS`, not re-implemented;
   - **write:** `capture_observation`, `draft_record` and `submit` for every non-institutional
     create act the ontology declares; `propose_act` for an institutional act, which queues it and
     performs nothing;
   - **queue:** `needs_you` (what waits on the person the agent acts for);
   - `rehearse_action`, unchanged.
   Every result carries each member's verification label, as every other read does (§100.26).
2. **Delegated identity, end to end.** The server obtains the person's token by the ADR 0035 token
   exchange, through the attestor; it never sees a password and never stores a refresh credential
   in plaintext. A call with no live delegation refuses, by name.
3. **The verification policy**, as data, not code: an ontology-declared policy object (or a
   table under the existing verification schema, if that is the smaller change) holding, per
   organization, per record kind and per declared agent, one of `required` (the default) or
   `verified_on_submit`. The database refuses `verified_on_submit` for any action
   `ontology/action-types.yaml` declares institutional. Changing the policy is itself an attributed
   act.
4. **Proposed acts.** An agent's `propose_act` writes a pending proposal naming the act, its
   payload digest and the agent; the person performs it with one explicit act that re-runs every
   check at that moment. A proposal never becomes an act by expiry, bulk acceptance or policy.
5. **Needs you**: one API route (GET, scoped to the caller) returning unverified submissions by
   agents acting for them, proposals awaiting them, drafts to promote, and anything else the
   ontology declares as awaiting this person; and a web panel in `apps/web/src/app/` with one-click
   verify (individual review) and select-many verify (the bulk route), each item linking to its
   record. The panel is phone-usable (decision 10).
6. **Docs**: a deployment note for registering the MCP server with Claude Code, LAMU and Codex, and
   the SAS §100 entry for this part closed or narrowed in the next SAS proposal.

## Constraints

- The MCP server, the API and the web panel decide nothing. Visibility, the policy and the
  institutional bar live in the database (KF-SAS-RQ-002, RQ-044).
- One gesture, many acts: a bulk verify dispatches one act per item (KF-SAS-RQ-227).
- No record content in logs; the MCP server logs tool names, outcomes and refusal codes only.

## Owner-only

- Declare each agent that may act for him (the owner credential; ADR 0035).
- Set any per-agent `verified_on_submit` policy; the default is `required` and stays so unless he
  changes it.
- Authorize and resolve this Warrant.

## Depends on

KF-WAR-0003 (M1), for the requirements this Warrant implements and the open choices it decides.
Can start design work against ADR 0035 before M1 lands; cannot resolve before it.
