# Identity and login

**Status: WALKED 2026-08-27. The login DID NOT COMPLETE.** It stopped at a precise, named
place, recorded below.

This document follows `docs/onboarding.md`'s discipline: every step is marked **verified** — it
was run and its output observed — or **derived**, meaning it was read out of code and
configuration and has never been executed. A runbook nobody has followed is the same failure as
a test that has never failed, so the two are not mixed.

No human has ever completed OIDC against a Keycloak realm in this project. That was true before
this walk and it is still true after it. What changed is that the reason is now specific.

---

## Where it stops

**Three findings, all verified, and they compound.**

### 1. The realm does not exist

```
GET http://localhost:8080/realms/knowledge-fabric/.well-known/openid-configuration  ->  404
GET http://localhost:8080/realms/master/.well-known/openid-configuration            ->  200
```

Keycloak is running and healthy. It serves `master` and nothing else. The realm every piece of
configuration in this repository refers to has never been created.

### 2. Nothing in the repository would create it

`find . -iname '*realm*'` outside `node_modules` returns **nothing**. There is no realm export,
no import JSON, no provisioning script.

And `docker-compose.yml` runs Keycloak as:

```yaml
command: ['start-dev', '--http-port=8080']
```

No `--import-realm`, and no volume mounting a realm file into `/opt/keycloak/data/import`. So
bringing the stack up cannot produce the realm, and never could have. `docs/onboarding.md` §1 is
correct that the stack comes up — it does — but a healthy Keycloak with no realm is not a
working identity provider, and the step that would notice is §3, which is marked NOT VERIFIED.

### 3. The client configuration is commented out

Every OIDC line in `.env` is commented:

```
# OIDC_ISSUER=http://localhost:8080/realms/knowledge-fabric
# OIDC_AUDIENCE=knowledge-fabric-api
# OIDC_JWKS_URI=.../protocol/openid-connect/certs
# KF_WEB_OIDC_ISSUER=...
# KF_WEB_OIDC_CLIENT_ID=knowledge-fabric-web
# KF_WEB_OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
```

`.env.example` ships them commented, so a fresh clone starts with identity disabled. That is a
defensible default — it is also why nobody has tripped over finding 1 before now.

---

## What is verified working

Measured 2026-08-27, `docker compose ps`:

| service    | state           |
| ---------- | --------------- |
| `postgres` | up 22h, healthy |
| `minio`    | up 22h, healthy |
| `keycloak` | up 22h, healthy |

Keycloak 26.4, pinned by digest. Its health check runs against the **management** interface on
port 9000 inside the container, not 8080 — `localhost:8080/health/ready` returns 404 and that is
not a fault. The compose file already says so; repeated here because it looks like a failure.

---

## What would unblock it — DERIVED, not walked

Everything in this section was read out of code and configuration. **None of it has been
executed.** Treat it as a starting hypothesis for whoever performs the walk, and correct it in
place from what actually happens.

A realm named `knowledge-fabric` needs to exist, with:

- **An API audience.** `apps/api/src/config.ts` requires `OIDC_ISSUER`, `OIDC_AUDIENCE` and
  `OIDC_JWKS_URI`, and validates the token's `aud`. So the realm needs a client or scope that
  puts `knowledge-fabric-api` into the audience claim — the "audience mapper" `private-host.md`
  refers to.
- **A web client.** `knowledge-fabric-web`, public, authorization-code with PKCE, redirect URI
  exactly `http://localhost:3000/auth/callback`. `apps/web` reads `KF_WEB_OIDC_ISSUER`,
  `KF_WEB_OIDC_CLIENT_ID` and `KF_WEB_OIDC_REDIRECT_URI`.
- **A user, linked to a person.** The identity provider proves the subject only; KF resolves
  everything else. `packages/authorization/src/identity.ts` states it plainly in its header
  comment — the token subject must map to a live person through `org.external_identity`, keyed on
  `(issuer, subject)` because a subject is unique only within its issuer.
- **A role assignment and a clearance**, per ADR 0011: organization-scoped, effective-dated. A
  linked person with no clearance is refused, by design.

Whoever does this should **export the realm afterwards and commit it**, with a compose
`--import-realm`. Otherwise the next person meets finding 1 again, and this document will have
recorded a problem without removing it.

---

## What remains unknown

Nothing past realm creation has been exercised. The audience mapper, the subject link, the role
assignment, the clearance resolution and the browser round trip have never run together, and no
claim about them should be made from this document. `docs/onboarding.md` §3 also records an
unrelated hazard on the authoring machine: `pnpm dev` died on `ENOSPC` with 522,885 of 524,199
file watchers held by an unrelated desktop application. Find the consumer before raising any
limit.

This is step 3 of [`docs/path-to-daily-use.md`](../path-to-daily-use.md) — the hinge. Everything
user-facing queues behind it.
