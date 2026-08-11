# Local development setup

Everything below runs from a clean checkout with no manual configuration beyond copying
`.env.example`.

## Prerequisites

| Tool    | Version                      | Why this one                                                         |
| ------- | ---------------------------- | -------------------------------------------------------------------- |
| Node.js | 24.18.1 (current active LTS) | Pinned in `package.json` `engines`, enforced by `engine-strict=true` |
| pnpm    | 11.x                         | Workspace protocol and isolated `node_modules`                       |
| Docker  | with Compose v2              | PostgreSQL 18, MinIO, Keycloak                                       |

`corepack` is not bundled on every distribution. If `pnpm` is missing:
`npm install -g pnpm@latest`.

## First run

```sh
pnpm install
cp .env.example .env
docker compose up -d
pnpm dev
```

- API — <http://localhost:4000/health> and `/ready`
- Web — <http://localhost:3000>
- MinIO console — <http://localhost:9001>
- Keycloak — <http://localhost:8080>

`pnpm dev` works with or without the database up. The worker logs that it is idle rather
than crash-looping, and `/ready` reports `503` with `database: unconfigured` rather than
claiming readiness it does not have.

## Verification

```sh
pnpm format:check   # prettier
pnpm lint           # eslint + typescript-eslint
pnpm typecheck      # tsc --build across 16 projects, then Next's own tsc
pnpm test           # vitest
pnpm build          # every package plus a real Next production build
```

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
public on purpose so a clean checkout runs without setup. They are rejected outside
development. Production secrets come from a secret manager (Gate 8), never from a file.

## Resetting

```sh
docker compose down -v    # destroys the database and object storage
```

Safe today because nothing authoritative exists yet. From Gate 5 onward this destroys
records, and the restore procedure in `docs/backup-and-restore/` applies instead.
