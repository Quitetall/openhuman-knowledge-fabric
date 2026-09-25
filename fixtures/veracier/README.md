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

| file                   | what it is                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `extract-text.mjs`     | text extraction: `pdftotext -layout`, and tesseract OCR (300 dpi) for scanned pages, in the document's own language(s) |
| `overlay-source.mjs`   | the decisions: entities, askers and staff, the classification rules, which departments read which folders              |
| `records.mjs`          | the governed records (projects, NCRs, requirements, …) and the documents each rests on                                 |
| `generate-overlay.mjs` | writes `overlay/*.json` from the above plus the corpus index and text; deterministic (seeded), `--check` compares      |
| `overlay/`             | the committed overlay: `people`, `documents` (classification, readers), `records`, `sample`, `stats`                   |
| `load.mjs`             | the loader (`pnpm fixture:veracier [--sample]`)                                                                        |
| `stack/`               | the fixture's own workstation stack (`stack.sh up`, `load`, `restart`, `down`, `reset`)                                |
| `search-baseline.mjs`  | recall@10 of the benchmark's questions through KF search, as each asker; writes `reports/search-baseline.{md,json}`    |

## Bring it up

```sh
pnpm install --frozen-lockfile
fixtures/veracier/stack/stack.sh up      # PostgreSQL 18, MinIO, Keycloak; migrations; logins; build; apps
fixtures/veracier/stack/stack.sh load    # the whole fixture (or: load --sample), then restart the apps
```

Then open <http://localhost:3100> and sign in as one of the personas below. `stack.sh down` stops
everything and keeps the data; `stack.sh reset` deletes the fixture's volumes and state.

The stack is its own compose project (`kf-veracier`) with its own containers, volumes, ports and
state directory (`~/.local/state/kf-veracier`, 0700), so it never touches the default
`docker compose` stack or its database. Every port is on loopback:

| what              | where                                |
| ----------------- | ------------------------------------ |
| web application   | <http://localhost:3100>              |
| API               | <http://127.0.0.1:4100>              |
| Keycloak          | <http://localhost:18080>             |
| PostgreSQL, MinIO | `127.0.0.1:15432`, `127.0.0.1:19000` |

It runs the processes a dogfood host runs, in the **dogfood** profile, built from this checkout:
`kf-attestor` on a Unix socket, the API holding only `kf_app`, the worker holding only
`kf_worker` (it delivers the outbox, which is what indexes records for search), and the web
application as a production build. Each holds one database login from `pnpm dogfood:logins`,
re-keyed on every `up`; none is handed the owner credential. `KF_VERACIER_SKIP_BUILD=1` skips the
build.

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
`GET /search` as its asker and writes `reports/search-baseline.md`. It is lexical only; when the
API runs with a retrieval engine (`KF_RETRIEVAL_SOCKET`), the same script scores the semantic list
beside it.

## Known gaps

- KF's ontology has no customer engagement kind (`contractor`, `supplier`, `employee`,
  `research_collaboration`, `laboratory_service`); only the supplier contracts are engagements.
- The lexical index uses PostgreSQL's `english` configuration for every language, so French,
  German, Italian and Spanish words are matched unstemmed.
- The bootstrap tier (`kf bootstrap-organization`, `kf grant-authority`) writes people and role
  assignments without an outbox row, so the worker never indexes them and readiness reports them
  as unfindable. The loader ends by indexing exactly those objects (`search.index_object`) on the
  worker's login (a whole `search.rebuild()` outlasts the statement budget on a stack that also
  holds the multi-organization fixture's corpora).
- The first visit to a record's object page answers `master_record_stale` and the page refreshes
  the person's master record itself; each refresh is recorded as that person's act.
