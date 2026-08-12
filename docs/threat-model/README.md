# Threat model

Written to be falsifiable. Every control below names where it lives and which test proves it
does something — because a threat model whose mitigations cannot be pointed at is a document
about intentions.

Where a threat is **not** mitigated, it says so. An honest gap is useful; a comforting one is
worse than nothing.

## What this system is worth attacking for

Not the records themselves. Three things:

1. **Changing what the record says happened.** Backdating an approval, raising a ceiling after
   the fact, making a nonconformity never have existed.
2. **Reading what should be narrower.** Contractor rates, payment references, decisions still
   under discussion.
3. **Making it unavailable at the moment it is needed** — an audit, a recall, a dispute.

The system is small and internal. It has no anonymous surface, and the realistic adversary is
someone who already has _some_ legitimate access, not a stranger on the internet.

## T1 — An insider rewrites history

**The one that matters most.** Someone with database access edits `core.audit_event`, or the
records under it, so the past reads differently.

| Control                                                                            | Where                     | Proven by                                 |
| ---------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------- |
| Append-only tables refuse UPDATE/DELETE/TRUNCATE by trigger, binding the OWNER too | `20260811000300_core.sql` | `tests/database/kernel.test.ts`           |
| Every event chains to its predecessor's digest                                     | `packages/actions`        | `tests/audit-verification/ledger.test.ts` |
| Merkle checkpoints signed with a key the API cannot reach                          | `apps/checkpoint`         | same                                      |
| Verification recomputes chain, tree and signature independently                    | `verifyLedger`            | same                                      |

The tamper tests act **as the database owner**, which is the strongest adversary the system
has. Editing a record and relinking the chain over it still fails the signed root; deleting an
event fails two independent checks.

**Residual risk.** An attacker who holds the signing key can forge a consistent history. The
key lives in a separate process; keeping it there is an operational commitment, not a
technical guarantee. **Not mitigated: an operator who is also the checkpoint key holder.**

## T2 — The application is compromised

The API process is the largest attack surface. Assume it is fully controlled.

| Control                                                                        | Where                          | Proven by                                     |
| ------------------------------------------------------------------------------ | ------------------------------ | --------------------------------------------- |
| `kf_app` cannot UPDATE `core.object` outside the dispatcher                    | write guards, `20260811000800` | `tests/database/kernel.test.ts`               |
| A controlled write with no transaction context is refused                      | `object_guard_1_context`       | same                                          |
| A lifecycle move must be one the ontology permits **for the acting action**    | `object_guard_2_transition`    | same                                          |
| Financial invariants are triggers, not application code                        | `20260811001200_finance.sql`   | `tests/end-to-end/reference-scenario.test.ts` |
| Aggregate checks run SECURITY DEFINER so a narrowed scope cannot hide a breach | same                           | same                                          |

A compromised API can still record **true-shaped lies** — an action that really was performed,
by an actor it really was authorised for, saying something false. Nothing here prevents that,
and nothing can: the system records what it is told by someone entitled to tell it.

## T3 — Reading past your scope

| Control                                                               | Where                           | Proven by                               |
| --------------------------------------------------------------------- | ------------------------------- | --------------------------------------- |
| FORCE ROW LEVEL SECURITY on `core.object`, `relation`, `audit_event`  | `20260811000400`                | `tests/database/kernel.test.ts`         |
| Unset classification ranks **−1**, so a missing scope sees nothing    | `current_classification_rank()` | same                                    |
| Search filters at query time on the same two axes                     | `packages/search`               | `tests/integration/search.test.ts`      |
| Agent tools scope every read, including history and available actions | `packages/agent-tools`          | `tests/integration/agent-tools.test.ts` |
| Not-visible and not-existing are the same answer                      | API + tools                     | `tests/permissions/api-actions.test.ts` |

Tests connect as an **unprivileged login role**, not the container superuser — which bypasses
even FORCE RLS. An earlier version of the harness did exactly that and would have reported
every policy working while none was consulted.

## T4 — Evidence is altered underneath the record

| Control                                                                                                    | Where                  | Proven by                              |
| ---------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------- |
| The server re-derives the digest from the stored bytes; the client's claim is only used to detect mismatch | `packages/artifacts`   | `tests/round-trip/export.test.ts`      |
| Full bytes are read, never an ETag or a length                                                             | same                   | same                                   |
| `verifyRecordedVersion` re-checks the vault against the record                                             | same                   | same                                   |
| Federated content is pinned to a commit and digested as seen                                               | `packages/integration` | `tests/integration/federation.test.ts` |

**Not mitigated: the object store's own durability.** If the bucket is lost, the digests prove
what the bytes _were_, and that is all. Backing up the bucket on the same schedule as the
database is an operational requirement — see [backup and restore](../backup-and-restore/).

## T5 — Loss

| Control                                                              | Where                                                    | Proven by                            |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| Canonical export round-trips through an empty database byte for byte | `packages/export`                                        | `tests/round-trip/export.test.ts`    |
| Restore drill runs the shipped scripts against real containers       | `scripts/`                                               | `tests/backup-restore/drill.test.ts` |
| Restore refuses a target that already holds records                  | `restore-verify.sh`                                      | same                                 |
| Every derived index is rebuildable from the records                  | `search.rebuild()`                                       | `tests/integration/search.test.ts`   |
| A declared recovery objective, or readiness FAILS                    | `ops.recovery_objective`                                 | `tests/database/readiness.test.ts`   |
| Backups, off-site copies and drills are recorded and checked         | `ops.backup_run`, `ops.backup_copy`, `ops.restore_drill` | same                                 |
| The objective cannot be edited into compliance — only superseded     | append-only trigger                                      | same                                 |
| Continuous archiving is checked against the declared objective       | `pitr_readiness`                                         | same                                 |
| Everything above runs on a timer, and a timer that stops is noticed  | `deploy/systemd/`                                        | —                                    |

**The load-bearing part is the objective, not the schedule.** "Back up nightly" is an activity;
an objective says how much work the organization has decided it can afford to lose. Until one
is declared, no schedule can be called sufficient — so an undeclared objective is a readiness
FAILURE rather than a default, and the check reads the declared numbers rather than constants
of its own.

**Not mitigated: the timers themselves are not proven by a test.** `deploy/systemd/` is
configuration for a host this repository does not own. What IS proven is that a system whose
backups have stopped, never left the host, or have never been restored reports so — which is
the property that makes an unnoticed failure of those units survivable rather than silent.

## T6 — An agent does something nobody asked for

| Control                                                              | Where                  | Proven by                               |
| -------------------------------------------------------------------- | ---------------------- | --------------------------------------- |
| Eight tools read; the ninth rehearses and cannot commit              | `packages/agent-tools` | `tests/integration/agent-tools.test.ts` |
| Transaction control the rehearsal cannot safely translate is refused | same                   | same                                    |
| A rehearsal does not consume the idempotency key it used             | same                   | same                                    |
| No tool returns artifact bytes                                       | same                   | same                                    |
| An agent reads as its principal, never wider                         | same                   | same                                    |

## T7 — Identity

| Control                                                                                  | Where                                   | Proven by                                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| Bearer tokens verified against the issuer's published keys                               | `packages/authorization`                | `tests/permissions/identity.test.ts`                                      |
| Issuer AND audience checked — a token for another service is refused                     | same                                    | same                                                                      |
| Role claims in the token are never read                                                  | same                                    | same                                                                      |
| The subject maps to a person; a subject nobody linked is refused                         | `org.external_identity`                 | same                                                                      |
| The acting role is checked live against `org.role_assignment`                            | same                                    | same                                                                      |
| Revocation takes effect immediately, not at token expiry                                 | same                                    | same                                                                      |
| Headers are ignored entirely once a verifier exists — no fallback                        | `apps/api`                              | same                                                                      |
| The API refuses to boot outside development without a provider                           | `apps/api/src/config.ts`                | `apps/api/src/app.test.ts`                                                |
| Money, release and control-withdrawal actions require a fresh, strong authentication     | `packages/authorization/src/step-up.ts` | `tests/permissions/step-up.test.ts`, `tests/permissions/identity.test.ts` |
| Step-up fails closed on every unknown the provider does not report                       | same                                    | same                                                                      |
| Step-up is checked before the action, and a refusal does not consume the idempotency key | `apps/api/src/routes/actions.ts`        | `tests/permissions/identity.test.ts`                                      |

**The design decision worth arguing about, made explicitly.** The identity provider answers one
question — who is this — and the database answers everything else. Role claims are not
consulted, and there is no code path that reads them. If they were, an administrator in
Keycloak could grant themselves technical authority over a device design without touching this
system, and the record of who could approve what would live somewhere with no audit chain and
no separation of duty.

**MFA and session lifetime remain provider policy — but no longer only that.** Which factors
exist, and how long a session lasts, are configured at the provider, and this system does not
try to own them. What it owns is which actions refuse to proceed without them: twelve, chosen
by consequence rather than by feeling, each one that moves money, releases a product, or
withdraws a control. `auth_time`, `acr` and `amr` are read from the token because the
authentication event happened at the provider and nowhere else — that is not the same mistake
as reading role claims, it is the one place the answer exists.

Every unknown fails closed. A provider that does not report `auth_time` cannot prove a session
is recent, and "cannot prove" has to mean no, or the control evaporates for exactly the
providers least able to enforce it.

**Not mitigated: token lifetime and refresh policy are still not written down.** They belong
in the provider's own configuration, which this repository does not hold.

**Residual risk.** A stolen unexpired token acts as its subject until it expires or the
identity link is revoked. Revocation is immediate once somebody knows; nothing here shortens
the window before they do. Step-up narrows what such a token can do — it cannot authorize a
payment or close a CAPA without a fresh authentication it does not have — but it does not stop
it reading, and everything in T6's read surface is available to it.

## What is deliberately out of scope

- **PHI.** Never enters this system in any form. Not a control — an absence.
- **Bank details, tax identifiers, payroll.** Referenced, never copied.
- **Vendor datasheets.** Third-party copyright; referenced by number, revision and digest.
- **Complainant identity.** `quality.complaint` holds a reference, never a name — putting
  personal data there would need a lawful basis this system does not have.

## T8 — Transport and credentials

| Control                                                                                                  | Where                                | Proven by                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------- |
| The process refuses to boot outside development unless the deployment asserts TLS is terminated upstream | `apps/api/src/config.ts`             | `apps/api/src/app.test.ts`          |
| HSTS in staging and production; nosniff, DENY, no-referrer, no-store always                              | `apps/api/src/app.ts`                | same                                |
| Secrets are read from files, not the environment                                                         | `packages/operations/src/secrets.ts` | `tests/permissions/secrets.test.ts` |
| A secret file readable beyond its owner is REFUSED, not warned about                                     | same                                 | same                                |
| An inline credential outside development is refused                                                      | same                                 | same                                |
| The same rule applies to the checkpoint signing key                                                      | `readSecretFile`                     | same                                |
| Failure messages never contain the secret                                                                | same                                 | same                                |
| The shell scripts resolve credentials the same way                                                       | `scripts/lib/secret.sh`              | —                                   |

**TLS is not terminated by this application, and that is the intended design.** What changed is
that it is no longer assumed: a deployment must state the posture, and a process that would
otherwise serve bearer tokens over clear HTTP refuses to start instead. Certificate issuance
and renewal belong to the proxy.

**Not mitigated: the proxy's own configuration.** Nothing here can verify that the thing in
front of it actually terminates TLS — `KF_TLS_TERMINATED_UPSTREAM=1` is an assertion by
whoever deploys, and a false one produces exactly the exposure it claims to prevent.

## Open items

| #   | Item                                                           | Blocks      |
| --- | -------------------------------------------------------------- | ----------- |
| 1   | Identity provider selection; token lifetime and refresh policy | Service     |
| 2   | Checkpoint key custody separated from database administration  | T1 residual |
| 3   | Object store backup on the database's schedule                 | T4 residual |
| 4   | Certificate issuance and renewal at the proxy                  | Service     |
| 5   | An alert unit (`kf-alert@`) that actually reaches a person     | T5, T8      |

Items 1–4 are decisions for whoever operates this, not code that is missing. Item 5 is a
genuine gap: every scheduled unit declares `OnFailure=kf-alert@%n.service` and no such unit
exists, because a default that goes nowhere is worse than an absent one that fails to start.
