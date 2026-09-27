# Every fixture corpus in one stack — varied data, and tenant isolation

Four corpora, six organizations, one Knowledge Fabric: each fictional company is loaded as **its
own KF organization**, so the same stack is used to search very different data and to show that
one organization's people can never reach another's.

| organization             | corpus (licence)          | fixture                                                              | loaded as `--sample` | loaded in full                |
| ------------------------ | ------------------------- | -------------------------------------------------------------------- | -------------------- | ----------------------------- |
| Véracier Industries S.A. | EDiTh (Apache-2.0)        | [`fixtures/veracier`](../veracier/README.md)                         | 80 PDFs + text       | 1 004 PDFs + text, 69 records |
| Redwood Inference, Inc.  | EnterpriseRAG-Bench (MIT) | [`fixtures/enterprise-rag-bench`](../enterprise-rag-bench/README.md) | 81 documents         | 50 001 documents (selection)  |
| The Agent Company, Inc.  | TheAgentCompany (MIT)     | [`fixtures/theagentcompany`](../theagentcompany/README.md)           | 31 files             | 640 files                     |
| Lee's Market             | DRBench (Apache-2.0)      | [`fixtures/drbench`](../drbench/README.md)                           | 10 files (DR0001)    | 621 files                     |
| MediConn Solutions       | DRBench (Apache-2.0)      | 〃                                                                   | 12 files (DR0006)    | 744 files                     |
| Elexion Automotive       | DRBench (Apache-2.0)      | 〃                                                                   | 9 files (DR0011)     | 592 files                     |

The corpora live outside the repository (`/mnt/4tb/data/<corpus>`); each fixture's README says
how to fetch and extract its own. The samples of the three new corpora are committed, so
`--sample` needs no download (Véracier's needs its corpus).

## Bring it up

```sh
pnpm install --frozen-lockfile
fixtures/multi/stack.sh up                 # PostgreSQL, MinIO, Keycloak; migrations; logins; build; apps
fixtures/multi/stack.sh load --sample      # every corpus's sample, each its own organization
fixtures/multi/stack.sh load               # or: every corpus in full (hours: ERB's 50 000 documents)
```

`stack.sh load` runs `node fixtures/cli.mjs all …` and restarts the applications. One corpus:
`pnpm fixture <veracier|enterprise-rag-bench|drbench|theagentcompany> [--sample]` with the
stack's `KF_STACK_*` in the environment; `pnpm fixture list` says which corpora are on this
machine. Every load is idempotent: a second run replays every act and says `nothing new`.

The stack is the Véracier stack script (`fixtures/veracier/stack/stack.sh`) under its own compose
project and ports, so it runs beside the Véracier stack without touching it:

| what              | where                                |
| ----------------- | ------------------------------------ |
| web application   | <http://localhost:3200>              |
| API               | <http://127.0.0.1:4200>              |
| Keycloak          | <http://localhost:18180>             |
| PostgreSQL, MinIO | `127.0.0.1:15532`, `127.0.0.1:19100` |
| state             | `~/.local/state/kf-multi` (0700)     |

Any `KF_STACK_*` (`PROJECT`, `STATE`, `WEB_PORT`, `API_PORT`, `KEYCLOAK_PORT`, `PG_PORT`,
`MINIO_PORT`, `MINIO_CONSOLE_PORT`, `FIXTURE`, `ORGANIZATION`, `SKIP_BUILD`) overrides a default,
so a second, throw-away instance (for the tests below) runs beside the first.

## Personas

One 0600 file per corpus under `~/.config/kf/` — `veracier-personas.txt`,
`enterprise-rag-bench-personas.txt`, `drbench-personas.txt` (all three companies),
`theagentcompany-personas.txt` — never printed. Usernames are prefixed per organization
(`rw.`, `tac.`, `lm.`, `mc.`, `ea.`; Véracier's are bare) and every e-mail is `@<company>.example`,
so the one realm holds them all without collision (a test checks it).

The web application's context picker lists every live role assignment the signed-in person
holds, grouped by organization under its legal name (`GET /session/contexts`), so a person of
any of the organizations signs in and picks their context from the list without typing an id.
The list is the token's own person's and nobody else's: it names no organization they hold nothing
in. `KF_WEB_ORGANIZATION` (this stack names Redwood Inference) only puts that organization first.
The typed form beneath the picker — organization id, role assignment id, ceiling, from
`<state>/<corpus>-ids.json` — stays as a fallback, and the API validates it exactly as it validates
a picked one.

## Tenant isolation

`tests/deployment/multi-org-isolation.test.ts` (`KF_MULTI_LIVE=1`, against a stack holding the
samples; `KF_MULTI_LOAD=1` makes it load them itself, twice, the second a no-op) takes every
ordered pair of organizations A and B and tries every door from A into B:

- **search** — words only B's documents contain (chosen from the samples: at least nine letters,
  whose first seven occur nowhere in any other organization), as A's strongest reader and as A's
  narrowest: nothing found, and **no withheld count**; a broad search returns none of B's objects;
- **read** — B's artifacts, B's person, B's organization, by `/objects/:id`, its history and
  available actions, `/documents/:id/source`, `/projects/:id`: **404, never 403**, and exactly the
  answer an id that exists nowhere gets;
- **act** — a grant to oneself on B's artifact, an observation about it: `object_not_visible`
  (404), nothing recorded;
- **context** — A's token presented with B's organization, with B's assignment: refused; B's
  assignments are never listed to A.

Each probe is shown able to fail: B's words are found by B's own reader, and B's artifact is read
by B. `apps/web/e2e/multi-org-live.test.mjs` walks the same boundary in a real browser for one
person of every organization.
