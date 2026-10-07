# The in-app agent, and how a person is told

Milestone M4 ([KF-WAR-0006](../warrants/KF-WAR-0006/manifest.toml)), building
[ADR 0040](../decisions/0040-the-experience-scope-is-the-product.md) decisions 7, 8 and 9 and SAS
§24B: KF-SAS-RQ-266, RQ-271, RQ-272, RQ-273 and RQ-274.

## What a person sees

`/agent` in the web application, and `AgentDock` (`apps/web/src/app/agent/agent-dock.tsx`), the same
chat as one panel the dashboard can mount. One column that works at phone width.

- **Ask.** The answer cites every record it drew on — each a link to the record — names the backend
  that produced it ("LAMU on this host" or the provider's model), and says how many matching
  records the reader's grants do not reach. That count is `withheldCount` from `GET /search` for the
  same query and reader (ADR 0037). When semantic ranking was unavailable the answer says so
  (KF-SAS-RQ-216).
- **"Record that …".** The agent picks one act from M2's closed list (`AGENT_ACTS`) and shows its
  real form: the same fields, labels and limits a person filling it sees, because `draftAgentAct`
  builds both. Nothing is written. One click commits it as the person's act with the in-app agent's
  participation, unverified until someone with authority verifies it. An institutional act is
  proposed into the person's Needs you and is not performed (KF-SAS-RQ-265, RQ-266).

## How it works

`@kf/agent` (`packages/agent`) holds the logic; the web application's server actions
(`apps/web/src/app/agent/actions.ts`) run it as the signed-in person.

1. **Identity.** The web application exchanges the person's access token (RFC 8693, Keycloak
   standard token exchange) for one issued to the in-app agent's client, declared with
   `kf declare-agent` (ADR 0035). Every call the agent makes carries that token, so the database
   records the agent's participation on each read and write. With no agent client configured, the
   agent reads as the person and refuses to commit a draft, because a write it made would carry no
   participation.
2. **Retrieval** through the API only: `GET /search`, then `POST /context-source/retrieve` and
   `POST /context-source/read` for each reference, over loopback (KF-SAS-RQ-253). Every read is
   checked against current authority and recorded in `search.context_disclosure` (KF-SAS-RQ-250).
   A missing or stale master record is compiled once, as the person's act.
3. **Routing**, below.
4. **Citation check.** The model is given numbered sources and must cite by number. An answer that
   cites a number that is not a source of this turn, or mentions a record id that is not one, is
   refused (KF-CHAT-002). It is not trimmed.

## The backend router (KF-SAS-RQ-271, RQ-272)

**The setting** is per organization: `core.model_routing_policy.provider_ceiling`, the highest
classification that may leave the host to a provider's model or in a notification. It is `none`,
`public` or `internal`. Nothing set means `internal`, ADR 0040's default. It is written only by
`set_model_routing_policy`, an institutional act, so no agent can widen it. The database refuses
`confidential` and `restricted` in every session, an administrator's included (KF-ROUTE-001).
`GET /model-routing` reads it.

**The decision.** The router reads the highest classification of everything a turn carries: this
turn's records, plus every earlier answer in the conversation.

| Highest classification in the turn | Provider configured | LAMU on the host | Answered by                                       |
| ---------------------------------- | ------------------- | ---------------- | ------------------------------------------------- |
| at or below the ceiling            | yes                 | any              | the provider (or LAMU if preferred)               |
| at or below the ceiling            | no                  | yes              | LAMU                                              |
| above the ceiling                  | any                 | yes              | LAMU, only                                        |
| above the ceiling                  | any                 | no               | refused, KF-ROUTE-004                             |
| anything, and LAMU fails           | any                 | yes, failing     | refused, KF-CHAT-001; never retried on a provider |

**The enforcement point** is `ProviderBackend.complete` (`packages/agent/src/backends.ts`). It is
the last line before the provider's transport is handed a byte. It re-checks every context item's
own classification and every earlier answer's label against the ceiling, on the exact request about
to be sent. If anything may not leave, it throws KF-ROUTE-003 naming the records, and the transport
is never called. Under a `none` ceiling it refuses everything, including the person's own words.
The router chooses the backend. This guard is what makes a router bug, or a caller that skips the
router, fail closed.

**LAMU** is reached at its OpenAI-compatible `POST /v1/chat/completions`. The adapter refuses any
address that is not loopback, so an "on-host" backend cannot be pointed off the host.

**The provider** is the Claude API through `@anthropic-ai/sdk`. The model is `claude-opus-5-5` by
default, or `claude-sonnet-5`, at effort `medium`. The key is read from an owner-only file on each
call (`KF_AGENT_PROVIDER_KEY_FILE`). The SDK is given that key explicitly, and the web application
refuses to start a turn if `ANTHROPIC_API_KEY` is in its environment. On the owner's workstation
the key lives in the secrets store and is materialized for a run with `secrets run --`. It is never
in the repository or an env file.

## The embedding pump (SAS §100.44)

A record is findable by meaning once the worker's embedding pump has handed its text to the
retrieval engine (`apps/worker/src/embedding.ts`, `20261007500000`). Until this milestone the pump
claimed one batch of 32 records per two-second tick, so however fast the engine was a large ingest
became findable at most 960 records a minute.

- **Concurrent and bounded.** Up to `KF_EMBEDDING_CONCURRENCY` engine requests in flight (1 to 16;
  default 1, the fixture stack 4). Each consumer claims one record, embeds it with no transaction
  open, completes it, and claims the next, until nothing is claimable; only then does the pump
  sleep.
- **Never twice under a race.** A claim is a lease on one record, at least twice the engine timeout
  (60 s), so it cannot lapse under a live worker, and claims skip locked rows, so two workers never
  hold one record. A record edited while it is being embedded is marked, not released: its new text
  is embedded after the old one is answered, never beside it, so a stale vector cannot land last.
  (Before `20261007500000` an edit released the claim and a second consumer could embed the new text
  while the old was still in flight; whichever answered last was kept.) What remains is waste, not
  a duplicate: when the client gives up on a slow engine (60 s) the engine may still store that
  vector, and the retry stores it again in the same slot.
- **Failures back off, then are recorded.** A record the engine refused, or that could not be
  completed, waits 15 s · 2^(attempts−1) (capped at an hour) and after eight attempts is recorded as
  given up in its queue row — `failed_at`, the class of failure, the count — and is not claimed again
  until it is enqueued again (an edit, or `stack.sh reindex`). `retrieval.embedding_backlog()` counts
  the queue for the worker's log. An engine that fails the handshake costs no record an attempt:
  nothing is claimed, and the pump backs off as a whole, doubling from 2 s to five minutes.
- **The band version** is untouched by any of this (§64A): vectors still land after the act that
  moved it, and the client still rebuilds its bitmaps when the engine's slot count moves.

Measured on this workstation's copy of the fixture stack (not the owner's), Véracier's 2 245
records re-enqueued and drained to empty, bge-m3 on the fixture's GPU embedder, each run twice,
interleaved; the host was shared with other work (load average 50 to 80, I/O pressure 50 to 85 %),
and the copy's PostgreSQL ran with `synchronous_commit = off` for both, so the commits did not wait
on that disk:

| pump                                  | run 1     | run 2     |
| ------------------------------------- | --------- | --------- |
| before (one batch of 32 per 2 s tick) | 877 / min | 604 / min |
| after, 1 in flight                    | 2 234     | 2 454     |
| after, 4 in flight                    | 2 911     | 2 811     |
| after, 8 in flight                    | 2 910     | 2 683     |

Four saturates the fixture's embedder, which embeds one request at a time behind a lock. On a CPU
embedder the default is one: the same model on four pinned cores embedded 60 records at 13 a minute
with one in flight and 10 to 11 with two or four, where long records also outran the timeout and
were embedded again.

## The agent as the joining guide (KF-WAR-0007)

While the reader's own qualification record is open, every turn also reads `GET /start-here/guide`
(`packages/agent/src/guide.ts`). The guide — their pack, next requirements in order, named contact
and the closed lists of what a guide may and may not do — rides as **one more numbered source**,
labelled like any record, and only its record-free rules (`GUIDE_RULES`) go into the system
prompt. When the route answers 404 (no open record), the turn is exactly what it was without it.

**Its label is the record's level.** A qualification record is confidential (ADR 0038 decision 12),
but `assign_qualification` creates its envelope at the kind's default, `internal`, because the
envelope says only the scope. What the guide carries is the confidential part, so the API serves
the envelope's label raised to `confidential` (`guideClassification`), and the agent raises it
again (`guideLabel`; absent or unknown is `restricted`). Under any ceiling a guided turn is
answered on the host or refused (KF-ROUTE-004), and its sealed answer keeps the rest of the
conversation on the host. A deployment without LAMU therefore cannot answer a qualifying person's
questions in chat; their Start Here page is unaffected.

**What it may do.** "Record that …" offers the guide's one act, `submit_qualification_evidence`, on
the person's own record only (the draft's target is the guide's record, whatever the model says),
filled only by the host's model. It names evidence and credits nothing. Crediting and accepting
are on no agent's list, `submitDraft` refuses them before any call, the route refuses an agent's
credit, and the database refuses it again (KF-QUAL-011). The model's prose is not checked against
the may-not list; the rules tell it never to claim a requirement is satisfied, and the record is
what says whether one is.

## The KF MCP server lands drafts the same way

`submit_act` in the KF MCP server (`apps/mcp/src/server.ts`) calls the same `submitDraft` the chat
does (`@kf/agent/submit`, a subpath that loads none of the model backends). The two surfaces differ
only in their words; what lands and how — the draft rebuilt from the fields, a submit act performed
and read back for its verification, an institutional act only proposed — is one implementation.

## The conversation is not stored

The server stores no question, no answer and no conversation. The page holds the conversation in
memory and loses it on reload.

The reason: an answer is a projection of records the reader may read now. A stored answer would be
a copy of record text outside the record, with its own retention, its own export and backup
exposure, and a grant problem: when a grant is withdrawn, the stored answer would keep quoting the
record. The context source exists to avoid that. What a turn disclosed is already recorded, as
transient observations under §64B: each read in `search.context_disclosure` and each query in
`search.recorded_query`, both swept at 90 days.

Because the browser carries earlier answers back as context for a follow-up, each answer is sealed
with an HMAC over its text and classification. The key is derived from the web session key and the
browser never sees it. An earlier answer whose seal does not verify is treated as `restricted`, so
a lowered label can only keep a conversation on the host.

`tests/permissions/agent-chat.test.ts` ("a turn keeps nothing") counts every table's rows before and
after a turn and allows only the transient disclosure tables to change.

## Notifications (KF-SAS-RQ-274)

`kf-notify@.service` (`apps/notify`) runs as `kf-notify`, on a database login that inherits
`kf_notifier` and reads no table.

- **The daily digest** (`kf-notify-digest.timer`, 07:00). It calls `core.needs_you_digest()`, which
  returns each person's Needs you — the same three lists, read grants and clearance as
  `GET /needs-you` — with a title and an identifier only for items at or below the organization's
  provider ceiling. Everything else is a count and a link. The composer does not print a title from
  a row not marked disclosed, even if the row carries one. Subjects carry no titles. A person
  with nothing waiting gets nothing. A person can turn the digest off with
  `set_notification_preference` (`digest: off`); nobody else can turn it off for them, including an
  agent acting for them (KF-NOTIFY-001). SMTP settings come from `/etc/kf/notify/smtp.json` (0600),
  over TLS or STARTTLS. A plain connection is allowed only to a loopback relay.
- **The urgent push** (`kf-notify-urgent.timer`, every five minutes). It calls
  `core.urgent_notifications(since, item)`. The urgent kinds are an act an agent proposed and its person
  must perform, and a warrant blocker opened in the organization (for its organization-wide
  technical authorities). A failed backup or alert is the third kind, and `kf-alert@` already
  pushes it on `OnFailure=`. When anything urgent arose for the person this host's alert path
  reaches (`KF_NOTIFY_PUSH_PERSON`), it runs `scripts/alert-dispatch.sh` with the event `urgent`: the same script,
  endpoint and credential custody as the operational alerts. The push is one fixed line, "Something
  in Knowledge Fabric needs you. Open Needs you." It names no record, person, organization or host.
  Nothing that is not urgent is ever pushed. A person can turn the push off (`push: off`).

Timer liveness: both timers declare `X-KF-MaxSilenceSec`, so `scripts/timer-liveness.sh` reports a
stopped or silent one.

## Limits, recorded

- **What a person types is not classified** (KF-WAR-0006 RR-001). The router classifies what KF put
  in the context. Text a person pastes into a question can still reach a provider when the turn's
  context allows one. Drafting prefers LAMU for the same reason: dictated words are about to become
  a record.
- **LAMU's own forwarding.** LAMU can be configured to forward to a cloud gateway
  (`LAMU_GATEWAY_URL`). KF cannot see that from outside, so the host's commissioning must keep it
  unset.
- **One push destination.** The urgent push reaches the one person the deployment's alert topic
  belongs to. Other people learn of urgent items from their digest until per-person topics exist.
- **The urgent boundary** is the last item a run saw, as (time, item id), kept in `/var/lib/kf-notify`
  at the database's microsecond precision (`20261007500100`). This previously read: "kept at
  millisecond precision … an item committed after a later item, in the same millisecond, can be
  missed by the push". That edge is closed: a later item in the same instant is after the boundary
  by its id, and a seen item never is (`tests/database/notifications.test.ts`). What remains: an
  item's time is when its transaction began, so an item whose transaction began before a run and
  committed after it is behind the boundary that run set. The window is how long a proposing
  transaction stays open, milliseconds for an act through the API. The digest still lists it.
