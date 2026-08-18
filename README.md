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
> **Operational for local development and draft dogfood; not an authoritative service.**
> Gates 1–8 are implemented and exercised by the test suite. `development` may explicitly
> enable a fixed non-authoritative identity; `dogfood` refuses that path and requires verified
> OIDC identity plus database-backed role assignment. Automated browser proof uses a controlled
> OIDC fixture. Real identity-provider, TLS, key-custody, external-storage and alerting
> commissioning still require operator evidence. First dogfood corpus remains draft-only: no
> approval, effective-state transition or enterprise identifier is fabricated.
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
`dogfood/document-constitution.json`; rerunning the loader replays semantic action receipts or
reuses only migration-allowlisted, audit-bound materializations created before that replay
contract. Pinned object versions and parsed source records are reverified. Content-addressed
staging uses conditional create, so an unchanged rerun creates neither database duplicates nor
new object-store versions; an occupied key with different bytes fails closed.

Verification, all of which must pass from a clean checkout:

```sh
pnpm gate
```

That is the whole set, in CI's order, fail-fast. It is what three of the four CI jobs run
between them — the fourth, `secrets`, is a gitleaks scan over full history that cannot run
locally on every machine — and `tests/deployment/gate-parity.test.ts` asserts the two agree in
both directions, so a step added to `.github/workflows/ci.yml` and not to `gate` fails the suite
rather than waiting to fail on somebody's push.

**CI passed for the first time on 2026-08-18**, run `32146924053` at commit `93e5b6c4`, all four
jobs green in 6.8 minutes. This paragraph previously read "nothing in CI has ever actually run",
which was true when written: all 38 runs to that point had failed at job-start on GitHub Actions
billing. Billing was restored and the first real runs found five host requirements the runner did
not satisfy — bubblewrap, unprivileged user namespaces, a PostgreSQL 18 client, `/usr/bin/node`
and pandoc — four of them named in `docs/deployment/private-host.md` and never checked against a
machine, and the fifth written down nowhere at all.

That is the useful part, so it is stated plainly rather than tidied away: `pnpm gate` was green on
this workstation the entire time, and it was green because of what happened to be installed here.
`docs/decisions/0004-production-release.md` criterion 5 still requires a green run on the TAGGED
commit, which has not happened. Run the pieces individually while iterating:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm ontology:check                        # ontology internally consistent
pnpm ontology:build && git diff --exit-code -- generated/   # and the committed output is current
pnpm test                                  # includes a real PostgreSQL 18 via Testcontainers
pnpm build
```

`ontology:check` compares in memory; the regenerate-and-diff is a separate step because only a
real write proves the emitters are deterministic.

Requires Node 24.18.1 (current active LTS), pnpm 11, Docker with Compose v2.

## Where things live

| Path                        | Contents                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ontology/`                 | **Canonical** organizational semantics — object, relation, action, state, rule definitions                                |
| `generated/`                | Compiler output. Never hand-edited; `pnpm gate` fails on drift (CI would too — see above)                                 |
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

[Business Source License 1.1](LICENSE). Licensor **OpenHuman Technologies LLC**; Change Date
**2030-08-17**, on which this version converts to the **Apache License, Version 2.0**.

**BUSL-1.1 is not an open-source licence, and this project is not open source until the Change
Date.** It is not OSI-approved and does not meet the Open Source Definition, because it
restricts one field of use. Saying otherwise before 2030-08-17 would be exactly the kind of
true-sounding overclaim the rest of this repository exists to prevent, so it is said plainly
here instead: source-available now, open source on the Change Date.

What you may do without buying anything, in the licence's own words rather than a paraphrase —
read [`LICENSE`](LICENSE) for the text that governs:

|                                                                 |                                              |
| --------------------------------------------------------------- | -------------------------------------------- |
| Read, modify, fork, redistribute, and use non-production        | Granted by BUSL itself                       |
| Run it in production to keep **your own institution's** records | Granted by the Additional Use Grant          |
| Offer it to third parties as a hosted or managed service        | **Not** granted — needs a commercial licence |
| Everything, under Apache-2.0                                    | From the Change Date, 2030-08-17             |

The Change Date is fixed at four years, and the licence converts on that date or four years
after this version is first published, whichever is EARLIER — so it can never be later than
four years from publication, whenever publication happens.

The Licensor is written `OpenHuman Technologies LLC`, with the `LLC`. This was briefly open —
`LICENSE` first said "OpenHuman Technologies" while this file said "OpenHuman Technologies LLC" —
and the repository turned out to have already answered it everywhere the name appears as data
rather than prose: the seeded organization in `apps/api/src/dogfood/bootstrap.ts`, the database
harness, and the R01 golden conformance fixture all carry `legal_name` "OpenHuman Technologies
LLC". Confirmed by the Licensor on 2026-08-17 and corrected in `LICENSE`. Kept here because the
next person to notice the two forms should find the answer rather than re-open the question.
