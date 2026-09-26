# The Agent Company — the TheAgentCompany fixture

A fictional software start-up's shared drive — HR, finance, admin, data analysis, research,
planning — loaded as its own KF organization, **The Agent Company, Inc.**, with the company's
17 people. Nothing in it is real.

## Source and licence

**TheAgentCompany** (2024), <https://github.com/TheAgentCompany/TheAgentCompany> (commit
`98b68ef8`), released under the **MIT License** — reproduced in [`LICENSE-DATA`](LICENSE-DATA); the
repository `NOTICE` carries the attribution. The drive is the benchmark's pre-baked ownCloud data.
The repository keeps only its Dockerfile; the data is in the published image
(`ghcr.io/theagentcompany/servers-owncloud`, digest `sha256:326406d8…`), and it is copied out
without running the image or the benchmark's sandbox:

```sh
docker pull ghcr.io/theagentcompany/servers-owncloud:latest
id=$(docker create ghcr.io/theagentcompany/servers-owncloud:latest)
docker cp "$id:/var/www/html/data/theagentcompany" $KF_TAC_CORPUS/owncloud-data; docker rm "$id"
git clone --depth 1 https://github.com/TheAgentCompany/TheAgentCompany $KF_TAC_CORPUS/repo-direct
TESSDATA_PREFIX=/mnt/4tb/data/tessdata node fixtures/theagentcompany/extract.mjs   # ~10 s
node fixtures/theagentcompany/generate-overlay.mjs                                  # --check compares
```

`KF_TAC_CORPUS` defaults to `/mnt/4tb/data/theagentcompany`. So the data is usable offline; no
substitute corpus was needed. Committed here: the tooling, the overlay, and a sample (`sample/`:
31 files the company itself wrote, with their extracted text). The drive also holds third-party
material — public companies' annual reports and 10-Ks, arXiv papers, ownCloud's stock templates
and photos — under their own terms; none of it is in the sample.

## What is loaded

`Documents/` of the drive: 640 files (ownCloud's stock `Photos/`, `Templates/`, `Talk/` and manual,
and a video and a zip, are left out: 42 files).

| format       | files | how KF gets its text                                                |
| ------------ | ----: | ------------------------------------------------------------------- |
| pdf          |   547 | `pdftotext` (545), OCR (2)                                          |
| xlsx         |    42 | `pandoc`                                                            |
| txt          |    15 | KF parses it                                                        |
| csv          |    12 | `pandoc` → Markdown table                                           |
| odt          |     7 | KF parses it                                                        |
| jpg/jpeg/png |     8 | OCR (`tesseract`; one AVIF named `.png`, normalized by ImageMagick) |
| md           |     4 | KF parses it                                                        |
| docx         |     4 | KF parses it                                                        |
| ods          |     1 | LibreOffice → xlsx → `pandoc`                                       |

Classification: 532 confidential (500 of them invoices), 60 internal, 26 public, 22 restricted.
Each file KF cannot parse is ingested as itself and followed by its extracted text, which names it
through `derived_from`.

**What KF refuses.** Four files are refused at ingest by KF's content rules, on every load, and
the loader counts them as `refused by content rules`, not as failures:
`Admin/TAC_personell_data.csv` (social-security numbers, rule `us-ssn`) and
`Data Analysis/Other Corp Area Totals.xlsx`, `Financials/expenses.xlsx`,
`Financials/Expenses/expenses.xlsx` (numbers that validate as payment cards, rule
`payment-card`). That is the product working; the data is fictional.

## People

The benchmark's roster (`servers/rocketchat/npc/npc_definition.json`; its AI assistant left out).
Usernames `tac.first.last`, e-mails `@the-agent-company.example`; passwords in **one 0600 file,
`~/.config/kf/theagentcompany-personas.txt`**, never printed.

| person                                | title                             | role                                        | clearance / ceiling         |
| ------------------------------------- | --------------------------------- | ------------------------------------------- | --------------------------- |
| Sarah Johnson                         | CTO (founder, migrates the drive) | project_owner                               | restricted / restricted     |
| David Wong                            | Finance Director                  | finance_approver                            | restricted / confidential   |
| Chen Xinyi                            | Human Resources Manager           | reviewer                                    | restricted / confidential   |
| Mark Johnson                          | Sales Director                    | reviewer                                    | confidential / confidential |
| Jessica Lee, Li Ming, Huang Jie       | managers                          | reviewer, work_order_manager, project_owner | confidential / internal     |
| Priya Sharma                          | Documentation Engineer            | performer                                   | internal / public           |
| 7 engineers, a researcher, a designer | …                                 | performer, design_authority                 | internal / internal         |

## Classification and need-to-know

By path under `Documents/`, first match wins:

| path                                                                                                                                                           | classification |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `Human Resources Team/`; `Financials/TAC_salary.xlsx`; `Q1 Planning and Allocation/salary_benefits_2024.xlsx`; `Admin/TAC_personell_data.csv`; `Admin/i-9.pdf` | restricted     |
| `Financials/Annual Reports/`, `Data Analysis/Annual Reports/`                                                                                                  | public         |
| `Financials/`, `Administrative Specialist/`                                                                                                                    | confidential   |
| `Research/`, `TAC_overview.md`                                                                                                                                 | public         |
| anything else                                                                                                                                                  | internal       |

Grants (above the ceiling, within the clearance): Finance → `Financials/`, `Administrative
Specialist/`, `Q1 Planning and Allocation/`; Human Resources → `Human Resources Team/` and the two
personnel files in `Admin/`; Sales → `Administrative Specialist/`. 37 grants.

## Eval

The benchmark's tasks are work, not questions. The 44 that name a drive file become retrieval
questions: the task text is the query, the files it names are the truth.
`node fixtures/theagentcompany/search-baseline.mjs` →
[`reports/search-baseline.md`](reports/search-baseline.md).
