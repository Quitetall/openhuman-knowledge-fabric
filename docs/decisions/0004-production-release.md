# What v1.0 claims, and what still has to be true before it can

**Status:** accepted — the criteria below are the v1.0 gate
**Date raised:** 2026-08-17
**Date decided:** 2026-08-17
**Decision owner:** technical authority
**Scope:** what the version number `1.0.0` asserts about this system, which of the remaining
blockers gate it, and the criterion that replaces roadmap step 10's thirty-day shadow
**Decision:** v1.0 requires a commissioned host, not only finished software. No third
deployment profile. The shadow becomes an evidence criterion rather than a calendar one.

---

## Why this exists

Roadmap steps 1–9 are implemented. Seven CI gates pass (112 test files, 1120 tests). The last
blocker that was missing _code_ rather than host evidence closed on 2026-08-17 with
`kf-alert@.service`. What is left is of a different kind, and the version number has to say
which kind it is.

The risk this record exists to prevent is a familiar one in this repository: a true statement
that reads as a larger one. "Knowledge Fabric v1.0" would be read by almost anyone as "this is
running and holding records". If it were tagged today it would mean "the software is finished
and nothing has ever been deployed", and nothing in a version number distinguishes those.

## What was measured

```
pnpm gate                    exit 0 — 112 files, 1120 passed, 4 skipped
pnpm ontology:verify         release/knowledge-fabric-1.0.0-draft.2 → DRAFT, exit 1
kf-commissioning             never run against a host
deployment profiles          development | dogfood        (no `production`)
known blockers               7, of which 4 have no automated check
```

Nothing has been commissioned on any host. Every deployment artifact in this repository — units,
templates, verifiers, the migration runner, the rollback contract — is an input to
commissioning, not evidence of it.

## What v1.0 claims

1. The software is complete against roadmap steps 1–9 and every gate CI runs passes from a
   clean checkout.
2. The R01 schema pack `1.0.0-draft.2` has been approved and signed, so
   `pnpm ontology:verify` reports `APPROVED` rather than `DRAFT`.
3. **One host has been commissioned**, and `kf-commissioning` reports every check `satisfied`.
   Not `unverifiable` — a check that could not run is not a check that passed, which is why
   that status exists and why it fails the gate.
4. The document-compiler parity criterion below has been met and cutover accepted.

## What v1.0 does not claim

Stated because each of these is something a reader could reasonably assume from a 1.0:

- **Not FDA cleared, not a medical device, not for clinical use.** No regulatory submission
  exists for this system.
- **No PHI.** Protected health information never enters the Fabric in any form. This is an
  absence, not a control — there is no PHI-handling capability to assess.
- **Not multi-tenant in operation.** The schema is organization-scoped and row-level security
  enforces it, but v1.0 is one organization on one host. Federation exists and is tested; it
  has not been operated between two real deployments.
- **Not a claim about availability.** No SLA, no redundancy, no failover. The recovery
  objective is whatever the operator declared, proven only by the restore drill.
- **Not independently reviewed.** See "Separation of duty" below.

## Production is a state of the host, not a deployment profile

The obvious move on a production release is to add a `production` profile beside `development`
and `dogfood`. It is rejected.

`dogfood` already enforces every process-level rule production needs: the fixed `KF_DEV_*`
identity is refused and `KF_ALLOW_FIXED_IDENTITY=1` cannot re-enable it, an identity provider
is required, the API binds loopback, and the process refuses to start unless the deployment
asserts TLS is terminated upstream. A third profile would change none of that. **A label that
changes no behaviour is a control that is not one**, and this repository has spent enough
effort removing those.

There is exactly one real difference, and it is handled directly rather than by a flag:
`docs/deployment/private-host.md` permits PostgreSQL, object storage and Keycloak to begin on
the same private host "for bounded dogfood". That is a genuine production concern. The
commissioning record must therefore **state whether the host co-locates them**, and if it does,
say so in the same record that claims the host is commissioned — rather than a profile string
implying it does not.

"Production" is therefore not a value of `KF_DEPLOYMENT_PROFILE`. It is the state of a host on
which every commissioning check is satisfied and the evidence is on file.

## The shadow, restated as evidence rather than calendar

Decision 0002 §6 requires:

> shadow LamQuant and KF compilers for 30 consecutive days after strict parity passes. Zero
> unexplained semantic drift is required.

The intent is a drift-observation window. The mechanism is a _count of compilations_, not a
duration: drift can only be observed when something compiles. A quiet month observes nothing
and records that identically to a clean month — "no drift observed" and "nothing was observed"
produce the same log line, which is the failure mode this repository keeps finding in its own
checks.

Thirty days was chosen for a live changing estate. This corpus is three documents.

**Replacement criterion.** Cutover is permitted when all of the following hold:

- each of the three constitution documents in `dogfood/document-constitution.json` has been
  compiled at least **twice**, with byte-identical output across the two runs;
- each of the five document-lifecycle action paths has been exercised at least **once**:
  `request_document_compilation`, `accept_document_compilation`, `record_document_proposal`,
  `apply_document_proposal`, `publish_document_view`;
- **zero unexplained semantic drift** has been observed, unchanged from 0002;
- and at least **7 days** have elapsed.

The day floor is not evidence. It exists so that a burst of activity in one afternoon cannot
satisfy the criterion, because some drift is only visible across a restart, a certificate
rotation or a scheduled job that runs daily.

**This is weaker than thirty days, and here is what is given up.** Thirty days observes
conditions nobody enumerated — a month-boundary job, an expiring token, a log rotation, an
operator doing something unanticipated. The criterion above observes only what it names. It is
accepted because the strict-parity gate precedes it and is the stronger check, because the
corpus is small and fully enumerable, and because the alternative in practice was not thirty
observed days but thirty elapsed ones. If the corpus grows beyond the constitution, this
criterion is no longer adequate and must be revisited before the next cutover.

## Separation of duty on release approval: not achieved

One person is the technical authority, the quality authority and the accepting party for this
release. This is recorded rather than concealed behind three role names.

The consequence is concrete: **a mistaken approval has no second reader.** Everywhere else in
this system separation of duty is enforced by the kernel — a reviewer cannot accept work they
performed, KF-FIN-003 refuses a payment authorization that exceeds its allocations, step-up
authentication gates the acts that matter. None of that applies to the act of approving the
release itself, because there is one person.

Accepted for v1.0 on the basis that the alternative is not a better-reviewed release but no
release. It should not survive contact with a second engineer: the first thing to do when one
exists is to move quality authority or cutover acceptance to them.

## Blockers that gate v1.0

Carried from `docs/deployment/private-host.md`, which remains the authoritative list.
`tests/deployment/commissioning-blockers.test.ts` holds that list and the check registry in
agreement.

Two can never be automated from this repository, and v1.0 requires a person to close them:

- **A person receiving an alert.** `kf-alert@.service` ships and is tested against a real
  HTTPS endpoint, but a webhook URL that is wrong, revoked or pointed at an abandoned channel
  passes every test and reaches nobody. `kf-commissioning --send-test-alert` exists to make
  this one command and one confirmation rather than an open question.
- **Real-provider browser evidence.** The OIDC path is exercised against fixtures. Whether a
  person can complete a login against the real realm is not a question this repository can ask.

## What this record does not settle

- **The licence and any public release.** v1.0 ships private and `UNLICENSED`. Publication is
  a separate decision with its own record.
- **A second operator, or federation between two real deployments.**
- **Whether the thirty-day shadow should return** if the document corpus grows. Flagged above;
  not decided here.
