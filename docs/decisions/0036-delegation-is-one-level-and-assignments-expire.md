# ADR 0036 — Delegation goes one level deep, and a new assignment carries a review date

- **Status:** proposed 2026-09-24
- **Decision owner:** technical authority
- **Scope:** the maximum delegation depth and the maximum life of a role assignment or project
  membership
- **Carries:** closes §100.8 and §100.9; bears on KF-SAS-RQ-039

## Decision

1. **Depth one.** A person holding a delegated assignment may not delegate it again. The database
   refuses an assignment whose `delegated_by` holds the role only through delegation.
2. **Every new role assignment and project membership has an end within 366 days**
   (`valid_to` required, at most a year and a day ahead). Renewal is a new, attributed assignment —
   the review is the act. Rows created before this decision are grandfathered and reported by
   readiness as "no review date" until renewed.

## Options rejected

- **Unbounded depth with an audit report.** The chain would be recorded but every link would still
  grant; depth one keeps "who can act" answerable from two rows.
- **Expiry by a periodic sweep.** A sweep that stops leaves grants alive silently; an end date in the
  row cannot be forgotten.
- **Longer maximum.** A year is the longest interval in which a stale grant is still likely to be
  noticed by the person who made it.

## How we will know

Planted tests: a re-delegation and an assignment without an end (or ending after 366 days) are
refused by the database; a renewal is accepted.

## Consequences

`kf:grant-authority` asks for an end date (default one year). Assignments made by bootstrap are the
exception the owner credential already is.
