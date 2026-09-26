# Redwood Inference — the EnterpriseRAG-Bench fixture

A fictional AI-inference company's internal knowledge — Slack, mail, tickets, CRM, meeting
transcripts, wikis, pull requests, shared drives — loaded into KF as its own organization,
**Redwood Inference, Inc.**, with the company's 167 people, their roles and clearances, and
need-to-know grants. Nothing in it is real.

## Source and licence

**EnterpriseRAG-Bench** (Onyx / DanswerAI, Inc., 2026), <https://huggingface.co/datasets/onyx-dot-app/EnterpriseRAG-Bench>
(dataset revision `69916e31`), generator and scaffolding at
<https://github.com/onyx-dot-app/EnterpriseRAG-Bench> (commit `d36685e2`), released under the **MIT
License** — reproduced in [`LICENSE-DATA`](LICENSE-DATA); the repository `NOTICE` carries the
attribution. The corpus (1.4 GB parquet, 511 962 documents) lives outside the repository, default
`/mnt/4tb/data/enterprise-rag-bench` (`KF_ERB_CORPUS`). Committed here: the tooling, the overlay,
and a small sample (`sample/`: 81 documents and 19 questions, the corpus's own bytes).

```sh
hf download onyx-dot-app/EnterpriseRAG-Bench --repo-type dataset --local-dir $KF_ERB_CORPUS/hf
git clone https://github.com/onyx-dot-app/EnterpriseRAG-Bench $KF_ERB_CORPUS/repo   # uuid_index + directory
python3 fixtures/enterprise-rag-bench/extract.py            # the selection (below), ~15 s, 2 GB RSS peak
node fixtures/enterprise-rag-bench/generate-overlay.mjs      # overlay/ and sample/ (--check compares)
```

## What is loaded

**The selection** (`extract.py`, deterministic): every document any of the 500 questions expects
(722), plus the documents with the smallest `sha256("kf-erb-2026-09:" + doc_id)` until 50 000 — a
uniform random sample reproducible from the ids alone. One `doc_id` occurs twice in the corpus
with different content (two versions of a ticket); both are kept, the second as `<doc_id>~2`, and
both answer to the `doc_id`. 50 001 documents:

| source       |  documents | classification (documents)                                         |
| ------------ | ---------: | ------------------------------------------------------------------ |
| slack        |     27 792 | internal 25 260, confidential 2 532                                |
| gmail        |     11 612 | confidential 8 254, restricted 3 358                               |
| linear       |      3 518 | internal 3 438, confidential 80                                    |
| google_drive |      2 408 | internal 2 008, confidential 352, restricted 48                    |
| hubspot      |      1 428 | confidential 1 428                                                 |
| fireflies    |      1 020 | confidential 951, internal 67, restricted 2                        |
| github       |        849 | internal 742, public 107                                           |
| confluence   |        697 | internal 517, confidential 138, public 42                          |
| jira         |        677 | confidential 447, internal 230                                     |
| **all**      | **50 001** | internal 32 262, confidential 14 182, restricted 3 408, public 149 |

and 35 762 need-to-know grants (`overlay/stats.json`). Loaded on the workstation (2026-09-25):
49 973 documents and 35 744 grants; KF's content rules refused 25 (Slack and mail with numbers
shaped like US social-security numbers, rule `us-ssn` — counted, not failures), and 3 Slack
threads containing NUL characters fail with a 500 (the parse preimage is not valid JSON for
PostgreSQL; since fixed — each NUL is replaced by U+FFFD and recorded as a
`nul_character_replaced` conversion loss, so `--resume` loads them). About 1 h 45 min at `--jobs 6` on a loaded box; `--resume` ingests only what the ids
file does not yet record. `--full` loads every document
(`extract.py --full` first, which writes `manifest-full.jsonl`); it has not been run.

Each document is one artifact (`text/markdown`, the corpus's content byte for byte; Slack and mail
as `message_snapshot`, GitHub as `source_code`), titled with its own title and source
("Runbook: … — Confluence"), ingested by the IT systems administrator as herself.

## People

The generator's employee directory (`generated_data/employee_directory.yaml`, 167 people in 15
departments; it has no CEO). Role, clearance and organization-wide ceiling by title and department
(`authorityOf` in `overlay-source.mjs`):

| tier       | titles                                | clearance                                                                                                                         | reads organization-wide                                         |
| ---------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| leadership | Chief …, VP …, General Counsel (16)   | restricted                                                                                                                        | restricted (C-level, People, Finance, Legal); else confidential |
| managers   | Director, Head of, Manager, Lead (47) | confidential (restricted in People, Finance, Legal)                                                                               | confidential                                                    |
| staff      | everyone else (104)                   | confidential in Sales, Customer Success, Solutions, Security, Marketing; restricted in People, Finance, Legal; internal otherwise | internal                                                        |

The IT systems administrator is `system_administrator`, restricted/restricted: she ingests and
grants. The CTO founds the organization (hers is the founding grant). Every assignment ends within
a year (`kf grant-authority`'s default). Passwords: **one 0600 file,
`~/.config/kf/enterprise-rag-bench-personas.txt`**, never printed; Keycloak usernames are
`rw.<first>.<last>`, e-mails `@redwood-inference.example`.

| persona          | username           | who                                         | clearance / ceiling     |
| ---------------- | ------------------ | ------------------------------------------- | ----------------------- |
| CTO              | `rw.ava.chen`      | Ava Chen, Chief Technology Officer          | restricted / restricted |
| CFO              | `rw.laura.bennett` | Laura Bennett, Chief Financial Officer      | restricted / restricted |
| records          | `rw.natalie.chen`  | Natalie Chen, IT Systems Administrator      | restricted / restricted |
| VP People        | `rw.kimberly.park` | Kimberly Park, VP People                    | restricted / restricted |
| HR partner       | `rw.aly.nguyen`    | Aly Nguyen, HR Business Partner             | restricted / internal   |
| account exec     | `rw.avery.johnson` | Avery Johnson, Enterprise Account Executive | confidential / internal |
| support engineer | `rw.owen.phillips` | Owen Phillips, Senior Support Engineer      | confidential / internal |
| kernel engineer  | `rw.grace.kim`     | Grace Kim, Staff Software Engineer          | internal / internal     |

## Classification and need-to-know

By the document's path in the generator's source tree (`uuid_index.json`: the Slack channel, the
mailbox, the drive, the Confluence space …). First match wins (`CLASSIFICATION_RULES`):

| path                                                                                                                             | classification | why                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------- |
| `google_drive/shared_drives/people-ops/`, `…/finance-and-legal/`, `fireflies/interviews/`                                        | restricted     | personnel files, finance and legal, interviews |
| `gmail/<owner>/` where the owner is C-level, VP, or in People, Finance or Legal                                                  | restricted     | leadership mailboxes                           |
| `gmail/` (every other mailbox)                                                                                                   | confidential   | mail is correspondence                         |
| `hubspot/`; `fireflies/sales-calls/`, `customer-success/`, `partners/`; `jira/customer-support/`                                 | confidential   | deals, customers, customer data                |
| `slack/finance/`, `slack/people-ops/`, `slack/eng-security/`                                                                     | confidential   | finance, HR and security channels              |
| `confluence/finance-and-legal/`, `people-ops/`, `security-and-compliance/`, `sales-enablement/`, `customer-success-and-support/` | confidential   | those spaces                                   |
| `google_drive/shared_drives/go-to-market/`, `customer-success/`, `security-and-compliance/`; `linear/business-ops/`              | confidential   | those drives and projects                      |
| `github/redwood-{docs,examples,quickstarts,sdk-*,openai-compat,helm-charts,terraform}/`; `confluence/product-docs/`              | public         | open-source repositories, published docs       |
| anything else (engineering Slack, Linear, Jira internal, other drives, all-hands …)                                              | internal       | engineering, product, all-company              |

Need-to-know grants (`readersOf`), each only where the document is above the person's ceiling and
within their clearance: a mail to its **mailbox owner** and to the **directory people on its
From/To/Cc**; a document in a department's folders (`DEPARTMENT_FOLDERS`: Sales → HubSpot, sales
calls, partners, enablement, go-to-market; Customer Success → customer tickets and calls; Security
→ security channel, space and drive; Finance, People, Legal → their channels, spaces and drives) to
everyone in that department.

## Search baseline

`node fixtures/enterprise-rag-bench/search-baseline.mjs` asks all 500 questions through
`GET /search` as the CTO (who reads everything, so recall measures search, not access), scores
recall@10 against `expected_doc_ids`, per question type, and lists what the 20 "Info Not Found"
questions return. It writes [`reports/search-baseline.md`](reports/search-baseline.md). The
semantic list is scored beside the lexical one when the API runs with `KF_RETRIEVAL_SOCKET`
(the Véracier script's seam, shared in `fixtures/lib/baseline.mjs`).

## Files

| file                   | what it is                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `extract.py`           | parquet → `docs/<source>/<doc_id>.md`, `manifest.jsonl`, `questions.jsonl`, `directory.json`, streamed |
| `overlay-source.mjs`   | the decisions: people, classification rules, need-to-know                                              |
| `fixture.mjs`          | the loader's view of a manifest (selection or sample)                                                  |
| `generate-overlay.mjs` | `overlay/people.json`, `overlay/stats.json`, `sample/`; `--check` compares                             |
| `load.mjs`             | `pnpm fixture enterprise-rag-bench [--sample \| --full]`                                               |
| `search-baseline.mjs`  | the baseline above                                                                                     |
