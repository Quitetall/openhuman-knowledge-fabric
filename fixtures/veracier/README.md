# Véracier Industries — a corpus-sized fixture company

A realistic, entirely fictional company to use the Knowledge Fabric against: 1 004 real-looking
documents (contracts, NCRs, specifications, board minutes, scanned certificates, six languages)
from the **EDiTh** benchmark, with a governed layer over them — people, roles, clearances,
need-to-know grants and records — loaded through the same paths a real institution uses.

The company is **Véracier Industries S.A.**, a €1.8 B French industrial group: seven subsidiaries
and a recently acquired one (Précis-Tec), in aerospace, defence, nuclear and rail. Nothing in it is
real. Any resemblance to a real company, person or agreement is coincidental.

## Source and licence

The documents are EDiTh — Enterprise Digital Twin Benchmark, by Adèle Guignochau and Igor Carron
(LightOn, 2026), <https://huggingface.co/datasets/lightonai/edith>, released under the **Apache
License 2.0**. The corpus (≈1.7 GB of PDFs) and the text extracted from it are **not** in this
repository; they live in a local directory (default `/mnt/4tb/data/veracier`, override with
`KF_VERACIER_CORPUS`). What is committed here is the tooling and data derived from the corpus's
index — document ids, paths, titles taken from each document's own heading — plus the overlay this
fixture adds. The repository `NOTICE` carries the attribution.

## What is here

| file                    | what it is                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `extract-text.mjs`      | text extraction: `pdftotext -layout`, and tesseract OCR (300 dpi) for scanned pages, in the document's own language(s) |
| `overlay-source.mjs`    | the decisions: entities, askers and staff, the classification rules, which departments read which folders              |
| `records.mjs`           | the governed records (projects, NCRs, requirements, …) and the documents each rests on                                 |
| `generate-overlay.mjs`  | writes `overlay/*.json` from the above plus the corpus index and text; deterministic (seeded), `--check` compares      |
| `overlay/`              | the committed overlay: `people`, `documents` (classification, readers), `records`, `sample`, `stats`                   |
| `load.mjs`              | the loader (`pnpm fixture:veracier [--sample]`)                                                                        |
| `stack/`                | the fixture's own workstation stack (`stack.sh up`, `load`, `restart`, `down`, `reset`)                                |
| `search-baseline.mjs`   | recall@10 of the benchmark's questions through KF search, as each asker; writes `reports/search-baseline.{md,json}`    |
| `context-example.mjs`   | compiles an agent context for one question as its asker, through search and `agent_context`, and checks its sources    |
| `stack/embed-server.py` | the loopback embedding server (BAAI/bge-m3) the retrieval engine embeds through                                        |

## Bring it up

```sh
pnpm install --frozen-lockfile
fixtures/veracier/stack/stack.sh up      # PostgreSQL 18, SeaweedFS, Keycloak; migrations; logins; build; apps
fixtures/veracier/stack/stack.sh load    # the whole fixture (or: load --sample), then restart the apps
```

Then open <http://localhost:3100> and sign in as one of the personas below. `stack.sh down` stops
everything and keeps the data; `stack.sh reset` deletes the fixture's volumes and state.

The stack is its own compose project (`kf-veracier`) with its own containers, volumes, ports and
state directory (`~/.local/state/kf-veracier`, 0700), so it never touches the default
`docker compose` stack or its database. Every port is on loopback:

| what                       | where                                |
| -------------------------- | ------------------------------------ |
| web application            | <http://localhost:3100>              |
| API                        | <http://127.0.0.1:4100>              |
| Keycloak                   | <http://localhost:18080>             |
| PostgreSQL, S3 (SeaweedFS) | `127.0.0.1:15432`, `127.0.0.1:19000` |

The object store is SeaweedFS (ADR 0039), the `seaweedfs` service of the repository's
`docker-compose.yml`; `up` creates its four buckets with versioning on and refuses to continue
unless each reads back `Enabled` (`deploy/object-store/init-buckets.sh`).

It runs the processes a dogfood host runs, in the **dogfood** profile, built from this checkout:
`kf-attestor` on a Unix socket, the API holding only `kf_app`, the worker holding only
`kf_worker` (it delivers the outbox, which is what indexes records for search), and the web
application as a production build. Each holds one database login from `pnpm dogfood:logins`,
re-keyed on every `up`; none is handed the owner credential. `KF_VERACIER_SKIP_BUILD=1` skips the
build.

## Semantic ranking

`stack.sh up` and `restart` also start semantic ranking unless `KF_VERACIER_SEMANTIC=0`:

- **the embedding model** — [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3), MIT licence, revision
  `5617a9f61b028005a4858fdac845db406aefb181` (`pytorch_model.bin` sha256 `b5e0ce34…6aad38`, the
  Hub's own LFS digest). Multilingual (the corpus is French, English, German, Italian, Spanish),
  symmetric (no query/passage prefixes), 1 024 dimensions, 8 192 tokens, dense output only. Chosen
  over multilingual-e5-large (MIT as well) for its 8 192-token context against e5's 512, so all but
  14 of the 1 004 extracted texts are embedded whole (measured with its tokenizer: median 2 692
  tokens, longest 9 220; the rest are truncated at 8 192), and because it needs no
  `query:`/`passage:` prefixes, which LAMU's serve embedder does not send.
  It is prepared once, into float16 safetensors with a `PROVENANCE.json` naming both digests:

  ```sh
  "$(ls -d ~/.local/share/kf-veracier/embed-env/*/bin/python | head -n 1)" -s -E \
    fixtures/veracier/stack/embed-server.py prepare \
    --source <a download of the revision above> --out ~/.local/share/kf-veracier/bge-m3-f16
  ```

  (the environment below exists once `stack.sh` has started semantic ranking; before that, any
  Python with the same packages will do for this one-off step).

  `stack/embed-server.py serve` loads that directory (≈1.8 GB of GPU memory; CPU if there is no
  GPU), binds 127.0.0.1 only and speaks the two routes LAMU's `HttpServeEmbedder` probes
  (`/health`, `/v1/embeddings`). Nothing leaves the host (KF-SAS-RQ-218).

- **the embedder's own Python environment** — never the user's site-packages, which another
  project's `pip` can break (on 2026-10-06 an OS upgrade left `boto3` without `s3transfer`, which
  broke `accelerate` and then `transformers`, and the embedder refused to start). On first use
  `stack.sh` builds a virtualenv with [uv](https://docs.astral.sh/uv/) under
  `~/.local/share/kf-veracier/embed-env/<first 16 hex of the lockfile's sha256>/` (override the
  root with `KF_VERACIER_EMBED_ENV_ROOT`), from a uv-managed CPython 3.14.6 (not the OS's, which an
  upgrade replaces) and `stack/embed-requirements.txt` installed with `--require-hashes`, and runs
  the server as `python -s -E`, so neither user site-packages nor `PYTHON*` variables reach it.
  The build is locked (two stacks starting together build it once) and used only once marked
  complete. A changed lockfile is a new directory; the old one can be deleted. The direct pins,
  in `stack/embed-requirements.in`:

  | package      | version                                       |
  | ------------ | --------------------------------------------- |
  | torch        | 2.11.0+cu130 (CUDA 13.0 wheel; CPU if no GPU) |
  | transformers | 5.5.3                                         |
  | safetensors  | 0.7.0                                         |
  | tokenizers   | 0.22.2                                        |

  Everything they pull in (numpy, huggingface-hub, the NVIDIA runtime wheels, …) is pinned with
  its sha256 in `stack/embed-requirements.txt`; the command that regenerates it is in the `.in`.

- **the retrieval engine** — LAMU's `lamu kf-retrieval serve` (LAMU-WAR-0016), from
  `KF_VERACIER_LAMU_BIN` (default `~/.local/libexec/kf-veracier/lamu`, else `lamu` on PATH), on
  `$state/run/retrieval.sock` (0600; the API and worker run as the same account). Its at-rest key
  is made by `lamu kf-retrieval keygen` into `$state/retrieval/kf-index.key` (0600, never argv or
  env), its encrypted store is `$state/retrieval/store`, and its embedder identity is pinned on
  first start into `$state/retrieval/embedder-pin` (`BAAI/bge-m3@5617a9f61b02`).

The API and the worker are started with `KF_RETRIEVAL_SOCKET`; the worker embeds each record it
indexes through the engine's vectors-only write. If the embedder or the engine does not come up,
the applications start without it and search is lexical, saying so in every answer's `withheld`.

Records indexed while no engine was attached were never embedded. `stack.sh reindex` (the
loader's `--reindex`) rebuilds the search index and queues every indexed record for embedding
through `retrieval.enqueue_embedding`, on the worker's own login; the worker's pump then embeds
them. `lamu kf-retrieval audit --store $state/retrieval/store --key-file
$state/retrieval/kf-index.key --needle-stdin` (engine stopped) checks that a sentence from the
corpus is not in the decrypted store.

## Context compilation

`node fixtures/veracier/context-example.mjs --question QUAL-01 --compare youssef.amrani` compiles
an agent context for a question as its asker — the semantic list of `GET /search`, the person's
`agent_context` projection, each source's text through `GET /documents/:id/source` — under a
token budget, then checks that every source is a member of that projection and a document the
overlay says the person may read, and lists what the second person's package lacks. The package
(with text) goes to `$state/context-examples/`, 0600; stdout carries ids, titles and digests.

## Context source for LAMU

LAMU's `KfSource` (`lamu-api/src/context_kf.rs`) reads KF through three routes on the API, each on
a direct loopback connection only, each identifying the caller from the bearer token through
kf-attestor and deciding from live rows (`apps/api/src/routes/context-source.ts`). A SourceRef is
`{adapter: "knowledge-fabric", record, revision, digest}`: `revision` is the record's
master-record member digest, `digest` the SHA-256 of the exact text `read` returns.

| route                           | body             | answers                                  |
| ------------------------------- | ---------------- | ---------------------------------------- |
| `POST /context-source/retrieve` | `{query, limit}` | `{references: [SourceRef]}`              |
| `POST /context-source/read`     | SourceRef        | `kf.context-source-record/v1` (the text) |
| `POST /context-source/revision` | SourceRef        | `{revision, digest}` — no text           |

**`revision` is for the recheck (PERF-09).** It takes the decision `read` takes — readable now, at
this revision and text digest, in the caller's latest master record at this revision — and answers
with the same status, the same body and the same `KF-CTX-*` rule for every refusal: 404 KF-CTX-001
(one byte-identical body for absent, foreign, above the ceiling or never granted), 403 KF-CTX-002
(no longer readable, and one of the caller's own master records included it), 409 KF-CTX-003
(revision or text moved), 409 KF-CTX-004/005 (the master record is stale, or there is none), 503
KF-CTX-007 (text over the read bound). On 200 it answers `{revision, digest}`, equal to the
SourceRef it was asked about. Each call is recorded in `search.context_disclosure` as operation
`revision`, with the record, revision and text digest and no text. It reads no bytes from the
store, so a source whose bytes are not UTF-8 (or whose record would exceed the 2 MiB response
bound) passes `revision` and is refused KF-CTX-007 by `read`. For LAMU: `recheck` can call
`revision` and compare the answer with the SourceRef instead of reading the text, keeping `read`
for `read_exact`; a mismatch there is `RevisionMismatch`, as any 409 is.

**Facts (`kf.context-facts/v2`).** A record whose source is not text is read as its canonical
facts: title, type, classification, lifecycle state, enterprise id and times; its own typed rows;
and each file version's number, label, media type, size, SHA-256 and time. Its access grants and
their reasons, the rows of other records that reference it, and bookkeeping (who wrote each row,
row and schema versions, storage keys) are not served. The revision still covers the grants, so a
grant change moves the revision without moving the text: a SourceRef taken before it is 409
KF-CTX-003, and a fresh retrieve (after `POST /master-record/compile` if the claim is stale) gives
the new revision with the same digest.

**Refusals before binding.** A retrieve, read, revision check or `GET /search` that kf-attestor
refuses after verifying the token — `classification_not_granted`, `undeclared_agent`,
`role_not_held`, `revoked_identity`, `assignment_ambiguous`, `no_live_assignment` — is recorded by
the attestor in `search.identification_refusal`, but only when the token's subject is linked to a
person who belongs to the organization named (theirs by `org.person.organization`, or through a role
assignment scoped to it or its records; 20260927000100, enforced in the database seam). The row
holds the organization, the surface, the failure, the agent client the token named, the rank of the
classification asked for, and the asker as that person's recorded-query pseudonym. No token and no
person column; 90 days, swept. A subject linked to nobody (`unknown_subject`), a person naming
another organization, and token defects write nothing: the attestor's log line, with
`recorded: false` where recording was attempted, is the only trace.

## Personas

Every person in the overlay has a Keycloak account. Their passwords are generated once into **one
owner-only file**, `~/.config/kf/veracier-personas.txt` (0600; username, password, name and title,
tab-separated). They are never printed. The accounts skip the realm's TOTP enrolment, as
`scripts/deploy/create-dev-user.sh` does for the development account, and only on a loopback
Keycloak.

| persona                     | username           | who                                                       | clearance    | reads organization-wide                            |
| --------------------------- | ------------------ | --------------------------------------------------------- | ------------ | -------------------------------------------------- |
| CEO                         | `helene.daubrac`   | Hélène Daubrac, Présidente-directrice générale            | restricted   | everything                                         |
| CFO                         | `antoine.morel`    | Antoine Morel, Directeur financier Groupe                 | restricted   | everything                                         |
| CISO                        | `marc.lefevre`     | Marc Lefèvre, CISO                                        | restricted   | up to confidential, plus security records by grant |
| Quality Director            | `karim.hadj.ali`   | Karim Hadj-Ali, Directeur qualité Groupe                  | confidential | up to confidential                                 |
| Toulouse aero engineer      | `mathieu.roux`     | Mathieu Roux, Ingénieur méthodes AV-3000, Véracier Aero   | internal     | public only, plus Aero engineering by grant        |
| Casablanca plant supervisor | `youssef.amrani`   | Youssef Amrani, Chef d'atelier câblage, Véracier Maroc    | internal     | public only, plus Maroc production by grant        |
| Sales representative        | `claire.fontaine`  | Claire Fontaine, Ingénieure commerciale aéronautique      | confidential | public only, plus customer files by grant          |
| Records Office              | `elodie.marchetti` | Élodie Marchetti, Records Office Groupe (ingests, grants) | restricted   | everything                                         |

The other 48 people — the benchmark's executive askers and a spread of staff per subsidiary — are
in `overlay/people.json` and the same password file.

## How the company is modelled

**One KF organization, the group.** An organization is KF's authority boundary, and a person holds
authority in exactly one; the group's executives read across subsidiaries, so the group is one
organization. The subsidiaries are not KF organizations. They are expressed the way KF expresses
need-to-know: grants.

**Two kinds of reader.** Group functions hold a role whose organization-wide read is capped at their
clearance (or, for the CISO and the CTO, one level below it). Everyone in a subsidiary holds a role
capped at `public`: they read what the group publishes to all of it, and their own subsidiary's
documents only through `grant_access` acts the Records Office records, by department and folder
(`DEPARTMENT_FOLDERS` in `overlay-source.mjs`), never above their clearance. Each benchmark asker is
also granted the documents of their own question. So the Casablanca plant supervisor reads Maroc's
production and quality files and not Défense's restricted engineering; only executives read board
minutes and the group's finance files. Every role assignment ends within a year (`kf
grant-authority`'s default).

**Classification by folder.** First match wins (entity-specific rules first); the catch-all is
`internal`:

| folder                                                                  | entity           | classification | why                                                        |
| ----------------------------------------------------------------------- | ---------------- | -------------- | ---------------------------------------------------------- |
| `securite/`                                                             | all              | restricted     | security programme, incidents, NIS2                        |
| `export/`                                                               | all              | restricted     | export control, licences, sanctions                        |
| `gouvernance/`                                                          | all              | restricted     | board and general-meeting minutes                          |
| `technique/`                                                            | veracier_defense | restricted     | defence programme engineering                              |
| `def_01/`                                                               | all              | restricted     | DRSD security-clearance audit (DEF-01)                     |
| `def_02/`                                                               | all              | restricted     | SCORPION programme evidence (DEF-02)                       |
| `uk_02/`                                                                | all              | restricted     | MOD / DEFCON review (UK-02)                                |
| `us_01/`                                                                | all              | restricted     | ITAR / DDTC compliance (US-01)                             |
| `contrats/`                                                             | all              | confidential   | contracts                                                  |
| `juridique/`                                                            | all              | confidential   | litigation, provisions, deadlines                          |
| `finance/`                                                              | all              | confidential   | closing, consolidation, IFRS                               |
| `fiscal/`                                                               | all              | confidential   | tax and transfer pricing                                   |
| `rh/`                                                                   | all              | confidential   | HR policy, works council, inventory                        |
| `production/rh/`                                                        | all              | confidential   | site staffing plans                                        |
| `production/investissement/`                                            | all              | confidential   | capex plans                                                |
| `rgpd/`                                                                 | all              | confidential   | personal-data processing                                   |
| `assurance/`                                                            | all              | confidential   | insurance programme                                        |
| `propriete_intellectuelle/`                                             | all              | confidential   | patents, licences                                          |
| `correspondance/emails/`                                                | all              | confidential   | management email                                           |
| `rapport/`                                                              | all              | confidential   | acquisition integration report                             |
| `rapports/budget/`                                                      | all              | confidential   | budget                                                     |
| `aero_02/`, `enrg_02/`, `gmbh_02/`, `maroc_02/`, `comp_01/`, `comp_02/` | all              | confidential   | the commercial, tax, customs and compliance question files |
| `certificats/etalonnage/`, `certificats/matiere/`                       | all              | internal       | calibration and material certificates                      |
| `certificats/`                                                          | all              | public         | ISO / B-Corp certificates                                  |
| `rapports_annuels/`, `communication/`, `marketing/`                     | all              | public         | published reports, newsletter, brochures                   |
| anything else                                                           | all              | internal       | engineering, quality, production, operations               |

`overlay/stats.json` has the counts: 32 public, 325 internal, 459 confidential, 188 restricted.

**Records.** 69 acts, each by the person who would perform it (`records.mjs`): four product systems,
three configuration items and a baseline; eight AV-3000 requirements and seven acceptance tests of
lot 2024-0312, each test naming its report as result; ten nonconformities and three CAPAs from the
NCR and CAPA documents (their numbers, lots and measurements are the corpus's own); five suppliers
and their supply engagements, each naming its signed contract; five risks; four projects with work
packages; three controlled documents whose content is a policy's extracted text; decisions (one
accepted by the CEO); and four observations people noticed on the shop floor or after a call.
Every record that rests on documents is linked to them by an observation from its author whose
subjects are the record and each source PDF (`concerns` edges): KF has no act that draws an
`evidences` edge between an existing record and an existing file.

**Documents and their text.** Each PDF is ingested (`POST /ingest`) by the Records Office as
itself; its extracted text follows as a second artifact that names the PDF through `derived_from`,
and it is that text KF parses, indexes and shows. The PDF stays the record: the object page offers
it to open and download.

## Loading, and loading again

`pnpm fixture:veracier` (or `stack.sh load`) runs, in order: the bootstrap tier on the owner
credential through the real CLI (`kf bootstrap-organization` for the organization, its people and
the counterparties; `kf grant-authority` for each person's identity link, role and clearance,
granted by the CEO, whose own is the founding grant); the Keycloak accounts; then everything else
as a request to the running API **by the person who performs it**, signed in through the realm's
own login form (authorization code with PKCE): ingest, grants, records, observations.

A second run is a **no-op**: every act carries a deterministic idempotency key and replays, and the
summary says `nothing new: this database already held the fixture`. `--sample` loads 80 documents —
every entity, top-level folder kind, format and classification, and every document a record rests
on — which is what `tests/deployment/veracier-fixture.test.ts` runs against a live stack
(`KF_VERACIER_LIVE=1`).

## Text extraction

```sh
TESSDATA_PREFIX=/mnt/4tb/data/tessdata node fixtures/veracier/extract-text.mjs --jobs 6
```

Writes `<corpus>/text/<entity>/<path>.txt`, a JSON sidecar per document (method, pages OCR'd,
languages, digests) and `text/manifest.json`. Deterministic (single-threaded tesseract, fixed
flags) and resumable (a document whose PDF digest and extractor version match is skipped). A page
of a "searchable" or "mixed" PDF with fewer than 40 visible characters in its text layer is OCR'd.

Measured on the full corpus: 740 documents from the text layer, 179 fully OCR'd, 85 mixed (1 416
pages OCR'd in all), no failures. Thinnest: one scanned purchase order at 184 characters.

## Search baseline

`node fixtures/veracier/search-baseline.mjs` asks each of the benchmark's questions through
`GET /search` as its asker and writes `reports/search-baseline.md`: recall@10 of the lexical list,
the semantic list, and the fused list the API serves first and the web application shows first,
for the question as written and as `or`'d content words, beside the numbers of the run before
(`reports/search-baseline.2026-09-25.json`).

## Known gaps

- KF's ontology has no customer engagement kind (`contractor`, `supplier`, `employee`,
  `research_collaboration`, `laboratory_service`); only the supplier contracts are engagements.
- KF holds no declared language for a document, so the lexical index detects it from the text's
  function words (`search.detect_languages`); MASTER_INDEX's `language` column is used only to
  measure that detection, not to set it.
- The bootstrap tier (`kf bootstrap-organization`, `kf grant-authority`) writes people and role
  assignments without an outbox row, so the worker never indexes them and readiness reports them
  as unfindable. The loader ends by indexing exactly those objects (`search.index_object`) on the
  worker's login (a whole rebuild would do too; `stack.sh reindex` runs one in batches).
- The first visit to a record's object page answers `master_record_stale` and the page refreshes
  the person's master record itself; each refresh is recorded as that person's act.
