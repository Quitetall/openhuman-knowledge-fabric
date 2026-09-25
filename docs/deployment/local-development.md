# Local development and workstation dogfood

This page is for a single workstation. `docker-compose.yml` starts dependencies with public,
fixed credentials on loopback; it is not a private-host topology. See
[`private-host.md`](private-host.md) for the promotion boundary.

## Deployment profiles

`KF_DEPLOYMENT_PROFILE` is mandatory. It describes whether records can carry authenticated
human provenance; `NODE_ENV` still controls framework behavior, TLS posture and secret loading.
Neither variable substitutes for the other, and neither has a default: the API refuses to start
when `NODE_ENV` is unset rather than assuming `development`.

The `development` profile believes whatever `x-kf-*` headers say, so the API refuses it on any
listener other than loopback. `HOST` defaults to `127.0.0.1` under every profile; `0.0.0.0` must
be asked for, and is refused under `development`.

| Profile       | Identity path                                            | Where it is allowed                          | Authority claim |
| ------------- | -------------------------------------------------------- | -------------------------------------------- | --------------- |
| `development` | Explicit fixed headers from `KF_DEV_*`                   | `NODE_ENV=development` or `test`, one owner  | None            |
| `dogfood`     | Verified bearer token plus live database role assignment | Local rehearsal or a controlled private host | Dogfood only    |

The API refuses `dogfood` without all of `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_JWKS_URI`, and
without `KF_ATTESTOR_SOCKET` naming a running `kf-attestor` (see the dogfood section below).
The web application refuses its fixed caller in `dogfood` even if `NODE_ENV=development` and
`KF_ALLOW_FIXED_IDENTITY=1` are still present. A forgotten environment cleanup therefore does
not turn fixed headers into shared identity.

The web application implements OIDC authorization code with required PKCE, validates the
signed ID token and nonce, stores the access token in an encrypted host-only session cookie,
and forwards bearer identity to the API. The verified ID token is kept in a second encrypted cookie
(`__Host-kf_id_token_hint`) for one purpose: sign-out sends it as `id_token_hint`, so the
provider ends its SSO session without asking for confirmation. Sign-out clears every local
cookie on every path, including when configuration fails to load or the request is refused as
cross-origin. It does not trust identity-provider role claims:
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

The loader needs `KF_ORGANIZATION_LEGAL_NAME`, the legal name of the organization it seeds, and
refuses to run without it: the deploying organization's identity is configuration, not source
(KF-SAS-RQ-192), and no file under `apps/`, `packages/`, `scripts/` or `deploy/` may name it
(`apps/api/src/dogfood/legal-name.test.ts` fails the build if one does). The loader finds the
organization by exactly this name and creates it when absent, so keep the value identical across
runs against one database; a different name seeds a second organization whose operator holds no
clearance, and the run stops at the clearance check. A database loaded before 2026-09-24 was
seeded under the name the bootstrap used to hard-code; set the variable to that name to keep
using it.

The loader ends with a paste-ready block: `KF_DEV_ORGANIZATION`, `KF_DEV_ACTOR`,
`KF_DEV_ACTING_ROLE` and `DATABASE_URL_FILE`. Copy it into `.env`, then reload it and start the
applications:

```sh
set -a; . ./.env; set +a
pnpm dev
```

`pnpm dev` sets `NODE_ENV=development` for the API, web and worker itself — the API no longer
defaults it (2026-09-23) — so nothing beyond `.env` is needed. Re-running `pnpm dogfood:load`
against a database it already loaded is a no-op, including one loaded before evidence storage keys
became organization-scoped that day: the loader replays what it recorded under the old key. Only
when the database holds acts a different loader made does it stop, printing
`DATABASE_URL="$DATABASE_OWNER_URL" pnpm db:reset && pnpm dogfood:load -- --source-dir <dir>`.

- API — <http://localhost:4000/health> and `/ready`
- Web — <http://localhost:3000>
- Document library — <http://localhost:3000/documents>
- MinIO console — <http://localhost:9001>
- Keycloak — <http://localhost:8080>

The loader refuses to run on a provisioned host (one where `/etc/kf` exists). It creates the
`kf_api_dev` login — a member of `kf_app` and, because the development API attests in-process,
of `kf_attestor`, which is why no `dogfood` API accepts it — with a fresh random password on every run (sent to PostgreSQL as a SCRAM verifier, so it never
appears in the server's DDL log), writes that login's
connection string owner-only (0600) to `$XDG_STATE_HOME/knowledge-fabric/dev-database-url`
(default `~/.local/state/…`; override with `KF_DEV_DATABASE_URL_FILE`), and never prints the
password. It also creates a visibly synthetic local operator,
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

Compose starts Keycloak with `--import-realm` over `deploy/keycloak/`, so the
`knowledge-fabric` realm from
[`knowledge-fabric-realm.json`](../../deploy/keycloak/knowledge-fabric-realm.json) exists on
first start: the public `knowledge-fabric-web` client (authorization code, PKCE S256, redirect
URI `http://localhost:3000/auth/callback`), the bearer-only `knowledge-fabric-api` audience, and the
realm's token lifetime and login policy. What it deliberately does not ship is a user — an export
carrying users would commit credentials. Before selecting `dogfood`:

1. Create a user with `scripts/deploy/create-dev-user.sh`, which prints the token `sub`.
2. Confirm access tokens carry an `iss` that exactly matches `OIDC_ISSUER` and an `aud` that
   contains `OIDC_AUDIENCE`, and that the JWKS endpoint at `OIDC_JWKS_URI` is reachable
   ([`identity-and-login.md`](identity-and-login.md) records that walk).
3. Record the `org.external_identity` link from that `sub` to a person, plus the live role
   assignment the request will name, with `pnpm kf:grant-authority` (owner connection). Nothing is
   auto-provisioned. The assignment ends within a year (`--valid-to`, one year by default; ADR
   0036), and `--renew` renews it.

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

Since migration `20260924001000` a `dogfood` API binds a person only on an attestation from a
separate `kf-attestor` process, reached over a Unix socket. The API refuses to start without
`KF_ATTESTOR_SOCKET` or through a login that holds `kf_attestor`; the attestor refuses a login that
holds `kf_app` or `kf_worker`. So the dogfood profile needs logins the development one does not:

| Login               | Holds                            | Used by                             | Written (0600) to                                   |
| ------------------- | -------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `kf_api_dev`        | `kf_app` and `kf_attestor`       | the **development** API (unchanged) | `$XDG_STATE_HOME/knowledge-fabric/dev-database-url` |
| `kf_api_dogfood`    | `kf_app` only                    | the **dogfood** API                 | `…/knowledge-fabric/dogfood-api-database-url`       |
| `kf_attestor_dev`   | `kf_attestor` only               | `kf-attestor`                       | `…/knowledge-fabric/attestor-database-url`          |
| `kf_worker_dogfood` | `kf_worker`, CREATE/TEMP on `kf` | the worker beside a dogfood API     | `…/knowledge-fabric/worker-database-url`            |

The worker login is the newest (2026-09-24). Without a worker no outbox row is delivered, so
nothing a dogfood API records is indexed for search; its two database grants are the ones
[`dogfood-vm.md`](dogfood-vm.md) records for the host, because the job queue creates and migrates
its own `graphile_worker` schema on every start. Readiness declares that schema
(`20260926000200`), so a running worker no longer reads as five undeclared tables.

`kf_api_dev` stays: the development profile has no token to hand an attestor, so its API attests
in-process through that login, and `pnpm dev` is unchanged. Neither dogfood process accepts it.

Create the dogfood logins once (owner connection, like the loader; refused on a provisioned
host, without `NODE_ENV=development` set by the script, or for a non-loopback database):

```sh
pnpm dogfood:logins
```

Each run re-keys every login with fresh random passwords — never printed, and sent to PostgreSQL
as SCRAM verifiers so the plaintext never appears in its `log_statement = ddl` log — revokes any
other role one has picked up, and writes each connection string owner-only (override the paths
with `KF_DOGFOOD_API_DATABASE_URL_FILE`, `KF_ATTESTOR_DATABASE_URL_FILE` and
`KF_WORKER_DATABASE_URL_FILE`). With the dogfood
`OIDC_*` and `KF_WEB_*` values above set in `.env`, start the profile:

```sh
set -a; . ./.env; set +a
pnpm dev:dogfood
```

`pnpm dev:dogfood` builds the API and the attestor, starts `kf-attestor` first (its `dev` script
sets `NODE_ENV=development` and reads `attestor-database-url` and the socket path itself), waits
until it answers `GET /health` on the socket — `KF_ATTESTOR_SOCKET` if set, else
`$XDG_RUNTIME_DIR/kf-attestor.sock` — and only then starts the API and the web app with
`KF_DEPLOYMENT_PROFILE=dogfood`, the same socket, and the API reading `dogfood-api-database-url`.
No process is handed `DATABASE_OWNER_URL`, `DATABASE_OWNER_URL_FILE` or the development login, whatever `.env` holds. It
refuses to start, naming what is missing, when the logins were never created or an `OIDC_*` /
`KF_WEB_*` value is unset, and stops everything when any part exits or on Ctrl-C. The worker is not
started by it — this rehearsal is about identity — although `pnpm dogfood:logins` now writes its
login; `node apps/worker/dist/main.js` with `DATABASE_URL_FILE` naming `worker-database-url` runs
it, and the Véracier fixture stack below does. The attestor alone is
`pnpm --filter @kf/attestor dev`.

If the attestor stops while the API runs, bearer requests answer `503 attestor_unavailable` —
never a local fallback — and the API logs the outage once with the socket path.

This procedure is covered by `tests/deployment/dogfood-logins.test.ts` (the logins, the real
attestor started through its `dev` entry, a dogfood API passing its startup login check) and
`tests/deployment/dev-dogfood-runner.test.ts` (the order). This page said it had not been walked
end to end against a workstation Keycloak; on 2026-09-24 the Véracier fixture stack walked the same
processes and logins (not `pnpm dev:dogfood` itself) against one: 56 people signing in through the
realm's form, the attestor vouching for every request, and the web application's sign-in and
context selection driven in a browser.

The browser selects a role assignment, organization and classification ceiling after login.
The web server sends `Authorization: Bearer ...` plus that context to the API. The token
establishes who the caller is; the database, not Keycloak role claims, decides what that person
may do. `pnpm --filter @kf/web test:browser` verifies this flow against controlled OIDC and API
fixtures. It is not qualification evidence for a real Keycloak realm.

Do not share this Compose stack. Its Keycloak `start-dev` mode and database/object-store
credentials are intentionally unsuitable for a network service. A shared dogfood instance
follows the private-host contract, uses `NODE_ENV=production`, terminates TLS and supplies
secrets from owner-only files.

## A corpus-sized fixture: Véracier Industries

[`fixtures/veracier/`](../../fixtures/veracier/README.md) is a fictional industrial group — 1 004
documents from the EDiTh benchmark (Apache-2.0) in six languages, 56 people with roles, clearances
and need-to-know grants, and about seventy governed records — loaded through the real paths:
`kf bootstrap-organization` and `kf grant-authority` for the bootstrap tier, then every act as a
request to the API by the person who performs it. It brings its own stack in the dogfood profile
(PostgreSQL, MinIO and Keycloak under the compose project `kf-veracier`, plus kf-attestor, the
API, the worker and the web application on ports 4100 and 3100), so it runs beside the default
stack without touching it:

```sh
fixtures/veracier/stack/stack.sh up     # dependencies, migrations, logins, build, applications
fixtures/veracier/stack/stack.sh load   # the fixture (`load --sample` for 80 documents)
fixtures/veracier/stack/stack.sh down   # stop; `reset` deletes the fixture's volumes and state
```

Sign in at <http://localhost:3100>; the personas' passwords are in one owner-only file,
`~/.config/kf/veracier-personas.txt`. Loading twice is a no-op. The corpus itself is not in the
repository; the fixture's README says where it is expected and what is committed.

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
pnpm typecheck      # tsc --build across every project, then Next's own tsc
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

**`@types/node` is a per-package dependency.** Each package that touches Node APIs declares
it. That is `.npmrc`'s isolated layout working as intended: a package may import
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
