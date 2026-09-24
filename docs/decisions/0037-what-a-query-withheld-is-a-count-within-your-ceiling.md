# ADR 0037 — What a query withheld is disclosed as one count, within the asker's own ceiling

- **Status:** proposed 2026-09-24
- **Decision owner:** technical authority
- **Scope:** how much of a query's withheld set may be disclosed (KF-SAS-RQ-222)

## Decision

A search or retrieval answer may say how many matching records the asker **could** be granted but
**is not** — records at or below their clearance that no grant reaches — as a single count, computed
on demand and never stored. It never discloses records above the asker's clearance, not even as a
count, and never titles, identifiers or types of anything withheld.

## Options rejected

- **Counts per classification level.** A count above the asker's ceiling proves such records exist
  and match the query — a disclosure the ceiling exists to prevent.
- **No disclosure at all.** Then a person who could simply ask for a grant never learns there is
  something to ask for; the withholding ledger (§64A) already says the system does not hide that
  things are withheld.

## How we will know

A test with matching records above the ceiling, within the ceiling but ungranted, and granted:
the count equals the middle group only, and changes with no stored row.

## Consequences

The count reveals that N granted-able matches exist; that is the intended disclosure. It is
computed at query time, so a revoked grant is reflected immediately.
