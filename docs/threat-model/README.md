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

**Until 2026-09-23 the rows above were the whole of T2, and they held only against a buggy
API, not a hostile one.** A red-team pass executed as `kf_app` showed the context those guards
read was the API's to write: `set_config('kf.organization', …)` bound any tenant, the ceiling
was whatever string the API passed, the actor was any uuid, and `core.action`,
`core.audit_event`, `org.role_assignment`, `org.external_identity` and
`core.object_verification` all accepted direct inserts or updates that no act had made. Every
one of those was a success, not a refusal. The controls below close them, each in the database:

| Control                                                                                                                                                                                          | Where                                                                                    | Proven by                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| The context is **sealed**: an HMAC under a key no role with write grants can read binds it to the transaction; a raw `set_config` reads as unset                                                 | `core.context_mac`, `20260923000100`                                                     | `tests/database/principal-binding.test.ts`    |
| No function but the context accessors reads a `kf.*` setting, and internal flags are sealed the same way                                                                                         | same                                                                                     | same                                          |
| The actor must be a person holding the stated acting role live in the bound organization; the ceiling is clamped to their clearance                                                              | `core.set_transaction_context`                                                           | same                                          |
| The API binds a reader only as a principal; organization and ceiling come from the principal's live assignment and clearance                                                                     | `core.bind_principal`                                                                    | same                                          |
| An action row must be the one the sealed context names — its id, actor, role and organization                                                                                                    | `action_scoped_insert` policy                                                            | same                                          |
| An audit event's digest is recomputed by the database, and its actor and action must match the context                                                                                           | `core.enforce_audit_chain_head`                                                          | same                                          |
| Role assignments and clearances can only be end-dated, never re-targeted, reopened or extended                                                                                                   | guard triggers, `20260923000200`                                                         | same                                          |
| An external identity is linked or revoked only under a sealed actor, in that actor's organization                                                                                                | `org.external_identity` RLS                                                              | same                                          |
| A verification row must name the sealed actor and action as verifier and act, and the verifier is never the record's creator                                                                     | `object_verification_write` policy                                                       | same                                          |
| A shared-link bearer binds only the link's own organization and ceiling, resolved by the database from the token digest                                                                          | `content.bind_master_record_link`                                                        | same                                          |
| SECURITY DEFINER lookups that take an organization answer only for the bound one                                                                                                                 | `slot_bands`, `person_lookup`, `organization_by_name`, `secure_object_capability_grants` | same                                          |
| An unverified record cannot be cited as evidence by wrapping its id; every uuid in a reference is checked                                                                                        | `work.evidence_ref_is_unverified_record`                                                 | same                                          |
| An access-grant revocation writes only its own columns, at the database's time                                                                                                                   | column grant + `access_grant_revoked_now`                                                | same                                          |
| An institutional act (`requires: act`) must be covered by a live act grant, and is never a service actor's; the database asks `org.act_grant_reaches` on the ledger row                          | `action_requires_act_authority`, `20260924000100`                                        | `tests/database/act-authority.test.ts`        |
| Every table that enables row security forces it, so a login inheriting the owner is bound too                                                                                                    | `20260924000200`                                                                         | `tests/database/row-security-forced.test.ts`  |
| `reviewed_individually` twice by one verifier within `core.individual_review_interval()` (1 s) is refused, and `verified_at` is the database's clock; the bulk gesture stamps `promoted_in_bulk` | `object_verification_paced`, `20260924000300`, `POST /verifications/bulk`                | `tests/permissions/bulk-verification.test.ts` |
| Every orphaned evidence key the storage sweep deletes is recorded in the append-only `content.orphan_collection`, written only through a definer seam as the bound service actor, and exported   | `20260924000400`                                                                         | `tests/database/service-actor.test.ts`        |

Two application-level controls sit beside these, because the adversary they answer is a tired
person rather than a hostile process: `verify_record` and `apply_document_proposal` refuse the
person who created the record or made (or asked a model for) the proposal, and a required reason
must say something — eight characters and more than one repeated key
(`packages/actions`; proven in `packages/documents/src/index.test.ts` and
`tests/database/verify-record-action.test.ts`).

**What the pace does not do.** A script that waits more than a second between records can still
claim `reviewed_individually`. The pace makes the false claim slow, and every claim is attributed
to its verifier; it does not make it impossible.

**Residual risk, stated plainly.** The database still cannot authenticate a human: it checks
that the actor the API names really holds the role and clearance it claims, not that the
person is present. A fully compromised API can therefore still act **as any real person with
that person's real authority** — the true-shaped lie below, now bounded by that person's
authority rather than by nothing. Closing it needs the database to verify the token itself,
recorded as open item 6.

A compromised API can still record **true-shaped lies** — an action that really was performed,
by an actor it really was authorised for, saying something false. Nothing here prevents that,
and nothing can: the system records what it is told by someone entitled to tell it.

## T3 — Reading past your scope

| Control                                                                    | Where                           | Proven by                               |
| -------------------------------------------------------------------------- | ------------------------------- | --------------------------------------- |
| FORCE ROW LEVEL SECURITY on every table that enables it (`20260924000200`) | `20260811000400`                | `tests/database/kernel.test.ts`         |
| Unset classification ranks **−1**, so a missing scope sees nothing         | `current_classification_rank()` | same                                    |
| Search filters at query time on the same two axes                          | `packages/search`               | `tests/integration/search.test.ts`      |
| Agent tools scope every read, including history and available actions      | `packages/agent-tools`          | `tests/integration/agent-tools.test.ts` |
| Not-visible and not-existing are the same answer                           | API + tools                     | `tests/permissions/api-actions.test.ts` |

Tests connect as an **unprivileged login role**, not the container superuser — which bypasses
even FORCE RLS. An earlier version of the harness did exactly that and would have reported
every policy working while none was consulted.

## T4 — Evidence is altered underneath the record

| Control                                                                                                                                                                     | Where                                                                    | Proven by                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| The server re-derives the digest from the stored bytes; the client's claim is only used to detect mismatch                                                                  | `packages/artifacts`                                                     | `tests/round-trip/export.test.ts`                |
| Full bytes are read, never an ETag or a length                                                                                                                              | same                                                                     | same                                             |
| `verifyRecordedVersion` re-checks the vault against the record                                                                                                              | same                                                                     | same                                             |
| Federated content is pinned to a commit and digested as seen                                                                                                                | `packages/integration`                                                   | `tests/integration/federation.test.ts`           |
| The storage key is derived by the server from the bound organization and digest; a caller-named key is refused                                                              | `evidenceStorageKey`, `@kf/documents`                                    | `packages/documents/src/index.test.ts`           |
| pandoc parses under a sandbox, a heap ceiling, a wall-clock kill and an output cap, and refuses rather than hangs, and on the ingest paths before the act transaction opens | `packages/documents`                                                     | `packages/documents/src/pandoc-parser.test.ts`   |
| The compiler sandbox runs under its own BPF deny list as well as the worker unit's syscall filter                                                                           | `packages/documents/src/liminal-adapter/seccomp.ts`, `kf-worker.service` | `tests/deployment/worker-syscall-filter.test.ts` |
| Nothing reaches the object store before the act could be refused; unreferenced bytes are swept after a grace period                                                         | ingest route, `kf-storage --collect-orphans`                             | `apps/api/src/ingest/content-policy.test.ts`     |

**Not mitigated: the object store's own durability.** If the bucket is lost, the digests prove
what the bytes _were_, and that is all. Backing up the bucket on the same schedule as the
database is an operational requirement — see [backup and restore](../backup-and-restore/).

## T5 — Loss

| Control                                                                                                                           | Where                                                    | Proven by                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Canonical export round-trips through an empty database byte for byte                                                              | `packages/export`                                        | `tests/round-trip/export.test.ts`                      |
| Restore drill runs the shipped scripts against real containers                                                                    | `scripts/`                                               | `tests/backup-restore/drill.test.ts`                   |
| Restore refuses a target that already holds records                                                                               | `restore-verify.sh`                                      | same                                                   |
| Every derived index is rebuildable from the records                                                                               | `search.rebuild()`                                       | `tests/integration/search.test.ts`                     |
| A declared recovery objective, or institutional readiness FAILS                                                                   | `ops.recovery_objective`                                 | `tests/database/readiness.test.ts`                     |
| Backups, off-site copies and drills are recorded and checked                                                                      | `ops.backup_run`, `ops.backup_copy`, `ops.restore_drill` | same                                                   |
| The objective cannot be edited into compliance — only superseded                                                                  | append-only trigger                                      | same                                                   |
| Continuous archiving is checked against the declared objective                                                                    | `pitr_readiness`                                         | same                                                   |
| Everything above runs on a timer, and a timer that stops is noticed                                                               | `scripts/timer-liveness.sh`, `X-KF-MaxSilenceSec=`       | `tests/deployment/timer-liveness.test.ts`              |
| A crash-looping service ends in `failed`, so its alert fires                                                                      | `StartLimitBurst=` on every restarting unit              | `tests/deployment/systemd-units.test.ts`               |
| Backups are encrypted to a public key before they leave, and pruned only once an off-site copy exists                             | `scripts/backup.sh`                                      | `tests/backup-restore/backup-hardening.test.ts`        |
| A local destination is not off-site unless a named failure domain says so                                                         | `scripts/backup-offsite.sh`                              | `tests/backup-restore/offsite-copy.test.ts`            |
| The drill restores the off-site copy, into a throwaway cluster                                                                    | `scripts/restore-drill.sh`                               | `tests/backup-restore/restore-drill-source.test.ts`    |
| The drill decrypts as its own user, `kf-drill`, the only unit holding the sealed decryption credential; the backup user never can | `kf-restore-drill.service`                               | `tests/deployment/systemd-units.test.ts`               |
| The release ships the object-store verifier; a host program is only a root-owned, digest-pinned override                          | `apps/kf-storage/src/verify-object-store.ts`             | `tests/backup-restore/restore-verify-defaults.test.ts` |
| Checkpoint signatures are verified daily, by an identity holding no signing key                                                   | `kf-audit-verify.timer`                                  | `tests/deployment/systemd-units.test.ts`               |

**The load-bearing part is the objective, not the schedule.** "Back up nightly" is an activity;
an objective says how much work the organization has decided it can afford to lose. Until one
is declared, no schedule can be called sufficient — so an undeclared objective is an
institutional-readiness FAILURE rather than a default. It blocks preservation claims without
making a capable shared-dogfood service unavailable. Check reads declared numbers rather than
constants of its own.

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

| Control                                                                                                                     | Where                                                | Proven by                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Bearer tokens verified against the issuer's published keys                                                                  | `packages/authorization`                             | `tests/permissions/identity.test.ts`                                      |
| Issuer AND audience checked — a token for another service is refused                                                        | same                                                 | same                                                                      |
| Role claims in the token are never read                                                                                     | same                                                 | same                                                                      |
| The subject maps to a person; a subject nobody linked is refused                                                            | `org.external_identity`                              | same                                                                      |
| The acting role is checked live against `org.role_assignment`                                                               | same                                                 | same                                                                      |
| Revocation takes effect immediately, not at token expiry                                                                    | same                                                 | same                                                                      |
| Headers are ignored entirely once a verifier exists — no fallback                                                           | `apps/api`                                           | same                                                                      |
| The API refuses to boot outside development without a provider                                                              | `apps/api/src/config.ts`                             | `apps/api/src/app.test.ts`                                                |
| Money, release and control-withdrawal actions require a fresh, strong authentication                                        | `packages/authorization/src/step-up.ts`              | `tests/permissions/step-up.test.ts`, `tests/permissions/identity.test.ts` |
| Step-up fails closed on every unknown the provider does not report                                                          | same                                                 | same                                                                      |
| Step-up is checked before the action, and a refusal does not consume the idempotency key                                    | `apps/api/src/routes/actions.ts`                     | `tests/permissions/identity.test.ts`                                      |
| Tokens are verified as RS256 only, against an HTTPS key set                                                                 | `packages/authorization`, `apps/web/src/lib/oidc.ts` | `apps/web/src/lib/oidc.test.ts`                                           |
| The realm refuses weak settings at commissioning: brute force, password policy, MFA enrolment, refresh reuse, direct grants | `commissioning/environment.ts`                       | `tests/deployment/keycloak-realm.test.ts`                                 |
| Logout ends the provider session too, and clears every local cookie on every branch                                         | `apps/web` logout route                              | `apps/web/src/lib/oidc.test.ts`                                           |

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

**Token lifetime and refresh policy are now written down** in the shipped realm and checked at
commissioning: 300-second access tokens, refresh tokens that cannot be reused, offline sessions
capped at 3 days idle and 7 in total.

**Residual risk.** A stolen unexpired token acts as its subject until it expires or the
identity link is revoked. Revocation is immediate once somebody knows; nothing here shortens
the window before they do. Step-up narrows what such a token can do — it cannot authorize a
payment or close a CAPA without a fresh authentication it does not have — but it does not stop
it reading, and everything in T6's read surface is available to it.

## What is deliberately out of scope

- **PHI.** Never enters this system in any form. Policy first; since 2026-09-23 ingest and sync
  also refuse private keys, likely IBAN, SSN and card numbers and credential-shaped filenames
  (`apps/api/src/ingest/content-policy.ts`). A backstop, not a guarantee: it reads inside ZIP packages (DOCX, ODT, XLSX, PPTX, ODS) and PDF
  FlateDecode streams, under a 64 MiB / 10 000-part / 250:1 bound that refuses a decompression
  bomb, but not text drawn through custom-encoded (CID) fonts, encrypted PDFs or images, and it
  knows no pattern for health information.
- **Bank details, tax identifiers, payroll.** Referenced, never copied.
- **Vendor datasheets.** Third-party copyright; referenced by number, revision and digest.
- **Complainant identity.** `quality.complaint` holds a reference, never a name — putting
  personal data there would need a lawful basis this system does not have.

## T8 — Transport and credentials

| Control                                                                                                              | Where                                     | Proven by                                   |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| The process refuses to boot outside development unless the deployment asserts TLS is terminated upstream             | `apps/api/src/config.ts`                  | `apps/api/src/app.test.ts`                  |
| HSTS in staging and production; nosniff, DENY, no-referrer, no-store always                                          | `apps/api/src/app.ts`                     | same                                        |
| Secrets are read from files, not the environment                                                                     | `packages/operations/src/secrets.ts`      | `tests/permissions/secrets.test.ts`         |
| A secret file readable beyond its owner is REFUSED, not warned about                                                 | same                                      | same                                        |
| An inline credential outside development is refused                                                                  | same                                      | same                                        |
| The same rule applies to the checkpoint signing key                                                                  | `readSecretFile`                          | same                                        |
| Failure messages never contain the secret                                                                            | same                                      | same                                        |
| The shell scripts resolve credentials the same way                                                                   | `scripts/lib/secret.sh`                   | —                                           |
| The API refuses to serve on a database login that is a superuser, bypasses row security, or can become a table owner | `@kf/database` `loginPrivilegeProblems`   | `tests/permissions/login-privilege.test.ts` |
| The readiness report is whole only for loopback or a token holder; everyone else gets one boolean                    | `apps/api/src/app.ts`, nginx              | `apps/api/src/readiness-cache.test.ts`      |
| `NODE_ENV` must be stated, and the development profile listens only on loopback                                      | `apps/api/src/config.ts`                  | `apps/api/src/app.test.ts`                  |
| 5xx bodies carry a request id, never an error message                                                                | `setErrorHandler`                         | same                                        |
| Per-address rate limits at the proxy; a nonce CSP and `frame-ancestors 'none'` on the web                            | `deploy/nginx`, `apps/web/src/lib/csp.ts` | `apps/web/src/lib/csp.test.ts`              |

**TLS is not terminated by this application, and that is the intended design.** What changed is
that it is no longer assumed: a deployment must state the posture, and a process that would
otherwise serve bearer tokens over clear HTTP refuses to start instead. Certificate issuance
and renewal belong to the proxy.

**Not mitigated: the proxy's own configuration.** Nothing here can verify that the thing in
front of it actually terminates TLS — `KF_TLS_TERMINATED_UPSTREAM=1` is an assertion by
whoever deploys, and a false one produces exactly the exposure it claims to prevent.

## Accepted gaps from the 2026-09-23 hardening

- **pandoc parses inside the transaction only for acts dispatched without a pre-parse** (the
  generic `/actions` route, dogfood loaders). Ingest, document import and `kf ingest` parse before
  the transaction opens; the deadline bounds the rest.
- **The compiler's own syscall filter is a deny list, not an allow list**, because the pinned
  compiler's syscall set has not been measured. It runs under `bwrap --seccomp`
  (`liminal-adapter/seccomp.ts`) on top of the worker unit's inherited `SystemCallFilter=`.

## Open items

| #   | Item                                                           | Blocks      |
| --- | -------------------------------------------------------------- | ----------- |
| 1   | Identity provider selection; token lifetime and refresh policy | Service     |
| 2   | Checkpoint key custody separated from database administration  | T1 residual |
| 3   | Object store backup on the database's schedule                 | T4 residual |
| 4   | Certificate issuance and renewal at the proxy                  | Service     |
| 5   | A person confirming they receive an alert                      | T5, T8      |
| 6   | The database verifying the bearer token itself                 | T2 residual |

Items 1–4 are decisions for whoever operates this, not code that is missing.

**Item 5 was a genuine gap and is now half of one.** Every scheduled unit declares
`OnFailure=kf-alert@%n.service`, and until 2026-08-17 no such unit existed — deliberately,
because a default that goes nowhere is worse than an absent one that fails to start.

`kf-alert@.service` now ships. It POSTs to a webhook URL held as an owner-only file, refuses a
cleartext endpoint, retries, and exits non-zero when the endpoint will not take it — so a
delivery that reached nobody is a failed unit rather than a silent success.
`tests/deployment/alert-dispatch.test.ts` exercises it against a real HTTPS server with real
`curl`, including the refusals.

**The alert carries no log content.** Unit name, host, time, systemd's result words, and the
invocation id — never a journal excerpt. The destination is a third-party endpoint outside this
system, and a log line from a failed backup or compilation can carry record content; the
invocation id lets the recipient run `journalctl _SYSTEMD_INVOCATION_ID=<id>` on the host
instead, under the host's own access control. The test asserts the payload's key set exactly,
so a later change that attaches "just a bit of context" fails rather than lands.

`kf-alert-heartbeat.timer` sends a daily success ping through the same path. This is what makes
a DEAD alerter detectable: a failed delivery is visible on the host, but a path that has quietly
stopped working is visible nowhere, and the receiver noticing the silence is the only signal
that leaves the machine.

What remains is the half no code can supply: **nobody has yet received one.** A webhook URL
that is wrong, revoked, or pointed at an abandoned channel passes every check here and reaches
no person. That is host evidence, and it is the form item 5 now takes.
