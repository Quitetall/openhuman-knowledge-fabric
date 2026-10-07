# The KF MCP server

`apps/mcp` (`kf-mcp`) lets an agent — Claude Code, LAMU, Codex — read and write the Fabric for one
named person, over that person's delegated token ([ADR 0035](../decisions/0035-an-agent-acts-for-a-named-human.md)),
under the rule [ADR 0040](../decisions/0040-the-experience-scope-is-the-product.md) records:
**agents submit; authority verifies** (SAS §24B, KF-SAS-RQ-263 to RQ-266).

It holds no authority of its own (KF-SAS-RQ-150). Every tool call is one call to the Fabric API
with the person's token; the API identifies the caller through `kf-attestor` as it identifies the
web application's, and the database binds the person and seals the agent's participation from the
attestation. The server never holds a database login, never stores a token, and logs tool names,
outcomes and refusal codes only.

## Tools

| Tool               | What it does                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `search`           | Fused, lexical and semantic rankings over what the person may read, and `withheldCount`          |
| `read_record`      | One record's Object View, labelled verified or UNVERIFIED (compiles a stale master record first) |
| `master_record`    | The person's master record (their scope, compiled)                                               |
| `context_retrieve` | The context source's retrieval: SourceRefs, no text                                              |
| `context_read`     | One SourceRef's text, re-checked against current authority                                       |
| `list_actions`     | The closed list of acts this agent may write, their fields, and how each lands                   |
| `draft_act`        | The form a person would fill for one act, filled; writes nothing (RQ-266)                        |
| `submit_act`       | Writes one act from the closed list (below)                                                      |
| `list_needs_you`   | What waits on the person: records to verify, their agents' submissions, proposals                |

### What an agent can write

Only the acts in `AGENT_ACTS` (`packages/domain/src/agent-acts.ts`); the act name is a schema enum,
so anything else is refused before a request is sent (KF-SAS-RQ-020).

- **Submitted** — `record_observation`, `propose_decision`, `create_initiative`,
  `withdraw_observation`: performed for the person, recorded as **their act with the agent's
  participation**, and **UNVERIFIED** until a person with authority verifies it from Needs you —
  or a verification policy in force for that record kind, act and agent verifies it on arrival, in
  which case the answer names the policy.
- **Proposed** — `promote_observation`, `accept_decision`, `reject_decision` (institutional, ADR
  0016 `requires: act`): recorded as a proposal and **not performed**. It waits in the person's
  Needs you; only they perform it, on their own token, with every check run at that moment.

The agent cannot verify, confirm a proposal, set a verification policy, or perform an
institutional act. The API refuses an agent's token each of these by name (`agent_cannot_answer`),
and the database refuses them again (`KF-AGENT-001`, `KF-AGENT-002`), so none is reachable around
this server either.

## Setup

### 1. Declare the agent (owner)

Each agent is its own OAuth client in the realm, with standard token exchange on and a mapper that
stamps `act.client_id` with its own id (`docs/deployment/identity-and-login.md`, "Using it —
derived"). On the Véracier fixture, `node fixtures/veracier/stack/agent-client.mjs <client-id>`
registers one and writes its secret owner-only under the stack's state directory. Then declare it
to the Fabric, over the owner credential:

```sh
pnpm kf:declare-agent --client <client-id> --declared-by <your person uuid> \
  --reason 'Claude Code on my workstation drafts and captures for me'
```

### 2. Give the server a token source — never an inline token

The delegated token lives at most the realm's access-token lifespan (≤ 300 s, KF-SAS-RQ-241), so the
server asks for it on every call. Configure exactly one of:

- `KF_MCP_TOKEN_FILE` — a file holding the token, mode `0600`, owned by you; re-read on every call,
  so a helper only has to rewrite it. A file anyone else can read is refused.
- `KF_MCP_TOKEN_COMMAND` — a command that prints a fresh token on stdout, run when the last one is
  within 30 s of expiry (like a git credential helper). Keep the agent client's secret where the
  command can read it and nothing else can — for example `secrets run -- …`.

A token-exchange helper is the step-3 `curl` of `docs/deployment/identity-and-login.md` with the
person's own access token as `subject_token`. There is deliberately no variable that takes a
token's value: `KF_MCP_TOKEN` and `KF_TOKEN` make the server refuse to start.

The other variables: `KF_API_URL` (loopback http, or https; default `http://127.0.0.1:4000`),
`KF_ORGANIZATION` (uuid, required), `KF_ACTING_ROLE` (the assignment uuid you act under),
`KF_CLASSIFICATION` (the ceiling asked for; the database clamps it to your clearance).

### 3. Register it with the client

Build once: `pnpm --filter @kf/mcp... build`.

**Claude Code** (`.mcp.json` in a project, or `claude mcp add-json`):

```json
{
  "mcpServers": {
    "knowledge-fabric": {
      "command": "node",
      "args": ["/opt/kf/current/apps/mcp/dist/main.js"],
      "env": {
        "KF_API_URL": "http://127.0.0.1:4000",
        "KF_ORGANIZATION": "<organization uuid>",
        "KF_ACTING_ROLE": "<assignment uuid>",
        "KF_CLASSIFICATION": "confidential",
        "KF_MCP_TOKEN_FILE": "/home/<you>/.local/state/kf/agent-token"
      }
    }
  }
}
```

**LAMU** (its MCP client configuration; same process, same environment):

```toml
[mcp.servers.knowledge-fabric]
command = "node"
args = ["/opt/kf/current/apps/mcp/dist/main.js"]
env = { KF_API_URL = "http://127.0.0.1:4000", KF_ORGANIZATION = "<organization uuid>", KF_ACTING_ROLE = "<assignment uuid>", KF_MCP_TOKEN_COMMAND = "secrets run -- kf-agent-token lamu" }
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.knowledge-fabric]
command = "node"
args = ["/opt/kf/current/apps/mcp/dist/main.js"]
env = { KF_ORGANIZATION = "<organization uuid>", KF_ACTING_ROLE = "<assignment uuid>", KF_MCP_TOKEN_FILE = "/home/<you>/.local/state/kf/codex-token" }
```

Each agent should be a different declared client, so the ledger says which one acted.

### Streamable HTTP

`kf-mcp --http` serves the same tools on `http://127.0.0.1:$KF_MCP_HTTP_PORT/mcp` (default 4310),
loopback only, with `Host` and `Origin` checked. It holds one person's token source, like the
stdio form, and is there for a later client that cannot spawn a process.

## Trusting an agent for a kind of record

By default every agent submission waits for a person. An organization can decide that one declared
agent's records of one kind, written by one act, are verified on arrival — an institutional act,
so a person with act authority makes it, never an agent:

```sh
curl -s -X POST "$KF_API_URL/actions/set_verification_policy" -H "authorization: Bearer $OWN_TOKEN" \
  -H "x-kf-organization: $ORG" -H "x-kf-acting-role: $ROLE" -H 'content-type: application/json' \
  -d '{"targetIds":["'$ORG'"],"idempotencyKey":"policy-bench-agent-1",
       "reason":"the bench agent’s readings have matched the log for a month",
       "payload":{"object_type":"observation","action_type":"record_observation",
                  "agent_client_id":"bench-agent","mode":"verified_on_submit"}}'
```

`mode: required` reverts it; every setting is kept (`GET /verification-policies` shows those in
force). A record verified this way says `verified_by_policy` and names the policy; the database
refuses a policy that names an institutional act (`KF-VPOL-001`).

## Proven by

`tests/permissions/mcp-server.test.ts` (the MCP client through the real API, attestor and
database), `tests/database/agents-as-colleagues.test.ts` (each database guard, and each falsified),
`apps/mcp/src/config.test.ts`, `packages/domain/src/agent-acts.test.ts`.
