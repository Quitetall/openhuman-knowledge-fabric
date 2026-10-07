---
schema: oh.war/atom/v1
warrant_uuid: 01a114df-fbc0-7b81-a04a-9c99fc062cab
role: intent
jurisdiction: authored
order: 10
classification: internal
---

# Intent

Land everything that is already built and still sitting off `main`, so that every later
milestone in `docs/ROADMAP.md` starts from one tree, and the specification says what that tree
is.

This is milestone **M0, Close-out**. Nothing in it is new design. It is the integration debt of
the hardening, draft.9 and hosting streams, paid once and in order, before M1 starts writing new
requirements on top of a moving base.

## What is already done, and is not this Warrant's work

- **PR #11** (the hardening and draft.9 work) is merged into `main`, together with Codex's draft.9
  implementation. `origin/main` was `6a6419dc` when this Warrant was drafted.
- The plan's "reconcile the `implement/*` branches" item is discharged by that merge.
- **The LAMU engine pin is verified.** KF's `packages/retrieval` suite passes 40 of 40 against
  LAMU `main` at `26923afb`, including all ten tests in
  `packages/retrieval/src/real-engine.test.ts`. The binary was built at
  /mnt/2tb/cargo-target-kf-context/release/lamu with sha256
  `c45c672ff498b6df36dbcff4829c4e480b2e79d2f084e37179f6959d6946e962`, and is staged for the fixture
  stacks at ~/.local/libexec/kf-veracier/lamu.26923afb. The running stacks switch to it at their
  next restart. Recorded here as the evidence for OBL-003, not repeated.

## What remains

1. `host/seaweedfs` lands (SeaweedFS replaces the archived MinIO; SAS §100.40). Another session
   is integrating it now as `integrate/seaweedfs`.
2. `host/offsite-tailnet` lands (B2 off-site copies read back by version, the durable store on
   B2, tailnet TLS). It overlaps Codex's B2 design already on `main`; **Codex's design wins on
   every overlap.**
3. ADR 0039 lands on `main` with them, still `proposed`.
4. The fixture stacks restart onto SeaweedFS and onto the pinned engine.
5. The SAS draft.9 text catches up with what landed, and is re-proposed.
6. The owner-only acts this milestone surfaces are put in front of the owner, not performed.

## What is deliberately not in scope

- **Commissioning.** That is KF-WAR-0001 (M6). This Warrant lands code and documents; it
  produces no host evidence.
- **Anything the UX decisions need.** M1 onwards.
