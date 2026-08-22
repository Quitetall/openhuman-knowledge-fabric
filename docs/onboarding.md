# Onboarding — from clone to your own records

This is the shortest honest path from a fresh clone to a running Knowledge Fabric with real
documents in it. It was written by walking it on 2026-08-21, not by reading the code, and it
says where the walk stopped.

Every step below is either **verified** — it was run and its output observed — or **unverified**,
which is stated in place rather than implied by silence. An onboarding document nobody has
followed is the same failure as a test that has never failed.

If you only want to build on the code, read [`CONTRIBUTING.md`](../CONTRIBUTING.md) instead. This
document is about _using_ the thing.

---

## What this is, in one paragraph

The Knowledge Fabric is a records system with an opinion: one canonical authority per fact, no
silent edits, and identity that never changes meaning. Documents come in as files, are parsed
into addressable atoms, and are stored as versioned objects with an audit trail you can verify
independently. It is not a wiki and not a document store — it refuses writes it cannot attribute.

## What you need first

|                          |                                                 |
| ------------------------ | ----------------------------------------------- |
| Node                     | 24.18.1 (current active LTS)                    |
| pnpm                     | 11                                              |
| Docker                   | with Compose v2                                 |
| pandoc                   | the document parser shells out to it            |
| A directory of documents | `.docx` is what the loader is exercised against |

## 1. Bring up the stack — verified

```sh
pnpm install
cp .env.example .env
set -a; . ./.env; set +a
docker compose up -d          # PostgreSQL 18, MinIO, Keycloak
DATABASE_URL="$DATABASE_OWNER_URL" pnpm db:migrate
```

Confirm it worked rather than assuming — the migration count is the useful signal:

```sh
psql "$DATABASE_OWNER_URL" -c "select count(*) from public.schema_migrations;"
```

**Do not skip `cp .env.example .env`.** Sourcing a file that does not exist fails silently in
most shells, `DATABASE_URL` stays unset, and `psql` then falls back to a local Unix socket. The
error you get is `connection to server on socket "/run/postgresql/.s.PGSQL.5432" failed`, which
reads as "PostgreSQL is broken" and means "you have no environment". This is the single easiest
step to get wrong and the hardest to diagnose.

## 2. Load your documents — verified

```sh
pnpm dogfood:load -- --source-dir /path/to/your/documents
```

The loader is idempotent by construction: staging is content-addressed with conditional create,
so an unchanged rerun creates neither database duplicates nor new object-store versions. An
occupied key holding _different_ bytes fails closed rather than overwriting.

It finishes by printing a paste-ready block:

```
# Paste into .env before `pnpm dev` — the web app requires all three.
KF_DEV_ORGANIZATION=019ff405-2ec7-736e-898a-1f5687a80a48
KF_DEV_ACTOR=019ff405-2eca-7e77-96cb-00990ac6f24b
KF_DEV_ACTING_ROLE=system_administrator
```

Paste those three into `.env`. The web app calls `required()` on each and throws if any is blank.

> **All three are UUIDs.** `KF_DEV_ACTING_ROLE` is the id of an `org.role_assignment` row — the
> assignment granting the role, not the role's name. An earlier version of this document claimed
> it was a name like `system_administrator`; that was my error, corrected on 2026-08-22 after
> the loader printed a UUID there and contradicted me.
>
> The real defect here was the other one: the loader printed **nothing at all** until 2026-08-21,
> so the "copy them in" instruction had never once been followed. It prints them now.

If you are recovering an older database whose loader predates the print, the same values are:

```sh
psql "$DATABASE_OWNER_URL" -tAc "select id from core.object where object_type='organization' limit 1;"
psql "$DATABASE_OWNER_URL" -tAc "select id from core.object where object_type='person' limit 1;"
psql "$DATABASE_OWNER_URL" -tAc "select role_id from org.role_assignment;"   # pick one
```

## 3. Run it — NOT VERIFIED on the machine this was written on

```sh
pnpm dev                      # api :4000, web :3000, worker
```

Then open <http://localhost:3000/documents>.

**This step was not observed working.** On the authoring machine all three apps died at startup
with `ENOSPC: System limit for number of file watchers reached`. That was _not_ a Knowledge
Fabric requirement and not a low limit — `fs.inotify.max_user_watches` was already 524288, the
usual raised value. A single unrelated desktop application held **522,885 of the 524,199 watches
in use**, 99.7% of the budget, leaving nothing for `tsx watch` or `next dev`.

Steps 1 and 2 were verified on the same machine, so the substrate is known good; only the
watch-mode dev servers were blocked.

If you hit `ENOSPC`, do not raise the limit reflexively — find the consumer first:

```sh
# watches held per process, biggest first
for f in /proc/*/fd/*; do
  [ "$(readlink "$f" 2>/dev/null)" = anon_inode:inotify ] || continue
  p=${f#/proc/}; p=${p%%/*}
  printf '%s %s %s\n' "$(grep -c ^inotify /proc/$p/fdinfo/${f##*/} 2>/dev/null)" "$p" \
    "$(tr '\0' ' ' < /proc/$p/cmdline | cut -c1-60)"
done | sort -rn | head
```

`pnpm --parallel` runs api, web and worker together and **one failure kills all three**, so a
worker-only problem presents as "nothing starts". Run a single app to isolate it:

```sh
pnpm --filter @kf/api dev
```

## 4. Check your work

```sh
pnpm gate
```

This is the whole verification set, in CI's order, fail-fast — the same command CI runs, asserted
against `.github/workflows/ci.yml` by `tests/deployment/gate-parity.test.ts` so the two cannot
drift. It needs Docker: the tests start a real PostgreSQL 18 through Testcontainers rather than
mocking it.

## What you cannot do yet

Stated here so you do not go looking:

- **No enterprise identifiers are allocated on demand.** R01 R6 requires atomic sequence
  allocation and no allocator exists. 68 identifiers sit `reserved` in the quality repository.
- **No approval workflow.** Documents load as drafts. Approval, effective-state transition and
  publication are human acts performed outside the software.
- **No commissioned host.** `docs/deployment/private-host.md` describes one; nobody has built it,
  so there is no production evidence for anything here.
- **No multi-tenancy, no PHI handling, not FDA-cleared, not for clinical use.**

## Where to go next

|                            |                                                                           |
| -------------------------- | ------------------------------------------------------------------------- |
| Why it is built this way   | [`README.md`](../README.md) design laws                                   |
| Contributing, and the gate | [`CONTRIBUTING.md`](../CONTRIBUTING.md)                                   |
| Local stack detail         | [`docs/deployment/local-development.md`](deployment/local-development.md) |
| Running it for real        | [`docs/deployment/private-host.md`](deployment/private-host.md)           |
| Operating it               | [`docs/operating-model/runbook.md`](operating-model/runbook.md)           |
| Decisions and why          | [`docs/decisions/`](decisions/)                                           |
