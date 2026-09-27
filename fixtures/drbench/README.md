# Lee's Market, MediConn Solutions, Elexion Automotive — the DRBench fixture

Three fictional companies' research estates — reports, spreadsheets, decks, mail and chat —
each loaded as **its own KF organization**, with its people, their roles and clearances, and
need-to-know grants. Nothing in it is real.

## Source and licence

**DRBench** (ServiceNow, 2025), <https://huggingface.co/datasets/ServiceNow/drbench> (revision
`bc4b053f`), paper arXiv 2510.00172, released under the **Apache License 2.0**; the repository
`NOTICE` carries the attribution. The dataset (8 340 files, 79 MB) lives outside the repository,
default `/mnt/4tb/data/drbench` (`KF_DRBENCH_CORPUS`). Committed here: the tooling, the overlay,
and a sample (`sample/`: the 31 files of three tasks, originals and extracted text).

```sh
hf download ServiceNow/drbench --repo-type dataset --local-dir $KF_DRBENCH_CORPUS/hf
TESSDATA_PREFIX=/mnt/4tb/data/tessdata node fixtures/drbench/extract.mjs --jobs 6   # ~3 min
node fixtures/drbench/generate-overlay.mjs                                            # --check compares
```

## Three organizations, and why

DRBench writes each of its 100 deep-research tasks for **one** of three fictional companies
(`data/contexts/company_structures/`): Lee's Market (Asian supermarket chain, Richmond BC),
MediConn Solutions (healthcare technology, Vancouver) and Elexion Automotive (EV maker, Austin).
Each has its own profile, personas, mail domain and files, and no file or person is shared
between them. They are three companies, not one company's divisions — so each is a KF
organization, which also gives the multi-organization stack three more tenants to isolate.

## What is loaded

Every task's environment (`config/env.json`: the files, mail and chat its sandbox is seeded with),
one artifact per file, keyed `<task>-<file dir>`: 1 957 files (2 of the 1 959 the configs name are
missing from the dataset: `DR0029/files/DI0011/roundcube_email_20251119_004913.jsonl`,
`DR0038/files/DI0006/PR-engagements-overview.docx`).

| company            | files | public | internal | confidential | restricted | people |
| ------------------ | ----: | -----: | -------: | -----------: | ---------: | -----: |
| Lee's Market       |   621 |      5 |      444 |          170 |          2 |     17 |
| MediConn Solutions |   744 |      1 |      474 |          256 |         13 |     16 |
| Elexion Automotive |   592 |      0 |      439 |          150 |          3 |     12 |

By format: 572 PDF, 548 DOCX, 312 mail/chat exports (JSONL), 287 PPTX, 238 XLSX; 569 files are a
task's insights, 1 388 its distractors. 454 need-to-know grants.

**Text.** KF's parser reads DOCX itself. Each PDF (`pdftotext`), PPTX (`pandoc`) and XLSX
(LibreOffice re-save, then `pandoc`: DRBench's workbooks name their sheets `xl//xl/…`, which
pandoc's reader cannot follow) is ingested as itself and followed by its extracted text, which
names it through `derived_from` (`fixtures/lib/extract-text.mjs`). A mail or chat export is
loaded as its **rendered transcript** only: the export carries the benchmark sandbox's account
passwords (`"password": "…_pwd"`), which KF's content rules would refuse and which the renderer
leaves out. 0 extraction failures, 0 thin texts.

## People

Each company's personas (`company_structures`) and every task's asker (a task persona not in the
company file is still that company's person), 45 in all. Keycloak usernames `lm.`, `mc.`, `ea.` +
`first.last`; e-mails `@lees-market.example`, `@mediconn.example`, `@elexion.example`. Passwords:
**one 0600 file for the three, `~/.config/kf/drbench-personas.txt`**, never printed.

| seniority | role          | clearance    | reads organization-wide |
| --------- | ------------- | ------------ | ----------------------- |
| Executive | project_owner | restricted   | restricted              |
| Senior    | reviewer      | confidential | confidential            |
| Mid       | performer     | confidential | internal                |
| Junior    | performer     | internal     | internal                |

Each company's records office — founds the organization, ingests, grants — is one person of its
own roster, restricted/restricted whatever their seniority: Emily Patel (Regulatory Affairs
Manager, Lee's Market), Rachel Lee (MediConn), Amanda Lee (Elexion).

## Classification and need-to-know

By what a file is about — its name, and for mail or chat its subjects, teams and channels. First
match wins (`CLASSIFICATION_RULES`):

| words                                                                                                                                                                                                             | classification |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| salary, compensation, payroll, merger, acquisition, board, litigation, lawsuit, breach                                                                                                                            | restricted     |
| financial(s), finance, budget, revenue, cost(s), pricing, profit, forecast, contract(s), vendor(s), patient(s), hr, employee(s), workforce, retention, performance, security, audit, compliance, regulatory, risk | confidential   |
| press, newsletter, brochure, announcement, public, catalog, flyer                                                                                                                                                 | public         |
| anything else                                                                                                                                                                                                     | internal       |

Grants, each only above the person's ceiling and within their clearance: every file of a task to
the person DRBench set the task for; a mail to the company's people it is addressed to.

## Eval

`node fixtures/drbench/search-baseline.mjs`: each task's question, asked through `GET /search` by
its own persona in their own company; truth = the task's insight files; recall@10, per
difficulty. Report: [`reports/search-baseline.md`](reports/search-baseline.md).
