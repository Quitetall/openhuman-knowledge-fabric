# Onboarding — from clone to your own records

This is the shortest honest path from a fresh clone to a running Knowledge Fabric with real
documents in it. It was written by walking it on 2026-08-21, not by reading the code, and it
says where the walk stopped.

Every step below is either **verified** — it was run and its output observed — or **unverified**,
which is stated in place rather than implied by silence. An onboarding document nobody has
followed is the same failure as a test that has never failed.

If you only want to build on the code, read [`CONTRIBUTING.md`](../CONTRIBUTING.md) instead. This
document is about _using_ the thing. If you are here to continue developing it, the
[roadmap](ROADMAP.md) says what is next and whose act each step is.

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
docker compose up -d          # PostgreSQL 18, SeaweedFS, Keycloak
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

## 2. Load your documents — requires an authorized clearance

```sh
pnpm dogfood:load -- --source-dir /path/to/your/documents
```

The loader uses the normal action dispatcher. The synthetic local operator and role are
bootstrapped for development, but KF does **not** auto-grant that person an
`org.person_clearance` row. An active, organization-scoped clearance must already exist before
the first action can run. Without it, the loader refuses with `dogfood identity is not ready`
before it stages document bytes or records document actions. This is intentional: a bootstrap
convenience must not become an unreviewed authority grant. Have a human authority create the
clearance through the approved authority procedure, with its action and audit evidence, before
rerunning the loader.

The loader is idempotent by construction: staging is content-addressed with conditional create,
so an unchanged rerun creates neither database duplicates nor new object-store versions. An
occupied key holding _different_ bytes fails closed rather than overwriting.

That includes a database loaded before 2026-09-23, when evidence storage keys became
organization-scoped (`document-imports/<organization>/<sha256>`). A rerun there asks the ledger
what it recorded and, when the only difference is the old unscoped key, replays that act instead
of failing with `idempotency_conflict`. If the ledger holds an act that differs in anything else,
the loader stops and prints the one command that starts the development database over:
`DATABASE_URL="$DATABASE_OWNER_URL" pnpm db:reset && pnpm dogfood:load -- --source-dir <dir>`.

It finishes by printing a paste-ready block:

```
# Paste into .env before `pnpm dev` — the web app requires all three.
KF_DEV_ORGANIZATION=019ff405-2ec7-736e-898a-1f5687a80a48
KF_DEV_ACTOR=019ff405-2eca-7e77-96cb-00990ac6f24b
KF_DEV_ACTING_ROLE=019ff405-2ecb-7e77-96cb-00990ac6f24b
DATABASE_URL_FILE=<path>
```

Paste the whole block into `.env`. The web app calls `required()` on each of the three `KF_DEV_*`
values and throws if any is blank. `DATABASE_URL_FILE` is the owner-only (0600) file holding the
`kf_api_dev` connection string — by default `~/.local/state/knowledge-fabric/dev-database-url` —
because the login gets a new password on every loader run and the password is never printed.

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
psql "$DATABASE_OWNER_URL" -tAc "select id from org.role_assignment;"   # pick one assignment id
```

If an older database has the operator and role but no clearance, confirm the blocker explicitly:

```sh
psql "$DATABASE_OWNER_URL" -c \
  "select subject_id, organization_id, max_classification, valid_from, valid_to
     from org.person_clearance;"
```

An empty result is not permission to insert a development grant from the loader. It means the
human authority step is still outstanding; the action path remains fail-closed until that record
exists.

## 3. Run it — NOT VERIFIED on the machine this was written on

```sh
pnpm dev                      # api :4000, web :3000, worker
```

Then open <http://localhost:3000/documents>.

Each app's `dev` script sets `NODE_ENV=development` itself. Since 2026-09-23 the API refuses to
start with `NODE_ENV` unset rather than assuming `development`, so a unit file that forgets it
fails at boot instead of trusting identity headers; the dev scripts say what they are so that the
refusal stays on hosts. `KF_DEPLOYMENT_PROFILE`, the database and the `KF_DEV_*` values still come
from `.env`.

**This step was not observed working.** On the authoring machine all three apps died at startup
with `ENOSPC: System limit for number of file watchers reached`. That was _not_ a Knowledge
Fabric requirement and not a low limit — `fs.inotify.max_user_watches` was already 524288, the
usual raised value. A single unrelated desktop application held **522,885 of the 524,199 watches
in use**, 99.7% of the budget, leaving nothing for `tsx watch` or `next dev`.

Steps 1 and 2 were verified on the same machine, so the substrate is known good; only the
watch-mode dev servers were blocked.

The **built** API does run. On 2026-08-27 `node apps/api/dist/server.js` was started under
`KF_DEPLOYMENT_PROFILE=dogfood` with real OIDC against the local Keycloak, served `/health`, and
verified a genuine Keycloak access token — see
[`docs/deployment/identity-and-login.md`](deployment/identity-and-login.md). So `pnpm dev` is
blocked by the watcher budget, not by anything in the application. `pnpm --filter @kf/api build`
then `NODE_ENV=development node apps/api/dist/server.js` sidesteps it entirely.

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

## 3A. Note something down — one gesture, no role, key or version

Recording that something happened is an observation (ADR 0024, ADR 0034, SAS §8A). It costs one
gesture on any of three surfaces, and all three reach the same route, `POST /capture/observation`,
which forms the one act `record_observation` through the dispatcher (KF-SAS-RQ-203):

```sh
# the command line — over the API, as you, with your own bearer token
pnpm kf note "Channel 3 noise floor 2.1 µV RMS at 250 Hz on board B" \
  --token-file ~/.config/kf/token --organization <uuid> [--tag bench] [--subject <object uuid>]
```

or the web form at <http://localhost:3000/capture>, or `curl` against the route. The request
carries the note and nothing about authority: **no acting role, no idempotency key, no row
version** (KF-SAS-RQ-200). The server forms each of them:

- **the acting assignment** is your only live assignment in the organization. If you hold several
  and did not name one (`--acting-role`, or the `x-kf-acting-role` header the web session sends),
  the answer is `422 acting_assignment_ambiguous` listing your assignments, and nothing is
  recorded. It does not guess, because a guess attributes the note to a role you did not act in;
- **the idempotency key** is the gesture id plus the note's SHA-256. A gesture id is generated
  when you send none and is returned, so a retry of the same gesture (`--gesture <id>`) replays
  the first capture instead of recording twice;
- **the target** is the observation the act creates.

What comes back is a `captured` observation, **attributed to you and audited from the first
moment**, and labelled `UNVERIFIED — nobody has checked this record` until somebody else verifies
it (SAS §48A). Capturing needs no act grant. Turning an observation into a controlled record —
`promote_observation` — does, and is a separate act by somebody who holds one (KF-SAS-RQ-202).

How fast each of these must be is ADR 0024's table; `node scripts/latency-bars.mjs` measures the
bars against a running stack and writes `generated/latency-bars.md`. A workstation's numbers are
labelled as such and are not the official ones — those come from a commissioned host.

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

- **Enterprise identifiers are allocated by one typed action, `allocate_enterprise_identifier`
  (ADR 0018, R01 R6)** — the next free sequence under the namespace the object's type
  declares, returned in the action receipt. The 68 identifiers that sit `reserved` in the
  quality repository keep their numbers: an occupied value is skipped, never reissued.
  Registry 1.0.0-draft.2 allocates `WAR` (Warrants) and `CONF` (configuration items;
  `CFG` is one edit from `CHG`, which R13 refuses) and every object type now declares a
  namespace the registry has; a deployment seeds `registry.identifier_namespace` from that
  registry, so an instance that has not re-seeded since is refused by name for the two new
  codes.
- **No chat integration.** ADR 0024 names chat as a first-class capture surface; there is none
  yet. The command line, the web form and agents through the API route are what exist.
- **No approval workflow.** Documents load as drafts. Approval, effective-state transition and
  publication are human acts performed outside the software.
- **No commissioned host.** `docs/deployment/private-host.md` describes one. One was built on
  2026-08-26 and became unreachable on 2026-08-27 — its access key lived in a session scratchpad
  that was cleared. It held no data. So there is still no production evidence for anything here,
  but the reason is now "the host was lost", not "nobody has tried"; the runbook has been walked
  once and corrected by the walking.
- **No multi-tenancy, no PHI handling, not FDA-cleared, not for clinical use.**

## Where to go next

|                            |                                                                             |
| -------------------------- | --------------------------------------------------------------------------- |
| Why it is built this way   | [`README.md`](../README.md) design laws                                     |
| Contributing, and the gate | [`CONTRIBUTING.md`](../CONTRIBUTING.md)                                     |
| Local stack detail         | [`docs/deployment/local-development.md`](deployment/local-development.md)   |
| Logging in                 | [`docs/deployment/identity-and-login.md`](deployment/identity-and-login.md) |
| Where this is all going    | [`docs/path-to-daily-use.md`](path-to-daily-use.md)                         |
| Running it for real        | [`docs/deployment/private-host.md`](deployment/private-host.md)             |
| Operating it               | [`docs/operating-model/runbook.md`](operating-model/runbook.md)             |
| Decisions and why          | [`docs/decisions/`](decisions/)                                             |
