# v1.0 ships the native document compiler; the Liminal-backed one is deferred

**Status:** accepted
**Date raised:** 2026-08-25
**Date decided:** 2026-08-25
**Decision owner:** technical authority
**Scope:** which document compiler v1.0 runs, what a release must carry, and what
`liminal_runtime_inventory` checks when a release carries no Liminal compiler
**Decision:** a release may carry a Liminal compiler or carry none, and must declare which.
v1.0 declares none. The `PinnedLiminalProcessAdapter` stays in the tree, built and tested,
wired to nothing. [ADR 0002](0002-liminal-backed-document-compiler.md) is not reversed.

---

## What was measured

This was found while trying to build a release tree so a host could be commissioned. The build
could not start. `docs/deployment/private-host.md` refused, by design:

```sh
test -n "${LIMINAL_COMPILER_ARTIFACT:-}" ... || {
  echo 'Liminal compiler, Cargo.lock and runtime closure must be supplied' >&2
  exit 1
}
```

Nothing can supply it. The counts below are counts, not impressions:

| question                                                | measured                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `vendor/liminal` in this repository                     | absent                                                             |
| a Liminal compiler binary anywhere on the build machine | none                                                               |
| Liminal source (`~/Desktop/liminal`)                    | 24 crates, 161 `.rs` files, `version = "0.0.0"`, `publish = false` |
| Liminal files mentioning `kf-document`                  | **0**                                                              |
| Liminal files implementing `--protocol`                 | **0**                                                              |
| what has ever answered `--protocol kf-document-v1`      | a test fake, `liminal-adapter.test.ts:47`                          |

So the protocol KF's adapter speaks is not implemented by the system it speaks to, and the only
counterpart it has ever had is a stub inside its own test.

**That does not make the adapter wrong.** Building an integration against a controlled fake is
the correct way to build one whose counterpart is not ready, and the adapter is careful work:
it verifies the executable's digest before spawning, passes runtime files as pinned descriptors,
sandboxes with bubblewrap, and never executes an unqualified binary. The defect is not in the
code. It is that a **deployment contract** made a component mandatory that no release could
contain.

## What bounds it

The adapter is not on the running path, and this is the fact that makes deferring cheap rather
than a concession:

| symbol                    | callers outside the adapter |
| ------------------------- | --------------------------- |
| `runLiminalCompiler`      | 0                           |
| `compileWithLiminal`      | 0                           |
| `performLiminalPreflight` | 0                           |
| `verifyLiminalExecutable` | 0                           |

Documents compile through `packages/documents/src/compiler/run.ts` — `runCompilation`, exported
via `compiler.ts`. That is the compiler the workbench, the lifecycle actions and the parity
criterion all use today, and it is inside the release tree, covered by `SHA256SUMS` like every
other file.

So **decision 0002's parity criterion is unaffected**. "Each constitution document compiled
twice, byte-identically" is a claim about the compiler that runs, and the compiler that runs is
in the release.

## Why deferring rather than building it

The alternative is to implement `kf-document-v1` in Liminal, cut a release binary, and seal it.
That is the honest end state and it stays the intent. It is not v1.0's business:

- Liminal is `version = "0.0.0"` with `publish = false` and "nothing publishes before Phase 0
  ratifies the constitution", and its own recent history is re-quarantining Phase 1 exit gates.
  Putting KF v1.0 behind it means putting a records system behind another system's roadmap.
- Every open criterion in [ADR 0004](0004-production-release.md) queues behind one commissioned
  host, and criterion 4 carries a 7-day floor that cannot start counting until there is one.
  Days spent here are days added to v1.0 for a component nothing invokes.
- ADR 0002 accepted an **architecture**, not a release. Its own acceptance note says
  "acceptance approves an architecture, not a release". Deferring the artifact is consistent
  with that sentence rather than a retreat from it.

## The check could not simply be relaxed

`liminal_runtime_inventory` is one of the eight commissioning checks. Before this decision the
only reachable states were "sealed and verified" and `unverifiable`, because a release without a
compiler could not be assembled. Making the artifact optional creates a third state, and the
obvious handling of it is the dangerous one: nothing to check, so pass.

**A check that reports success for the absence of its own subject is the precise shape
`unverifiable` was invented to prevent.** This repository has spent more effort deleting checks
that passed for the wrong reason than writing new ones.

So the subject changes rather than weakens. The check now asks whether the release's
**declaration matches what is installed**, which fails in both directions:

| release declares | ships a runtime | verdict                                                      |
| ---------------- | --------------- | ------------------------------------------------------------ |
| `sealed`         | yes             | as before — six pins required, release's own verifier runs   |
| `sealed`         | no              | fails, as before                                             |
| `none`           | no              | satisfied — and it checked something                         |
| `none`           | yes             | **unsatisfied** — an unreviewed compiler is inside a release |
| nothing          | either          | `unverifiable`                                               |

The last row is deliberate. Defaulting an absent declaration to `none` would make every release
built before today silently claim to carry no compiler — including one that carries a real one.
That is the fail-open version, and it is the version an operator would never notice.

The declaration lives in `BUILD-METADATA`, which `SHA256SUMS` already covers, so it is sealed by
the same digest as the rest of the release and cannot be edited on the host without failing
`migrate-release.sh check`. The build refuses a **partial** Liminal environment — all three of
`LIMINAL_COMPILER_ARTIFACT`, `LIMINAL_CARGO_LOCK_ARTIFACT` and `LIMINAL_RUNTIME_FILE_PATHS`, or
none — rather than resolving it, because guessing which half was meant is how a release ends up
sealing something nobody reviewed.

## What v1.0 therefore does not claim

Stated because ADR 0004 exists to stop a true statement reading as a larger one:

- **Not that the Liminal-backed compiler works.** It has never been run. It has been exercised
  against a fake that answers its protocol, which establishes that the adapter behaves as
  designed and nothing about Liminal.
- **Not that the adapter is dead code to be deleted.** It is the built half of an integration
  whose other half is unwritten, and deleting it would throw away the reviewed work.
- **Not that ADR 0002 is reversed.** The architecture stands; the artifact is deferred.

## What this record does not settle

- **When Liminal gets `kf-document-v1`.** It needs a protocol specification first — the
  adapter's expectations are currently expressed only as a test fake, which is a poor
  specification and would be an unfair one to hand to whoever implements the other side.
- **Whether the adapter should be exercised in CI against that fake as a contract test.** It is
  tested today; whether that test is a _contract_ the Liminal side must satisfy is a different
  question, and the answer determines who owns the fake.
- **What happens to `liminal=sealed` releases that predate the declaration.** None exist, so
  nothing is stranded; if one is ever built from an old checkout it reports `unverifiable`,
  which is the right answer.
