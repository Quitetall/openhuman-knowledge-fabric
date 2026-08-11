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

| Control                                                              | Where               | Proven by                            |
| -------------------------------------------------------------------- | ------------------- | ------------------------------------ |
| Canonical export round-trips through an empty database byte for byte | `packages/export`   | `tests/round-trip/export.test.ts`    |
| Restore drill runs the shipped scripts against real containers       | `scripts/`          | `tests/backup-restore/drill.test.ts` |
| Restore refuses a target that already holds records                  | `restore-verify.sh` | same                                 |
| Every derived index is rebuildable from the records                  | `search.rebuild()`  | `tests/integration/search.test.ts`   |

**Not mitigated: off-site copies, PITR, and a schedule.** The mechanism exists and is proven;
running it is not yet automated.

## T6 — An agent does something nobody asked for

| Control                                                              | Where                  | Proven by                               |
| -------------------------------------------------------------------- | ---------------------- | --------------------------------------- |
| Eight tools read; the ninth rehearses and cannot commit              | `packages/agent-tools` | `tests/integration/agent-tools.test.ts` |
| Transaction control the rehearsal cannot safely translate is refused | same                   | same                                    |
| A rehearsal does not consume the idempotency key it used             | same                   | same                                    |
| No tool returns artifact bytes                                       | same                   | same                                    |
| An agent reads as its principal, never wider                         | same                   | same                                    |

## T7 — Identity

| Control                                                              | Where                    | Proven by                            |
| -------------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| Bearer tokens verified against the issuer's published keys           | `packages/authorization` | `tests/permissions/identity.test.ts` |
| Issuer AND audience checked — a token for another service is refused | same                     | same                                 |
| Role claims in the token are never read                              | same                     | same                                 |
| The subject maps to a person; a subject nobody linked is refused     | `org.external_identity`  | same                                 |
| The acting role is checked live against `org.role_assignment`        | same                     | same                                 |
| Revocation takes effect immediately, not at token expiry             | same                     | same                                 |
| Headers are ignored entirely once a verifier exists — no fallback    | `apps/api`               | same                                 |
| The API refuses to boot outside development without a provider       | `apps/api/src/config.ts` | `apps/api/src/app.test.ts`           |

**The design decision worth arguing about, made explicitly.** The identity provider answers one
question — who is this — and the database answers everything else. Role claims are not
consulted, and there is no code path that reads them. If they were, an administrator in
Keycloak could grant themselves technical authority over a device design without touching this
system, and the record of who could approve what would live somewhere with no audit chain and
no separation of duty.

**Not mitigated: MFA and session management.** Both belong to the identity provider, which is
where they should be, but neither is configured. Token lifetime, refresh and step-up
authentication are provider policy and are not yet written down.

**Residual risk.** A stolen unexpired token acts as its subject until it expires or the
identity link is revoked. Revocation is immediate once somebody knows; nothing here shortens
the window before they do.

## What is deliberately out of scope

- **PHI.** Never enters this system in any form. Not a control — an absence.
- **Bank details, tax identifiers, payroll.** Referenced, never copied.
- **Vendor datasheets.** Third-party copyright; referenced by number, revision and digest.
- **Complainant identity.** `quality.complaint` holds a reference, never a name — putting
  personal data there would need a lawful basis this system does not have.

## Open items

| #   | Item                                                          | Blocks      |
| --- | ------------------------------------------------------------- | ----------- |
| 1   | Identity provider, MFA, session management                    | Service     |
| 2   | Off-site backup copies and a schedule                         | T5          |
| 3   | Checkpoint key custody separated from database administration | T1 residual |
| 4   | Object store backup on the database's schedule                | T4 residual |
| 5   | TLS termination and certificate management                    | Service     |
