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

> **CI is not running at all, as of 2026-08-17.** All 38 workflow runs in this repository's
> history failed at job-start — "recent account payments have failed or your spending limit needs
> to be increased" — so no step has ever executed on a runner. `pnpm gate` on your machine is
> currently the _only_ thing enforcing any of this, and the `secrets` job in particular has never
> run anywhere. Until billing is restored, read every "CI checks it" in this repository as "CI
> would check it". `docs/decisions/0004-production-release.md` criterion 5 makes a green run a
> condition of v1.0 for this reason.

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

**Corrections belong in the record.** When something in this repository turns out to be wrong,
the fix says so and says what was wrong. Several documents carry a paragraph beginning "this
previously read…". Do not quietly improve a false claim into a true one.

## Decisions

Architectural decisions live in `docs/decisions/` and follow the shape of the existing four:
status, date, owner, scope, decision — then what was measured, the options, and what the record
explicitly does **not** settle. Raise one when a choice would otherwise be discoverable only by
reading a diff.

## What is not yours to do

Some acts are reserved to a named human and no automation performs them:

- approving and signing a schema pack;
- allocating an identifier;
- accepting a document, transferring a Source Holder, releasing a regulated model;
- accepting cutover.

`docs/architecture/composed-monolith-roadmap.md` lists these under "Human-only actions". A
change that makes one of them automatic is a change to the authority model, not a convenience.
