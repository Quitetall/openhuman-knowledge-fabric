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

**PKCE is enforced, not merely offered.** Falsified on a fresh, unused code: presenting the wrong
verifier returns `400 invalid_grant — PKCE verification failed: Code mismatch`.

### The API verifies the token

Run with `KF_DEPLOYMENT_PROFILE=dogfood`, `HOST=127.0.0.1`, and the three `OIDC_*` variables set.
`GET /master-record`, with `x-kf-acting-role` and `x-kf-organization` supplied:

| token presented                         | status | body                                                          |
| --------------------------------------- | ------ | ------------------------------------------------------------- |
| none                                    | `401`  | `no_token`                                                    |
| `not-a-jwt`                             | `401`  | `invalid_token` — "token rejected"                            |
| valid token from the **`master`** realm | `401`  | `invalid_token` — "token rejected"                            |
| the real `knowledge-fabric` token       | `401`  | `unknown_subject` — "this identity is not linked to a person" |

The third row matters as much as the fourth: a correctly signed token from the wrong issuer is
refused, so the check is not "is this a JWT".

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

```sh
DATABASE_OWNER_URL=postgresql://kf_owner:...@127.0.0.1:5432/kf \
pnpm kf:grant-authority \
  --person       <org.person id> \
  --organization <org.organization id> \
  --role         performer \
  --clearance    restricted \
  --granted-by   <the person who decided> \
  --issuer       http://localhost:8080/realms/knowledge-fabric \
  --subject      <the sub printed by create-dev-user.sh> \
  --reason       'why this authority was granted, and on whose say-so'
```

It links the identity, assigns the role and grants the clearance in **one transaction**, recording
a real `grant_person_clearance` action and extending the audit chain. Nothing is defaulted: a run
missing any flag prints every refusal at once and writes nothing.

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

### Why this is not a dispatched action

Because it cannot be. Dispatch binds authoritative clearance before effects run, so granting the
FIRST clearance in an organization through the dispatcher is circular — the clearance would have
to already exist. It runs on the owner connection instead, which is also why it is a command a
human types and not an HTTP route: `linkIdentity` says "somebody decides that this account is that
person, and that decision is recorded with who made it."

## What remains

The browser round trip through `apps/web` has not been run — the flow above was driven by curl,
which proves the protocol but not the front end. `docs/onboarding.md` §3 records the hazard:
`pnpm dev` died on `ENOSPC` with 522,885 of 524,199 file watchers held by an unrelated desktop
application. Find the consumer before raising any limit.

Compiling a master record has not been exercised through an authenticated session either. That is
step 4.

This is step 3 of [`docs/path-to-daily-use.md`](../path-to-daily-use.md).
