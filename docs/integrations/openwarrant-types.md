# OpenWarrant generated record types

Shared implementation contract: [OW-WAR-0110](https://github.com/Quitetall/OpenWarrant/tree/8d8b81ce/docs/warrants/OW-WAR-0110).
This change implements the KF consumer stage of that contract; it does not create
an independent, diverging Warrant.

`packages/warrants/src/generated/openwarrant/source.json` pins the producer commit.
The adjacent projection manifest records every declaration digest and the source
JSON schema pack digest. Files are copied byte for byte from the producer's
`schemas/typescript` output. Regenerate upstream and replace the whole projection
on upgrades; do not edit or format these files locally. The consumer manifest test
checks artifact membership and bytes. It detects drift, not a malicious rewrite
of both the artifact and manifest; reviewed source identity remains necessary.

The normal `@kf/warrants` build compiles all generated declarations and exports
`OpenWarrantSubmission` and `OpenWarrantDispatch` types. The real submission action
uses a generated field type to constrain its runtime next-action vocabulary.
The exhaustive `Record` makes new or removed producer enum members require an
explicit consumer update. Unknown input still undergoes runtime validation.

KF's action payload is a projection, not a complete portable submission: it
requires `submission_ref` and a next action, and retains blocker/deviation refs.
The portable record may omit its next action. KF deliberately requires one.
Neither types nor this adapter provide whole-document schema validation,
authorization, independent verification, or an assurance mark. Existing action
policy, database constraints, identity and digest checks remain active.

Validation:

- `pnpm exec tsc --build packages/orchestrator` builds the consumer and dependencies.
- `pnpm exec tsc --ignoreConfig --noEmit --strict --target es2023 --module nodenext tests/conformance/openwarrant-types.ts`
  checks public package imports and positive/negative assignment fixtures.
- `pnpm exec vitest run packages/warrants/src/submission-contract.test.ts packages/warrants/src/generated-contract.test.ts tests/database/warrants.test.ts`
  checks vocabulary refusals, projection digests, and actual PostgreSQL action
  behavior. The database case checks rejected submissions leave both lifecycle
  state/version and submission rows unchanged, then accepts a valid submission.

This scope does not establish all OW-WAR-0032 requirements, KF deployment or
release qualification. Those remain separate gates.
