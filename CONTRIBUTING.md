# Contributing

## The gate

```sh
pnpm install --frozen-lockfile
pnpm gate
```

`pnpm gate` runs every check CI runs **except one**, in CI's order, fail-fast. It is the claim of
green that counts locally, and `tests/deployment/gate-parity.test.ts` asserts that it and
`.github/workflows/ci.yml` name the same commands in both directions — so a check added to CI and
not to `gate` fails the suite rather than waiting to fail on somebody's push.

The exception is the `secrets` job: gitleaks over full history. It is CI-only because the scan
needs a binary that is not installed on every machine, and a gate step that quietly does nothing
when its tool is missing is worse than no step. The same test pins the list of CI jobs that run no
pnpm command, so a second CI-only gate cannot be added without a decision. (This section
previously said `pnpm gate` runs _every_ check CI runs. That stopped being true when the secrets
job landed, which is precisely the drift the test was written to catch — and it caught it in the
commit that introduced it.)

> **Pull requests run on GitHub-hosted `ubuntu-latest`; every other event runs on
> `vars.RUNNER_LABEL`, falling back to `ubuntu-latest` when it is unset.** The self-hosted runner
> in use since 2026-08-20 is a sandboxed one on the maintainer's machine; `runs-on` reads the
> `RUNNER_LABEL` repository variable, so moving between them is a settings change and not a
> commit — see `deploy/self-hosted-runner/` and `.github/workflows/ci.yml`.
>
> This block has now been wrong twice, in opposite directions. It first said "CI is not running
> at all", which was true — 38 runs died at job-start on Actions billing. Then it said CI passed
> for the first time on 2026-08-18 (run `32146924053`, commit `93e5b6c4`), which was also true,
> and then stopped being true on 2026-08-20 when billing failed again and four more jobs died
> the same way. Four commits carried a green local gate and no CI at all before anyone noticed.
>
> **A green run is not evidence CI is running.** Check that the run you are looking at is recent
> and that its jobs executed steps rather than dying at job-start in two seconds.
>
> What the first real runs found is worth knowing before you trust a green `pnpm gate`. Five host
> requirements were unsatisfied on the runner — bubblewrap, unprivileged user namespaces, a
> PostgreSQL 18 client, `/usr/bin/node`, and pandoc. Four were named in
> `docs/deployment/private-host.md` and had never been checked against a machine; pandoc was
> written down nowhere. The suite had been green here throughout, on a workstation that happened
> to have all five. If your `pnpm gate` is green and CI is not, suspect your machine has something
> the contract never asked for — that is the failure mode this repository has now hit five times
> in one day.

That test exists because the gate was wrong. Three checks were run locally for a week under
"gates green" while `format:check` failed, and the list of gates was assembled from memory
rather than from `ci.yml`. Run `pnpm gate`.

For the inner loop, `pnpm gate:fast` skips the suite and the build — everything that does not
start a container. It is not a substitute; it is for the thirty seconds between edits.

## The pre-commit hook

`pnpm install` installs a husky hook that runs `prettier --write` and `eslint --fix` **on staged
files only**, and re-stages what it changed. It takes a second or two.

It is deliberately not the gate. The suite starts a real PostgreSQL, so a hook that ran it would
cost minutes per commit, and a hook that costs minutes gets bypassed with `--no-verify` — at
which point the repository reads as if it has a hook and does not have one.

So be clear about what a clean commit proves: formatting and lint, nothing else. Not types, not
tests, not that `generated/` is current, and **not secrets** — the gitleaks scan is a CI gate over
full history rather than a local one, because it is not installed on every machine and a scan
that silently does nothing when its binary is missing is worse than an absent one.

`git commit --no-verify` is the honest way to skip it when the rewriting is unwanted.

## Requirements

Node 24.18.1 (the exact version; `package.json` pins the range), pnpm 11, Docker with Compose
v2. The test suite starts a real PostgreSQL 18 through Testcontainers rather than mocking the
database, because the guarantees under test — row-level security, append-only triggers,
exclusion constraints, `for update` locking — do not exist in a fake, and a test against a fake
would report that they hold when nobody had checked.

Some things are deliberately not in `pnpm test`:

|                                                                        |                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `KF_MEASURE_RLS=1 npx vitest run tests/database/rls-read-cost.test.ts` | Populates ~108k rows and measures row-level-security read cost. Minutes, not seconds. |

## What a commit needs

**Say what you measured.** The commit messages in this repository record numbers, the command
that produced them, and what was ruled out. That is not decoration: several defects here were
found because an earlier message stated a measurement precisely enough to be checked and it did
not hold. A message that cannot say what it measured usually means the change has not been
measured.

**A guard must be able to fail.** If you add a check, break the thing it checks and confirm it
reports the failure by name, then restore. This has caught real bugs in checks in this
repository more than once — including two written the same day, which passed against the case
they were written for and were blind to the case that mattered.

**State the limits of what you added.** Every check here says what it does _not_ cover, in the
file. `docs-references.test.ts` verifies a citation resolves and says it cannot verify the
cited file supports the claim. That sentence is the useful part.

**Gaps are recorded, never marked.** There is no inline `TODO`-style marker anywhere in this
repository, and a gate keeps it that way (KF-SAS-RQ-018): ESLint's `no-warning-comments` for
everything ESLint reads, and `tests/conformance/no-inline-markers.test.ts` for the files it does
not (SQL, shell, systemd, config, YAML, TOML). A known gap goes in SAS §100, an ADR, a pack
`known_gaps` entry or a named checker warning — somewhere a reader will find it and a gate can
count it.

**Corrections belong in the record.** When something in this repository turns out to be wrong,
the fix says so and says what was wrong. Several documents carry a paragraph beginning "this
previously read…". Do not quietly improve a false claim into a true one.

## Decisions

Architectural decisions live in `docs/decisions/` and follow the shape of the existing records:
status, date, owner, scope, decision — then what was measured, the options, and what the record
explicitly does **not** settle. Raise one when a choice would otherwise be discoverable only by
reading a diff.

From ADR 0034 on, two sections are required by name, because they are the two a later reader
cannot reconstruct: `## Options rejected` (what else was on the table and what killed it) and
`## How we will know` (the measurement that would show the decision was wrong). Records before
0034 are grandfathered — they state the same things under other headings or not at all, and a
decision record is never rewritten to satisfy a later rule. A superseded record is kept in full.
`tests/conformance/decision-records.test.ts` enforces both (KF-SAS-RQ-182).

## The specification

`docs/sas/KF_Software_Architecture_Specification.md` is governed by digest. Editing it is
proposing a new revision (`war sas propose`); accepting one is the owner's act and no automation
performs it. `tests/conformance/sas-governance.test.ts` holds the parts a test can
(KF-SAS-RQ-180, RQ-183): the file's sha256 equals the newest revision's recorded digest; revisions
form one predecessor chain and only the newest may be proposed; accepted digests match a frozen
table and, where git history is present, a committed version of the document; each acceptance
names a human; requirement identifiers only ever grow from one revision to the next; and the
newest revision, the §106 index and the inline statements name the same set.

An accepted revision needs a signed `oh.war/sas-acceptance-response/v1` under
`docs/authority/responses/` — or an entry in `docs/sas/owner-pending.json`, which names the
subject, the rule, the one file, who it waits on, why, and a `recorded` and `review_by` date. The
test requires that list to equal the unsigned acceptances exactly, so an entry cannot outlive what
it excuses. Adding an entry records that the owner owes an act; it never performs the act.

A requirement cited from another repository is an unverified claim until a tool resolves it
(KF-SAS-RQ-184). `node scripts/resolve-sas-citations.mjs <file-or-dir>...` is that tool: it
resolves every `KF-SAS-RQ-nnn` (bare or `sas://`) against `docs/sas/generated/NORMATIVE.json`,
names the revision and digest it resolved against, reports retired and unresolved citations by
file and line, and exits 1 on any unresolved one — and 3, not 0, when it found no citation at
all. `tests/conformance/resolve-sas-citations.test.ts` runs it on fixtures and on this
repository's own ADRs and Warrants.

## What is not yours to do

Some acts are reserved to a named human and no automation performs them:

- approving and signing a schema pack;
- allocating an identifier;
- accepting a document, transferring a Source Holder, releasing a regulated model;
- accepting cutover.

`docs/architecture/composed-monolith-roadmap.md` lists these under "Human-only actions". A
change that makes one of them automatic is a change to the authority model, not a convenience.
