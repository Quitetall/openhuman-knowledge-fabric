# Local development and workstation dogfood

This page is for a single workstation. `docker-compose.yml` starts dependencies with public,
fixed credentials on loopback; it is not a private-host topology. See
[`private-host.md`](private-host.md) for the promotion boundary.

## Deployment profiles

`KF_DEPLOYMENT_PROFILE` is mandatory. It describes whether records can carry authenticated
human provenance; `NODE_ENV` still controls framework behavior, TLS posture and secret loading.
Neither variable substitutes for the other.

| Profile       | Identity path                                            | Where it is allowed                          | Authority claim |
| ------------- | -------------------------------------------------------- | -------------------------------------------- | --------------- |
| `development` | Explicit fixed headers from `KF_DEV_*`                   | `NODE_ENV=development` or `test`, one owner  | None            |
| `dogfood`     | Verified bearer token plus live database role assignment | Local rehearsal or a controlled private host | Dogfood only    |

The API refuses `dogfood` without all of `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_JWKS_URI`.
The web application refuses its fixed caller in `dogfood` even if `NODE_ENV=development` and
`KF_ALLOW_FIXED_IDENTITY=1` are still present. A forgotten environment cleanup therefore does
not turn fixed headers into shared identity.

The web application implements OIDC authorization code with required PKCE, validates the
signed ID token and nonce, stores the access token in an encrypted host-only session cookie,
and forwards bearer identity to the API. It does not trust identity-provider role claims:
selected KF authority context is validated by the API before it is retained in the session.

## Prerequisites

| Tool    | Version                      | Why this one                                                         |
| ------- | ---------------------------- | -------------------------------------------------------------------- |
| Node.js | 24.18.1 (current active LTS) | Pinned in `package.json` `engines`, enforced by `engine-strict=true` |
| pnpm    | 11.x                         | Workspace protocol and isolated `node_modules`                       |
| Docker  | with Compose v2              | PostgreSQL 18, MinIO, Keycloak                                       |

`corepack` is not bundled on every distribution. If `pnpm` is missing:
`npm install -g pnpm@latest`.

## Development profile: first run

```sh
pnpm install
cp .env.example .env
set -a; . ./.env; set +a
docker compose config --quiet
docker compose up -d
DATABASE_URL="$DATABASE_OWNER_URL" pnpm db:migrate
pnpm dogfood:load -- --source-dir /path/to/OpenHuman_Technologies
```

The loader's JSON output includes `identity.actorId`, `identity.actingRoleId` and
`identity.organizationId`. Copy those UUIDs into `KF_DEV_ACTOR`, `KF_DEV_ACTING_ROLE` and
`KF_DEV_ORGANIZATION` in `.env`, then reload it and start the applications:

```sh
set -a; . ./.env; set +a
pnpm dev
```

- API — <http://localhost:4000/health> and `/ready`
- Web — <http://localhost:3000>
- Document library — <http://localhost:3000/documents>
- MinIO console — <http://localhost:9001>
- Keycloak — <http://localhost:8080>

The loader creates the constrained `kf_api_dev` login and a visibly synthetic local operator,
then imports the manifest sources as drafts. It never approves them, makes them effective or
allocates an enterprise identifier. Reruns are idempotent. Current actions use strict semantic
receipt replay. Pre-contract materializations require migration-owned provenance, exact action
and audit identity, a reverified pinned object version, and a source parse for document bytes;
they are recognized without rewriting history or attempting a second mutation. Staging uses
conditional create and verifies an existing content-addressed key rather than adding another
version. That fixed operator is a development
convenience, not proof of who used the browser; the landing page labels the interface
non-authoritative for the same reason.

`pnpm dev` works with or without the database up. The worker logs that it is idle rather
than crash-looping, and `/ready` reports `503` with `database: unconfigured` rather than
claiming readiness it does not have.

## Dogfood profile: local identity rehearsal

Compose starts Keycloak but deliberately does not invent a realm, client, users, MFA policy or
token lifetime. Before selecting `dogfood`, an operator has to configure and verify all of the
following:

1. A `knowledge-fabric` realm, public web client and API audience such as
   `knowledge-fabric-api`.
2. Exact callback and post-logout URLs for the web client, with authorization code and PKCE
   S256 required.
3. Access tokens whose exact `iss` matches `OIDC_ISSUER` and whose `aud` contains
   `OIDC_AUDIENCE`.
4. A reachable JWKS endpoint at `OIDC_JWKS_URI`.
5. A recorded `org.external_identity` link from the token `sub` to a person, plus the live role
   assignment the request will name. Nothing is auto-provisioned.

The local values, after that provider configuration exists, are:

```sh
KF_DEPLOYMENT_PROFILE=dogfood
OIDC_ISSUER=http://localhost:8080/realms/knowledge-fabric
OIDC_AUDIENCE=knowledge-fabric-api
OIDC_JWKS_URI=http://localhost:8080/realms/knowledge-fabric/protocol/openid-connect/certs
KF_WEB_OIDC_ISSUER=http://localhost:8080/realms/knowledge-fabric
KF_WEB_OIDC_CLIENT_ID=knowledge-fabric-web
KF_WEB_OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
KF_WEB_SESSION_SECRET=<canonical-base64-encoding-of-32-random-bytes>
```

Start the application processes after provider records and KF authority links exist:

```sh
set -a; . ./.env; set +a
pnpm dev
```

The browser selects a role assignment, organization and classification ceiling after login.
The web server sends `Authorization: Bearer ...` plus that context to the API. The token
establishes who the caller is; the database, not Keycloak role claims, decides what that person
may do. `pnpm --filter @kf/web test:browser` verifies this flow against controlled OIDC and API
fixtures. It is not qualification evidence for a real Keycloak realm.

Do not share this Compose stack. Its Keycloak `start-dev` mode and database/object-store
credentials are intentionally unsuitable for a network service. A shared dogfood instance
follows the private-host contract, uses `NODE_ENV=production`, terminates TLS and supplies
secrets from owner-only files.

## Verification

`pnpm gate` runs all of it in CI's order, fail-fast, and is the only list that cannot go
stale — `tests/deployment/gate-parity.test.ts` compares it against `.github/workflows/ci.yml`
and fails if either grows a step the other lacks. It stopped being the only place any of this runs
on 2026-08-18, when CI passed for the first time (run `32146924053`); before that, 38 runs had
died at job-start on Actions billing without executing a step. Billing then failed again on
2026-08-20 and CI moved to a sandboxed self-hosted runner — free, and deliberately a near-empty
container so it still behaves like a machine that is not this one. See
`deploy/self-hosted-runner/`. Prefer `pnpm gate` over running these by hand:

```sh
pnpm format:check   # prettier
pnpm lint           # eslint + typescript-eslint
pnpm typecheck      # tsc --build across 16 projects, then Next's own tsc
pnpm test           # vitest
pnpm ontology:check # ontology internally consistent, compared in memory
pnpm ontology:build && git diff --exit-code -- generated/   # committed output is current
pnpm build          # every package plus a real Next production build
```

The two ontology steps were missing from this list until 2026-08-16, which is the failure mode
`pnpm gate` exists to remove: a hand-maintained list of checks is wrong the moment CI gains one,
and it is wrong silently, because nothing compares the list to the thing it describes.

## Toolchain decisions worth knowing

**TypeScript is pinned to `~6.0.3`, not 7.** TypeScript 7 — the native compiler — is
released, but `typescript-eslint@8` declares `peerDependencies.typescript: ">=4.8.4
<6.1.0"`. Adopting 7 today means giving up type-aware linting. 6.0.3 is the newest version
that keeps both. Revisit when typescript-eslint supports 7.

**Ambient types are declared explicitly.** `tsconfig.base.json` sets `"types": []` and each
project lists what it needs. TypeScript 6.0 stopped auto-including every `@types/*` package;
being explicit is both the fix and the more deterministic configuration — an unrelated types
package can no longer leak globals into a project that never asked for it.

**`@types/node` is a per-package dependency.** Only the four packages that touch Node APIs
declare it. That is `.npmrc`'s isolated layout working as intended: a package may import
only what it declares.

## PostgreSQL notes

**The volume mounts `/var/lib/postgresql`, not `/var/lib/postgresql/data`.** From version 18
the official image stores the cluster in a major-version subdirectory (`/var/lib/postgresql/18`)
so `pg_upgrade --link` does not have to cross a mount boundary. Mounting `.../data` makes the
container refuse to start. Records here are retained indefinitely and will be carried across
many major versions, so this is load-bearing rather than cosmetic.

**Locale provider is `builtin` with `C.UTF-8`.** A libc collation change silently reorders
text indexes and breaks uniqueness assumptions across an OS upgrade. The builtin provider is
version-independent.

Server settings set in `docker-compose.yml`:

| Setting                  | Value     | Reason                                                   |
| ------------------------ | --------- | -------------------------------------------------------- |
| `wal_level`              | `logical` | Point-in-time recovery and logical replication (Gate 8)  |
| `track_commit_timestamp` | `on`      | Commit times available for audit reconciliation          |
| `log_statement`          | `ddl`     | Structural changes are logged; production adds `pgaudit` |

Capabilities verified on this stack, each one something the architecture depends on:

```sh
docker exec kf-postgres psql -U kf_owner -d kf -tAc "select uuid_extract_version(uuidv7());"   # 7
docker exec kf-postgres psql -U kf_owner -d kf -tAc "create extension if not exists btree_gist;"
```

`btree_gist` is required for effectivity: an exclusion constraint of the form
`exclude using gist (id with =, period with &&)` needs it to index a scalar alongside a
`tstzrange`. Without it, two overlapping effectivity periods for the same object would both
be accepted.

## Object storage

`minio-init` creates four buckets — `kf-artifacts`, `kf-snapshots`, `kf-checkpoints`,
`kf-exports` — and enables versioning on each. **Versioning must be on before the first
object is written**; enabling it later does not retroactively protect anything already
stored.

## Credentials

Every credential in `docker-compose.yml` and `.env.example` is a fixed development value,
public on purpose so a clean checkout can start its dependencies. Compose binds every published
port to `127.0.0.1`; changing those bindings makes the public credentials remotely reachable.
Do not do that. A private host uses distinct credentials and the file-based secret inputs
described in [`private-host.md`](private-host.md).

## Resetting

```sh
docker compose down -v    # destroys the database and object storage
```

This is a development-only reset. It is destructive even when the records are
non-authoritative. Never run it against shared dogfood or a private host; the restore procedure
in `docs/backup-and-restore/` applies there instead.
