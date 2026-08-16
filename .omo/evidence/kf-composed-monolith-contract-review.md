# KF composed-monolith contract review

Review scope: current working tree for verified violations of the proposed KF
runtime dogfood, Liminal compiler, LamQuant compatibility, secure-object and ML
authority contracts.

Review mode: read-only contract review. No implementation fixes were made.

## Skill perspective

The requested `remove-ai-slops` and `programming` skill files were unavailable:

- `/home/brianklam/.agents/skills/remove-ai-slops/SKILL.md` was not present.
- `/home/brianklam/.agents/skills/programming/SKILL.md` was not present.

I applied the documented criteria from the prompt instead: no brittle/overfit
test claims as contract evidence, no implementation-mirroring tests as proof,
no unbounded generic mutation surface, no unnecessary parsing/normalization at
authority boundaries.

## Graphify

`graphify-out/GRAPH_REPORT.md` was required by repo instruction but is absent
from `/mnt/4tb/openhuman-knowledge-fabric`; `find` also returned no matching
graph report in the target repo. This review therefore used the ADR/runtime
contract documents and current source files directly.

## CRITICAL

None.

## HIGH

None.

## MEDIUM

None.

## LOW

None.

## Contract checks

- No current-code path was found that signs or fabricates R01 approval, allocates
  an enterprise identifier, or decides `0001-r01-schema-pack-defects.md`.
- Dogfood and document import paths preserve the draft/fabric-native boundary
  and do not create approval, effectivity or source-holder transfer authority.
- `dogfood` profile documentation and API/web configuration now require OIDC
  identity plus KF database role assignment; fixed identity remains scoped to
  development/non-authoritative use.
- Liminal compiler integration remains draft-only before qualification and is
  pinned through a registered process adapter boundary rather than direct crate
  authority.
- AI proposal paths keep model output derived until a human-authorized typed
  action applies it; no provider or model becomes authoritative.
- Secure-object and ML contracts keep KF as registry/provenance/promotion
  authority while protected bytes, private keys and locators stay outside KF.
- External gates remain explicit: real Liminal `kf-document-v1`, real Keycloak
  dogfood proof, real LamQuant compatibility corpus, publication commissioning,
  and shadow/cutover are not claimed complete.

## Evidence

- `git rev-parse --show-toplevel && git status --short --branch`
- `docs/architecture/runtime-dogfood-contract.md`
- `docs/decisions/0002-liminal-backed-document-compiler.md`
- `docs/architecture/federated-ml-secure-object-contract.md`
- `docs/deployment/local-development.md`
- Focused review of dogfood/import/compiler/proposal/publication/secure-object
  source paths and migration guards.

## Non-contract risk

Prior full Vitest evidence showed one load-sensitive timing assertion in
`packages/documents/src/liminal-adapter.test.ts` failing under the full suite
while passing isolated. That is a gate-stability risk, not a verified violation
of the KF authority contracts reviewed here.

codeQualityStatus: CLEAR
recommendation: APPROVE
reportPath: `.omo/evidence/kf-composed-monolith-contract-review.md`
blockers: none
