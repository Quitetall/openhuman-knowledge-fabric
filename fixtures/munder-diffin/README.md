# Munder Diffin Fixture — OpenHuman Knowledge Fabric

This directory is a **demonstration fixture** for the OpenHuman Knowledge
Fabric, a governed document/records platform. Munder Diffin Paper
Shredding Co. and every person, agreement, incident, and figure in these
documents is **entirely fictional** — no real company, real acquisition,
real incident, or real individual is described. Names were chosen to be
lightly humorous while document content reads as ordinary professional
business writing.

The fixture exercises the Knowledge Fabric's access-governance model
against a realistic mix of document sensitivity, using a small,
easy-to-reason-about company. Documents live under
`documents/<classification>/` in four classifications:

- **`public/`** — Anyone, including prospective and current customers.
- **`internal/`** — Employees and contractors: procedures, the handbook,
  custody rules, IT policy.
- **`confidential/`** — Executives, Finance, and the specific named
  partner or customer for their own agreement only (Sabre Printers sees
  its own integration spec; Vance Refrigeration sees its own service
  agreement). One customer or partner should never see another's
  confidential document.
- **`restricted/`** — Owners only (Jim Miller and Hank Shredder): board
  decisions and sensitive incident reports above normal executive access.

This tree is meant for ingestion so access policies, classification-aware
search, and per-document grants can be exercised end to end. Treat every
fact here — names, figures, dates, addresses — as synthetic test data.
