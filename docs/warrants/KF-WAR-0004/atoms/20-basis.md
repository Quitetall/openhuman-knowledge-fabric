---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-339e-7463-afe2-e09d9261e893
role: basis
jurisdiction: authored
order: 20
classification: internal
---

# Basis

## The contract

- **ADR 0040** (to be written by KF-WAR-0003) and the owner's decisions 4 and 5 in
  `docs/ROADMAP.md`. The requirements they become (an agent's submission is unverified until
  verified by authority; the policy is configurable and never auto-verifies an institutional act;
  an agent-proposed institutional act waits for its person) **do not exist in §106 yet**, and
  `war check` refuses a Warrant that implements a requirement §106 lacks. KF-WAR-0003 adds them to
  this manifest's `[[implements]]` when it lands; until then the manifest names only existing
  requirements the work must extend or keep.
- **ADR 0035** (`docs/decisions/0035-an-agent-acts-for-a-named-human.md`): token exchange, the
  attestor's check of the `act` claim, declared agents, and `core.action.agent_participation`
  written by the database. The MCP server is a client of this, not a second mechanism.
- **ADR 0031** (a draft is a record that says so) and **ADR 0034** (an observation is captured,
  then promoted).
- **ADR 0020** (service actors) and KF-SAS-RQ-046: a service actor is refused every institutional
  act. An agent acting for a person is not a service actor, and still never performs an
  institutional act unattended under this Warrant.
- SAS §100.26: verification is recorded and paced, not proven. The Needs-you one-click path must
  record `reviewed_individually` only for a record the person opened, and use the bulk path
  (`promoted_in_bulk`) otherwise.

## Existing code this reuses

| Need | Where it already is |
|---|---|
| Typed agent reads and one rehearsal | `packages/agent-tools/src/index.ts` (`AGENT_TOOLS`: eight reads and `rehearse_action`, no writes) |
| Delegated identity | `apps/attestor/src/server.ts`; `database/migrations/20260925100000_an_agent_acts_for_a_named_human.sql`; `apps/api/src/declare-agent.ts` |
| The write path | `apps/api/src/routes/actions/write-route.ts` and `apps/api/src/routes/actions/contracts.ts` |
| Capture | `apps/api/src/routes/capture.ts` (`POST /capture/observation`) |
| Context reads | `apps/api/src/routes/context-source.ts` |
| Search | `apps/api/src/routes/search.ts` |
| Verification | `database/migrations/20260918000100_object_verification.sql` (`core.object_verification`); `apps/api/src/routes/verifications.ts` (`POST /verifications/bulk`); `packages/documents/src/internal/verification-actions.ts` |
| Web app | `apps/web/src/app/` (Next.js), `apps/web/src/lib/api.ts` |

No MCP SDK is a dependency of this repository today; adding one is a new dependency, reviewed as
such (licence, size, maintenance) in the commit that adds it.

## The unknown

Whether an MCP client can hold a delegated token through a session without the person re-consenting
on every call. ADR 0035's token exchange assumes a token lifetime bounded by the attestation replay
bound (KF-SAS-RQ-241). If MCP clients cannot refresh, the server needs a refresh path that is
itself an attested exchange, never a long-lived credential.
