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

Roadmap steps 1–9 are implemented. `pnpm gate` passes on a workstation — 112 test files, 1120
tests when this was raised. The last blocker that was missing _code_ rather than host evidence
closed on 2026-08-17 with `kf-alert@.service`. What is left is of a different kind, and the
version number has to say which kind it is.

**This paragraph previously read "Seven CI gates pass", and that was false in a way this record
of all records should not have contained: no CI job has ever run in this repository.** All 38
workflow runs — every run that exists, back to the oldest retained — failed within seconds at
job-start with "The job was not started because recent account payments have failed or your
spending limit needs to be increased". Not one step executed. The seven gates have only ever been
enforced by a person running them on one machine.

That does not make the tests less green; `pnpm gate` really does pass, and the parity test really
does hold the local command to `ci.yml`. It made the enforcement imaginary. Every guarantee in
this repository that ended "and CI checks it" ended at a workstation instead, including the secret
scan, which by construction cannot be run locally by everyone. Corrected 2026-08-17. The
consequences are criterion 1 and the new criterion 5.

**Billing was restored on 2026-08-18 and CI passed the same day** — run `32146924053` at commit
`93e5b6c4`, four jobs green in 6.8 minutes. It took six runs, and the five failures in between are
the real content of this amendment: the runner did not satisfy bubblewrap's namespace
requirements, a PostgreSQL 18 client, `/usr/bin/node`, or pandoc. Four of those are named in
`docs/deployment/private-host.md` as host requirements and had never once been checked against a
machine. Pandoc was named nowhere at all, and a host commissioned strictly by that document would
have answered every document import with HTTP 500.

So the enforcement was imaginary in a second sense nobody had stated: not only was no gate
running, but the environment the gates assume had never been described completely enough for
another machine to reproduce. `pnpm gate` was green here for the life of the repository because
this workstation happened to have five things, not because the contract asked for them.

The risk this record exists to prevent is a familiar one in this repository: a true statement
that reads as a larger one. "Knowledge Fabric v1.0" would be read by almost anyone as "this is
running and holding records". If it were tagged today it would mean "the software is finished
and nothing has ever been deployed", and nothing in a version number distinguishes those.

## What was measured

```
pnpm gate                    exit 0 — 112 files, 1120 passed, 4 skipped
gh run list (2026-08-17)     38 runs, 38 failed, 0 succeeded — no job ever started
gh run 32146924053           SUCCESS, 4/4 jobs, 6.8 min — first green run, 2026-08-18
pnpm ontology:verify (2026-08-17)  release/knowledge-fabric-1.0.0-draft.2 → DRAFT, exit 1
pnpm ontology:verify --key         same package → APPROVED, signed 2026-08-19
kf-commissioning             never run against a host
deployment profiles          development | dogfood        (no `production`)
known blockers               7, of which 4 have no automated check
```

The second and third lines are the ones that changed what this record says. The 38 failures were
measured after the workflows were hardened on 2026-08-17 and were not what anyone expected: a
billing state on the GitHub account, not a defect in the workflows, predating every change made
that day. A workflow that cannot start is indistinguishable, in a repository's own documentation,
from one that starts and passes — which is why both lines are measured here rather than assumed
anywhere.

The third line does NOT discharge criterion 5, which asks for a green run on the TAGGED commit;
nothing is tagged. What it establishes is narrower and was previously unknown: that these gates
CAN pass on a machine nobody configured by hand.

Nothing has been commissioned on any host. Every deployment artifact in this repository — units,
templates, verifiers, the migration runner, the rollback contract — is an input to
commissioning, not evidence of it.

## What v1.0 claims

1. The software is complete against roadmap steps 1–9 and every gate `ci.yml` defines passes
   from a clean checkout — **in CI, on the commit being tagged**, not only on the workstation that
   wrote it. See criterion 5, which exists because that distinction turned out to be load-bearing
   rather than pedantic.
2. **MET on 2026-08-19.** The R01 schema pack `1.0.0-draft.2` has been approved and signed by
   Brian Lam (Technical Authority), key `release-1`, accepting all three recorded gaps.

   ```sh
   pnpm ontology:verify release/knowledge-fabric-1.0.0-draft.2 \
     --key ontology/release-keys/release-1.pub      # 9 file(s) checked — APPROVED
   ```

   **The `--key` is not optional and this criterion used to omit it.** It read "so
   `pnpm ontology:verify` reports `APPROVED`", which describes a command that cannot produce
   that result: without a public key the verifier reports "signed with 'release-1', for which
   no public key was supplied". `approval.ts` is explicit that approval "is a claim about a
   signature that verifies, not about a file", so an approval nobody can check is not one. The
   public key is committed at `ontology/release-keys/release-1.pub` for exactly that reason.

   **The signed package itself is NOT in this repository.** `/release/` is gitignored, so
   `approval.json` — the only copy of the signature — lives on the workstation that produced
   it. Re-signing would produce a different `approved_at`, and `approve` refuses to overwrite
   an existing approval, so this artifact is not reproducible, only re-creatable as a
   different record. Where signed packages live is an open decision; until it is taken, that
   file is a single point of loss.

3. **One host has been commissioned**, and `kf-commissioning` reports every check `satisfied`.
   Not `unverifiable` — a check that could not run is not a check that passed, which is why
   that status exists and why it fails the gate.
4. The document-compiler parity criterion below has been met and cutover accepted.
5. **A CI run has actually executed and passed on the tagged commit.** Added 2026-08-17, when the
   run history was checked for the first time and found to be 38 failures out of 38, none of which
   started a job. The workflow existing is not the gate; a green run is.

   **Still open, and no longer for the reason it was written.** Billing was restored on
   2026-08-18 and CI now passes on `main` (run `32146924053`). That answers the question the
   criterion was really asking — whether these gates can pass anywhere but the workstation — and
   it does not satisfy the criterion, which says _tagged commit_. Nothing is tagged.

   It is a v1.0 criterion rather than a nice-to-have because of what the other criteria rest on.
   The secret scan cannot be run locally by everyone and is CI-only by design; the SBOM is
   produced by `release.yml` on tag, and **`release.yml` has still never run**, because it
   triggers on `v*` tags only. The first tag is therefore the first execution of the release
   path: the SBOM step, the create-if-absent release and the `--verify-tag` refusal are all
   unproven on a runner, exercised only locally against a bare repository.

   Six runs on 2026-08-18 turned up five unsatisfied host requirements, four documented and
   unchecked, one undocumented entirely. Expect the first tag to find something too, and prefer
   finding it on a tag that can be deleted over one that has been published.

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

- **Any public release.** Publication is a separate decision. The mechanism exists —
  `scripts/publish-public.sh`, which publishes one squashed commit into a repository that shares
  no history with this one — and it has been exercised against a local bare repository, but no
  release has been published and the decision to publish one has not been taken here.

  > **SUPERSEDED 2026-08-21 by [ADR 0005](0005-apache-2-0-licence.md).** The licence is now
  > Apache-2.0, not BUSL-1.1. The paragraph below is left standing as the record of what was
  > decided at the time and is no longer a description of the repository. The BUSL choice was
  > never published — the repository was private for its entire duration — so no version was
  > distributed under it. Nothing else in this ADR is affected.

  **The licence half of this bullet is now settled and the bullet was corrected on 2026-08-17.**
  It read "v1.0 ships private and `UNLICENSED`", which stopped being true when the decision owner
  chose BUSL-1.1 with Licensor "OpenHuman Technologies LLC" and a Change Date of 2030-08-17,
  converting to Apache-2.0. `LICENSE` carries all five parameters — Licensor, Licensed Work,
  Additional Use Grant, Change Date, Change License — and `package.json` agrees. Shipping
  private and shipping unlicensed are different things: v1.0 still ships private, and it is no
  longer unlicensed.

  The Licensor's registered name was open for one commit — `LICENSE` said "OpenHuman
  Technologies" and `README.md` said "OpenHuman Technologies LLC" — and was confirmed as
  **OpenHuman Technologies LLC** on 2026-08-17. The repository had in fact already answered it
  wherever the name appears as DATA rather than prose: the dogfood bootstrap, the database
  harness and the R01 golden conformance fixture all seed `legal_name` "OpenHuman Technologies
  LLC". Worth recording as a method, not just an outcome — when a name is written two ways, the
  fixtures are usually the ones that had to be right.

- **A second operator, or federation between two real deployments.**
- **Whether the thirty-day shadow should return** if the document corpus grows. Flagged above;
  not decided here.
