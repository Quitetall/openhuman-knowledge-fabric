# Scheduled work acts as a declared service actor, never as a human and never around the dispatcher

**Status:** accepted — implemented 2026-09-02; builds on ADR 0016, ADR 0017
**Date raised:** 2026-09-02
**Date decided:** 2026-09-02
**Decision owner:** technical authority
**Scope:** under whose identity a timer replicates and re-verifies artifact copies, what that
identity can and cannot do, and how it is declared

## The problem, measured

ADR 0017 made replication and re-verification typed actions and left scheduling undecided.
A typed action needs an actor who holds a role; the only actors were humans with logins. So a
timer had two bad choices: dispatch as a human's person id from a config file, so the audit
trail says a person acted at 03:30 every night; or write to `artifact_location` directly with
a database role, so copies and verifications would name no act. The checkpoint signer shows
the shape the host already has — a one-shot behind a systemd timer with its own uid and
secrets from files — but it signs; it does not act.

## Decision

**A service actor is a person of kind `service`.** `org.person.person_kind` is `human` or
`service` — a column on the typed row, deliberately not a field of the `person` type in the
ontology: `person` is an approved R01 definition and the golden gate holds it byte-identical;
an approved semantic is extended around, never redefined. A service actor holds an organization-scoped role assignment and a clearance like
any principal, so the dispatcher, row-level security and the access-grant view treat it
exactly as they treat a person. Two things distinguish it, both refused rather than
documented: it can never be linked to a login (a trigger on `org.external_identity`), and it
can never perform a `requires: act` action (the dispatcher refuses it by name, whatever
grants reach it). A service actor does routine work under authority somebody granted; it
never authorizes, approves, grants, allocates or resolves.

**Declared by an operator, on the owner connection, as a recorded act.**
`pnpm kf:declare-service-actor --organization … --name storage-steward --role performer
--classification … --declared-by <person> --reason …` creates the person, the role assignment
(delegated by the decider), the clearance, and a `grant_person_clearance` action and audit
event by the human who decided — the same three writes `kf:grant-authority` makes, by the
same code. It is idempotent on the name. Nothing is defaulted.

**The sweep is a sibling of the checkpoint signer.** `apps/kf-storage` is a one-shot:
`--replicate` dispatches `replicate_artifact_version` for every version lacking a location in
the durable store; `--verify --older-than-days N` dispatches `verify_artifact_location` for
every location not verified within N days. Every write is a typed action under
`KF_STORAGE_ACTOR` / `KF_STORAGE_ROLE`, so each copy and each verification is an audited act
by a named principal with a receipt. A second run does nothing. A verification that finds a
bad copy, or any refusal, exits non-zero so the timer's failure hook fires.
`deploy/systemd/kf-storage.service` and `deploy/systemd/kf-storage.timer` run it daily at 03:30 as its own uid with the
working and durable store credentials from files.

## What this does not decide

- **Which role.** The runbook uses `performer`; a narrower role for automation is a role
  vocabulary question for the pack owner.
- **Other service actors.** The mechanism is general; only the storage steward exists.
- **Rotation.** A service actor's role assignment has a `valid_to` like any other; nothing
  yet rotates or re-declares one on a cadence.

## How this is held

`tests/database/service-actor.test.ts`: declaring records the human's act and creates the
service person with role and clearance, and is idempotent; linking it to a login is refused by
the database; an institutional act (`allocate_enterprise_identifier`) is refused for it by name
even under an organization-scoped role; the sweep run as it replicates a version to the
durable store and re-verifies, every action's actor is the service person, and a second run
does nothing.
