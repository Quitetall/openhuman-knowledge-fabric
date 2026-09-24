# Identity and login

**Status: WALKED 2026-08-27. The login COMPLETES.** A browser-shaped authorization-code + PKCE
flow against the local Keycloak now issues an access token, and the API verifies that token and
refuses it at exactly one designed place: the subject is not linked to a person. Everything up to
that point is measured, not derived.

This document follows `docs/onboarding.md`'s discipline: every step is marked **verified** — it
was run and its output observed — or **derived**, meaning it was read out of code and
configuration and has never been executed. A runbook nobody has followed is the same failure as a
test that has never failed, so the two are not mixed.

An earlier revision of this file recorded three findings that blocked the walk. All three are
gone, and how each was removed is recorded below rather than deleted — a document that quietly
stops mentioning a problem cannot be distinguished from one where the problem was never real.

---

## Bring identity up — verified

Two commands from a clean clone.

```sh
docker compose up -d keycloak
KF_DEV_USER_PASSWORD=<choose one> scripts/deploy/create-dev-user.sh
```

The first imports the realm. The second creates a local account and prints the subject claim its
tokens will carry.

### Why the user is a separate step

`deploy/keycloak/knowledge-fabric-realm.json` is a partial export taken with users **excluded**,
and the export asserts they are absent. A realm export carrying users carries their credential
representations, and a credential in git is disclosed permanently — reverting the commit does not
undo it. So the realm ships complete except for the one thing that cannot be committed.

The consequence is deliberate: **a fresh clone gets a realm with no users and cannot log in until
`create-dev-user.sh` runs.** That is the correct failure. The alternative is a shipped account
whose password is public, on the service every deployment profile points at.

`create-dev-user.sh` refuses a non-loopback `KEYCLOAK_BASE_URL` and refuses to default
`KF_DEV_USER_PASSWORD`. Both refusals were falsified — invoked and observed to refuse. The
loopback check parses the URL and tests the hostname rather than matching the text: a glob on the
string is bypassable through the userinfo field, since `http://localhost:8080@example.org/` starts
with `http://localhost:` while curl sends the request to `example.org`.

### Changing the realm, and re-exporting it

The realm file is 2,400 lines of Keycloak's own state, including a generated UUID for every flow,
client and role. Edit it through Keycloak — admin console or admin API — and then re-export;
hand-editing the JSON is how those identifiers stop agreeing with each other.

```sh
# obtain an admin token first (see create-dev-user.sh for the request shape)
curl -sS -H "Authorization: Bearer $TOKEN" \
  'http://localhost:8080/admin/realms/knowledge-fabric/partial-export?exportGroupsAndRoles=true&exportClients=true' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); assert not d.get("users"), "users must not be exported"; print(json.dumps(d, indent=2, sort_keys=True))' \
  > deploy/keycloak/knowledge-fabric-realm.json
pnpm exec prettier --write deploy/keycloak/knowledge-fabric-realm.json
```

`partial-export` omits users by default, and the assertion above makes that a checked property
rather than a remembered one — `tests/deployment/keycloak-realm.test.ts` checks it again at commit
time. Sort the keys so the diff is reviewable: without it, an unordered re-export churns most of
the file and hides the two lines that actually changed. **Read the diff before committing** — a
Keycloak upgrade moves `keycloakVersion` and can rewrite defaults you did not intend to adopt.

Note that `docker compose down` then `up` does **not** re-import: the realm persists in the
`keycloak-data` volume and Keycloak skips a realm that already exists. To prove an import works you
must first remove the realm (or the volume), which is what the demonstration below does.

---

## What is verified working

Measured 2026-08-27 against Keycloak 26.4, pinned by digest.

### The realm is created by the repository

Not asserted — demonstrated by destroying it:

| step                                             | observed |
| ------------------------------------------------ | -------- |
| `DELETE /admin/realms/knowledge-fabric`          | `204`    |
| discovery immediately after                      | `404`    |
| `docker compose up -d --force-recreate keycloak` | —        |
| discovery, 10 seconds later                      | `200`    |

The realm came back from the committed file and nothing else. Keycloak skips a realm that already
exists, so `--import-realm` is safe on every subsequent start; it is not a reset.

After the round trip, `knowledge-fabric-api` is present and confidential, and
`knowledge-fabric-web` is public with redirect URI exactly `http://localhost:3000/auth/callback`
and one `oidc-audience-mapper`. The mapper is the load-bearing part — see the token below.

### The login completes

Authorization-code with PKCE `S256`, driven by curl against the real login form:

| step                                    | observed                               |
| --------------------------------------- | -------------------------------------- |
| `GET .../protocol/openid-connect/auth`  | `200`, login form                      |
| form POST with the dev credential       | `302` to `/auth/callback?...&code=...` |
| `POST .../token` with the code verifier | `200`, access token and `id_token`     |

The issued access token carries `iss` of the realm, `sub` equal to the subject
`create-dev-user.sh` printed, `azp: knowledge-fabric-web`, and:

```
aud: ["knowledge-fabric-api", "account"]
```

That first entry is produced by the audience mapper and is exactly what `apps/api/src/config.ts`
validates. It was the single most likely thing to be silently wrong, and it is right.

Since ADR 0035 the web client carries a second audience mapper, naming `knowledge-fabric-agent`,
so that an agent may exchange the person's token; measured 2026-09-24, the token's `aud` is then
`["knowledge-fabric-api", "knowledge-fabric-agent", "account"]`, and the API's audience check is
unaffected (see [An agent acting for a person](#an-agent-acting-for-a-person--token-shape-verified-end-to-end-derived)).

**PKCE is enforced, not merely offered.** Falsified on a fresh, unused code: presenting the wrong
verifier returns `400 invalid_grant — PKCE verification failed: Code mismatch`.

### The API verifies the token

Run with `KF_DEPLOYMENT_PROFILE=dogfood`, `HOST=127.0.0.1`, and the three `OIDC_*` variables set.
`OIDC_ISSUER` and `OIDC_JWKS_URI` must be `https://` unless they are loopback (`localhost`,
`127.0.0.1`, `[::1]`), as the web client already required: whoever is on the path of a cleartext
key fetch supplies the keys. Both the API and the web client accept only `RS256` signatures, the
realm's `defaultSignatureAlgorithm`; changing the realm's algorithm means changing
`OIDC_SIGNING_ALGORITHMS` (`packages/authorization`) and `ID_TOKEN_ALGORITHMS`
(`apps/web/src/lib/oidc.ts`) with it.

Since migration `20260924001000` the dogfood API also needs `KF_ATTESTOR_SOCKET` naming a running
`kf-attestor`, and it refuses to start through a login that holds `kf_attestor` — which
`kf_api_dev`, the login `pnpm dogfood:load` creates, does. Re-walking this today is
`pnpm dogfood:logins` once, then `pnpm dev:dogfood`, as
[`local-development.md`](local-development.md#dogfood-profile-local-identity-rehearsal) describes;
the table below was observed before that change.

`GET /master-record`, with `x-kf-acting-role` and `x-kf-organization` supplied:

| token presented                         | status | body                                                          |
| --------------------------------------- | ------ | ------------------------------------------------------------- |
| none                                    | `401`  | `no_token`                                                    |
| `not-a-jwt`                             | `401`  | `invalid_token` — "token rejected"                            |
| valid token from the **`master`** realm | `401`  | `invalid_token` — "token rejected"                            |
| the real `knowledge-fabric` token       | `401`  | `unknown_subject` — "this identity is not linked to a person" |

The third row matters as much as the fourth: a correctly signed token from the wrong issuer is
refused, so the check is not "is this a JWT".

Any of those rows with `kf-attestor` down answers `503` `attestor_unavailable` instead: nobody
could be asked whether the token is good, so the caller is neither refused nor let in, and the
API never falls back to verifying it in-process (asserted by `tests/permissions/attestor.test.ts`
and `apps/api/src/app.test.ts`, not observed on this walk).

The fourth row is the designed stopping point, and it is where the walk ends.

---

## The three findings from the previous revision

**1. "The realm does not exist."** Removed. It is created by `docker compose up`, demonstrated by
destroying it first.

**2. "Nothing in the repository would create it."** Removed. `deploy/keycloak/knowledge-fabric-realm.json`
is committed and `docker-compose.yml` passes `--import-realm` with the directory mounted
read-only. Read-only on purpose: a container able to rewrite the realm file would let local drift
silently become the checked-in truth.

**3. "The client configuration is commented out."** Still true in `.env.example`, and still
correct. The `OIDC_*` block is required only under `KF_DEPLOYMENT_PROFILE=dogfood`; the default
`development` profile is a fixed-identity workspace that does not want it. What was wrong was the
comment above it, which claimed "merely starting the container does not provision either one".
That has been false since the realm was committed, and it has been corrected.

## What walking found that reading would not have

**A user without a profile authenticates and still does not get a code.** The first version of
`create-dev-user.sh` created the account with only a username. The password was accepted and the
flow ended at `/login-actions/required-action?execution=VERIFY_PROFILE` with no `code` parameter.
That is indistinguishable from a rejected credential if you are only looking at whether you got a
code back. The realm's user profile marks `email`, `firstName` and `lastName` required, so the
script now sets them, and re-applies them on the already-exists path — "already exists" must not
mean "still broken".

**The acting-role check runs before token verification.** Without `x-kf-acting-role`, a garbage
token and a valid token both return `no_role_requested`. Neither is admitted, so nothing leaks —
but an operator debugging a login sees a message about roles when their real problem is the
token. Worth knowing before you spend an hour on it.

---

## Granting the authority — verified

The three acts between `unknown_subject` and a usable session are one command:

The owner connection string is read like every other secret: from `DATABASE_OWNER_URL_FILE`
(owner-only, `chmod 600`, refused otherwise). The inline `DATABASE_OWNER_URL` is accepted only
when `NODE_ENV` is `development` or `test`, which is what the local `.env` sets; anywhere else it
is refused before an argument is read. The same holds for `kf bootstrap-organization`,
`kf revoke-identity`, `kf retire-organization` and `kf:declare-service-actor`.

```sh
DATABASE_OWNER_URL_FILE=/etc/kf/owner/database-url \
pnpm kf:grant-authority \
  --person       <org.person id> \
  --organization <org.organization id> \
  --role         performer \
  --clearance    restricted \
  --granted-by   <the person who decided> \
  --issuer       http://localhost:8080/realms/knowledge-fabric \
  --subject      <the sub printed by create-dev-user.sh> \
  --reason       'why this authority was granted, and on whose say-so' \
  --valid-to     2027-09-24
```

It links the identity, assigns the role and grants the clearance in **one transaction**, recording
a real `grant_person_clearance` action and extending the audit chain. Nothing that widens authority
is defaulted: a run missing any such flag prints every refusal at once and writes nothing.

**The assignment ends.** `--valid-to` (an ISO date or instant) is the day the role assignment
stops granting — its review date. It must be in the future and at most 366 days away (a year and a
day, ADR 0036); omitted, it is one year (365 days) from the run, and the command prints the date it
used. The database refuses any role assignment or project membership written without an end, or
ending more than 366 days after it starts, on the owner connection as well as the application's;
the only exception is an assignment written under the bootstrap identity
(`01930000-0000-7000-8000-00000000b007`) on the owner connection, which only the local dogfood
loader and the test harness do.

**Renewal is a new assignment.** Re-running the command while the assignment is live changes
nothing, as before. To renew it — the review is the act — add `--renew`: the live assignment is
ended now and a new one, attributed to `--granted-by` under a recorded `grant_person_clearance`
action, runs from now to `--valid-to`. Its id is new, so anything configured with the old
assignment id (a service actor's `KF_STORAGE_ROLE`, a client's `x-kf-acting-role`) must be updated.
An assignment that has already lapsed needs no `--renew`: the command grants a fresh one. An
assignment made before ADR 0036 has no end at all; readiness reports it under
`assignment_review_dates` as "no review date" until it is renewed this way.

**Delegation goes one level deep.** An assignment that names a `delegated_by` (a service actor's,
from `kf:declare-service-actor`) is a delegation, and the database refuses one whose delegator holds
that role, at that scope, only through a delegation of their own. `kf:grant-authority` itself
writes no `delegated_by`: it is the owner credential recording a human decision, not a delegation.

**Run it before the ontology seed and it will fail**, because `grant_person_clearance` is a new
action type and `core.action.action_type` is a foreign key into `registry.action_type`:

```sh
psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -f generated/sql-registry/001-ontology-seed.sql
```

Measured on 2026-08-27 against the workstation `kf` database:

| after                      | `GET /master-record` with a real token |
| -------------------------- | -------------------------------------- |
| realm + user only          | `401 unknown_subject`                  |
| after `kf:grant-authority` | `404 master_record_not_found`          |

The second row is the whole point: identity resolved, clearance held, and the request reached a
**domain** answer instead of an authority refusal. The record itself is compiled by
`compile_master_record`, which is step 4.

Also verified: the audit event landed at `seq=14` chained from the previous head, and
`core.audit_chain_head` matches the last event — the bootstrap writer and the dispatcher share
`appendAuditEvent`, so there is one implementation of that arithmetic. And a second identical run
reported "nothing to do", wrote nothing, and did **not** mint a second action: re-running a setup
command must not record a decision nobody made.

### Withdrawing a link

`pnpm kf:revoke-identity` undoes the link and is recorded the same way: a
`revoke_external_identity` act with a required `--reason` and `--revoked-by`, an audit event, and
`revoked_at` set in one transaction; the person's outstanding attestations are withdrawn with it,
so the next request with that account's token is `401 revoked_identity`. A link already revoked is
refused and nothing is written. See the
[runbook](../operating-model/runbook.md#linking-a-person-to-an-identity-provider-account). Verified
against the test harness (`tests/database/revoke-identity.test.ts`), not yet on the workstation.

### The founding grant

`--granted-by` names the person who decided, and the act is recorded under a role assignment
that person holds in the organization. The first grant in a new organization has no such
assignment — nobody holds one, the founder included — and until 2026-09-11 that made every
organization's first grant impossible. The one admitted exception: the organization holds no
live role assignment at all, and the person being granted is the grantor. The founder assigns
themself the role first and exercises it for the clearance that follows, so the act is still
recorded under a real assignment held by the actor. Any later self-grant is refused.

### A token without a browser

`scripts/deploy/login-token.sh`, given a username and a token file path, performs the same authorization-code
PKCE login the table above walked, with curl against the realm's login form, and writes the
access token 0600. It is the token the person would hold after logging in themselves; `kf
ingest --identity=oidc` and `kf master-record` take it as `--token-file`.

The password is read from the terminal without echo, or from `KF_LOGIN_PASSWORD_FILE`, which
must be owner-only (0600). `KF_LOGIN_PASSWORD` is refused: set on a command line it lands in shell
history, and exported it is inherited by every child of the shell. `kf master-record` likewise
refuses a `--token-file` readable beyond its owner, and writes `--out` as 0600, including over
an existing file.

### Why this is not a dispatched action

Because it cannot be. Dispatch binds authoritative clearance before effects run, so granting the
FIRST clearance in an organization through the dispatcher is circular — the clearance would have
to already exist. It runs on the owner connection instead, which is also why it is a command a
human types and not an HTTP route: `linkIdentity` says "somebody decides that this account is that
person, and that decision is recorded with who made it."

## An agent acting for a person — token shape verified, end to end derived

ADR 0035: an agent that forms and dispatches an act for a named person does so on a
**delegated token** obtained by OAuth 2.0 Token Exchange (RFC 8693). The act is the person's —
actor, role, clearance and grants are theirs — and the ledger records the agent's client id in
`core.action.agent_participation` (KF-SAS-RQ-204).

### What Keycloak 26.4 actually issues — verified

Measured 2026-09-24 against `quay.io/keycloak/keycloak:26.4` (26.4.7, the pinned image), in a
throwaway container that imported the committed realm, with a probe user and — in that container
only — the password grant switched on for `knowledge-fabric-web` to obtain the subject token:

| exchange requested by                                                      | `sub`      | `azp`                    | `act`                                                                      |
| -------------------------------------------------------------------------- | ---------- | ------------------------ | -------------------------------------------------------------------------- |
| a client with standard token exchange on and **no** act mapper             | the person | the requesting client    | **absent**                                                                 |
| `knowledge-fabric-agent` (exchange on, the shipped `act-client-id` mapper) | the person | `knowledge-fabric-agent` | `{"client_id": "knowledge-fabric-agent"}`                                  |
| a client with standard token exchange off                                  | —          | —                        | refused: "Standard token exchange is not enabled for the requested client" |

So **Keycloak 26.4's standard token exchange emits no `act` claim of its own.** It records the
requesting client only as `azp`, and it ignores an `actor_token` (the request succeeds, with no
delegation in the result). Delegation with a native `act`/`may_act` exists only as an experimental
feature of later releases, which this deployment does not run. The committed realm therefore gives
each agent client an `oidc-hardcoded-claim-mapper` that stamps `act.client_id` with the client's
own id: a token is issued _to_ the agent client only when that client authenticated for it, so the
claim is Keycloak's signed statement of which client holds the token. The exchanged token also
carries no `auth_time`, so an agent can never satisfy a step-up policy: money, release and
control-withdrawal acts stay with the person in a fresh session. That is the fail-closed direction
and is left so.

### What `kf-attestor` accepts

After the signature, issuer, audience, algorithm and expiry checks it always made:

- **No `act`**: a direct act. `agent_participation` is null.
- **`act` is an object with exactly `client_id`**, a non-empty string equal to the token's `azp`:
  an act through that agent. Anything else — `act` not an object, a nested `act.act` (depth 1
  only), a `sub` instead of a `client_id`, a `client_id` that is not the `azp` — is a token defect,
  refused as `invalid_token` like every other.
- **The client must be a declared agent.** `core.issue_attestation` refuses a `client_id` that is
  not live in `org.declared_agent`, and refuses a token with no `act` whose `azp` _is_ a declared
  agent (a declared agent whose realm lost its mapper must not pass as the person). Both answer
  `401 undeclared_agent`, and nothing is attested.

The declared list is Knowledge Fabric's, not the realm's, for the reason role claims are never
read: a realm administrator could otherwise make any client an agent without touching this
system. Keycloak says which client holds the token; the database says whether that client may
take part. `kf declare-agent` (owner credential) writes the declaration; see the
[runbook](../operating-model/runbook.md#declaring-an-agent-client).

### How participation reaches the ledger

The attestation row stores the agent's client id. `core.bind_principal` reads it from the matching
attestation and seals it into the transaction (`kf.agent_participation`), and a trigger on
`core.action` copies the sealed value into `agent_participation` on every insert, overwriting
anything the application supplied. The column is not in the audit-chain preimage, so the audit
digest is unchanged; the preservation export carries it in `actions.json`, and an archive written
before the column restores with it null.

### Using it — derived

1. Declare the client: `kf declare-agent --client knowledge-fabric-agent --declared-by <uuid> --reason '…'`.
2. Give the agent its client secret out of band (the export masks it) and keep it with the agent.
3. The person's own token (from `knowledge-fabric-web`, which lists `knowledge-fabric-agent` as an
   audience so it can be exchanged) is exchanged by the agent:

   ```sh
   curl -s -u knowledge-fabric-agent:<secret> \
     -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
     -d subject_token=<the person's access token> \
     -d subject_token_type=urn:ietf:params:oauth:token-type:access_token \
     -d audience=knowledge-fabric-api \
     "$OIDC_ISSUER/protocol/openid-connect/token"
   ```

4. The agent calls the API with the exchanged token and the person's `x-kf-acting-role`,
   exactly as the person would.

Step 3 was run in the throwaway container above; step 4 is exercised by
`tests/permissions/agent-participation.test.ts` against the real attestor over its socket with
tokens of the measured shape, not yet against a live Keycloak and API together.

## What remains

The browser round trip through `apps/web` has not been run — the flow above was driven by curl,
which proves the protocol but not the front end. `docs/onboarding.md` §3 records the hazard:
`pnpm dev` died on `ENOSPC` with 522,885 of 524,199 file watchers held by an unrelated desktop
application. Find the consumer before raising any limit.

Compiling a master record has not been exercised through an authenticated session either. That is
step 4.

This is step 3 of [`docs/path-to-daily-use.md`](../path-to-daily-use.md).

## Realm hardening

The committed realm enables brute-force protection (temporary lockout after 10 failures),
requires passwords of at least 14 characters that are not the username or email, makes every
new account enrol TOTP before its first login (`CONFIGURE_TOTP` is a default action; the browser
flow's conditional 2FA then demands it), revokes a refresh token once used, caps offline
sessions at 3 days idle and 7 days in total, and disables the password grant on `admin-cli`.
Commissioning (`identity_provider_policy`) refuses a realm that reverts any of these.

`scripts/deploy/create-dev-user.sh` clears required actions on the loopback development
account it creates, so that account does not enrol a second factor. It refuses any non-loopback
Keycloak, which is what keeps that exception on the workstation. Its password must now satisfy
the realm policy: 14 characters or more.
