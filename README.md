# OpenHuman Knowledge Fabric

Institutional information platform for OpenHuman Technologies LLC. One coherent,
machine-readable view of products, projects, work packages, contractor work orders, work
execution, artifacts, decisions, configuration changes, requirements, risks, tests,
acceptance, invoices, payments, controlled documents, people and provenance — while keeping
project management, engineering configuration, contractor authorization, quality management
and finance as separate authorities linked by typed identities.

Specification: `OH-DOC-000002-1-R01` — _Knowledge Fabric Organizational Graph and Work
Control Specification_, with its `1.0.0-draft.1` schema pack.

> ## Status — read this first
>
> **Commissioned for local dogfood; not an authoritative service.**
> Gates 1–8 are closed and their controls are exercised by the test suite. The local web UI
> still uses a fixed development identity, so records created through it do not prove who
> acted. The first dogfood corpus is loaded as drafts only: no approval, effective-state
> transition or enterprise identifier is fabricated.
>
> The specification is also **not yet approved**: the schema pack is `draft_for_approval`
> and its manifest is unsigned, so under §1.2 it is not normative. Five defects found in it
> are recorded in `docs/decisions/0001-r01-schema-pack-defects.md`, with a corrected package
> available from `pnpm ontology:pack`.

---

## Build philosophy

**Architecture-complete, capability-incremental.** One permanent architecture, commissioned
in vertical slices. A gate is complete only when its exit criteria _and_ its
planted-violation tests pass.

| Gate | Scope                               | State        |
| ---- | ----------------------------------- | ------------ |
| 1    | Repository, toolchain, local stack  | **complete** |
| 2    | Ontology compiler                   | **complete** |
| 3    | PostgreSQL authority kernel         | **complete** |
| 4    | Evidence vault and preservation     | **complete** |
| 5    | Work-control vertical slice         | **complete** |
| 6    | Product configuration and quality   | **complete** |
| 7    | Search, federation, agent-safe APIs | **complete** |
| 8    | Operational hardening               | **complete** |

## Composed monolith

The Knowledge Fabric is monolithic at the product boundary: one integrated source of truth,
one web experience and one machine-readable authority surface. Its software parts are not
black-box monoliths. Small auditable atoms own narrow contracts; orchestrators compose them
into larger capabilities and reject ambiguous ownership. Each atom remains testable and
reusable outside the full application — a pragmatic fusion of composition and the Unix
philosophy.

## Getting started

```sh
pnpm install
cp .env.example .env
set -a; . ./.env; set +a
docker compose up -d      # PostgreSQL 18, MinIO, Keycloak
DATABASE_URL="$DATABASE_OWNER_URL" pnpm db:migrate
pnpm dogfood:load -- --source-dir /home/brianklam/Desktop/OpenHuman_Technologies
pnpm dev                  # api :4000, web :3000, worker
```

Open <http://localhost:3000/documents> to read parsed document atoms or add another draft.
The manifest for the initial three-document constitution is
`dogfood/document-constitution.json`; rerunning the loader replays prior actions instead of
creating duplicates.

Verification, all of which must pass from a clean checkout:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm ontology:check   # ontology consistent, generated/ current
pnpm test             # includes a real PostgreSQL 18 via Testcontainers
pnpm build
```

Requires Node 24.18.1 (current active LTS), pnpm 11, Docker with Compose v2.

## Where things live

| Path                        | Contents                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ontology/`                 | **Canonical** organizational semantics — object, relation, action, state, rule definitions                                |
| `generated/`                | Compiler output. Never hand-edited; CI fails on drift                                                                     |
| `database/`                 | Plain SQL migrations, functions, triggers, constraints, row security                                                      |
| `packages/`                 | Domain, database, actions, authorization, validation, artifacts, audit, canonicalization, export, search, integration, ui |
| `apps/`                     | `api` (Fastify) · `web` (Next.js) · `worker` (Graphile Worker) · `checkpoint` (audit signer)                              |
| `examples/atlas-enclosure/` | The reference scenario, loaded through public actions                                                                     |
| `tests/`                    | Ontology, conformance, database, permissions, financial invariants, planted violations, round-trip, audit verification    |

Each package carries an `AUTHORITY.md` stating which facts it may own. Most own none —
that is the correct and common case.

## Design laws

These are not stylistic preferences. Violating one is a defect.

1. **One canonical authority per fact.** Search indexes, embeddings, graph projections,
   analytics and AI summaries are derived and non-authoritative.
2. **PostgreSQL 18 is the constitutional kernel.** Not a graph database, document store,
   event store, triplestore, workflow engine or search engine.
3. **Object storage is the evidence vault.** PostgreSQL holds identity, digest, provenance,
   classification, retention and location; the object store holds the bytes.
4. **Git owns implementation, not operational records.** No live contractor records,
   payment records, personnel information or database exports are ever committed.
5. **Typed relational tables plus typed relationships** — never `node(id, type, json)` +
   `edge(src, predicate, tgt)`.
6. **Controlled changes occur through typed actions**, one transaction each. There is no
   generic `PATCH /work-orders/123 {status}`.
7. **No controlled fact exists only in free text.**
8. **Approved records are immutable.** Corrections are new revisions, supersessions,
   reversals or amendments — never a silent overwrite.
9. **Derived systems are disposable** and must be rebuildable from authoritative records.

## Why the durable artifact is a file, not the database

ISO 13485 §4.2.5 requires retention for at least the device lifetime as the organization
defines it. That lifetime is currently **undefined**, so retention is unbounded — records
created now must stay readable indefinitely.

No database binary format survives that horizon: a 2026 `PGDATA` will not mount on a 2045
server, and major-version migration is mandatory every few years. So the preservation export
(§14) — RFC 8785 canonical JSON with a signed manifest — is the institutional record, and
PostgreSQL is the operational engine over it. The export round-trip test is what keeps that
claim true rather than aspirational.

## Repository boundaries

GitHub cannot restrict _read_ access by path, so anything with a narrower read audience
belongs in a different repository. Fixing that later means rewriting history.

| Repository          | Read audience                      | Holds                                    |
| ------------------- | ---------------------------------- | ---------------------------------------- |
| **this repo**       | Staff                              | Fabric implementation, ontology, schemas |
| `openhuman-quality` | All staff, auditors, notified body | QMS, product files, validation records   |
| `openhuman-ip`      | Legal and named inventors          | Invention disclosures — privileged       |
| `LamQuant`          | Engineering                        | Design source, analysis code, decisions  |
| _(none)_            | —                                  | **PHI never enters any git repository.** |

Bank details, tax identifiers and payroll secrets are never stored in this system at all —
they stay in restricted HR/finance systems and are referenced, never copied.

## Licence

Proprietary and confidential — OpenHuman Technologies LLC.
