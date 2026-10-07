---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a4-7fc0-8849-5349ef95a2f0
role: basis
jurisdiction: authored
order: 20
classification: internal
---

# Basis

## The contract

- **ADR 0038**, `docs/decisions/0038-qualification-is-evidence-against-a-versioned-pack.md`
  (proposed; acceptance is the owner's and is a precondition of authorizing this Warrant).
- **SAS §24A** and KF-SAS-RQ-254 to RQ-261, in the proposed revision `0.1.0-draft.9`. They exist in
  §106 already, which is why this manifest can implement them now.
- **ADR 0040** (to be written by KF-WAR-0003) for the parts ADR 0038 does not cover: the invite,
  the agent as guide, and Start Here as the top dashboard panel while a person qualifies. Their
  requirements are added to this manifest when M1 lands.
- **ADR 0019** (Warrants as institutional record): the execution unit is the warrant, not the
  work order.
- **ADR 0033** (the database binds the principal): `requires_qualification` is checked at the
  moment of the act, beside act-grant coverage, the same way.
- KF-SAS-RQ-236: people, role assignments and identity links are created only through the owner
  credential. The invite flow is bounded by it: an invitation can carry a person to sign-in, but
  creating the person, the identity link and the role assignment remain owner-credential acts.

## Existing code this reuses

| Need | Where it already is |
|---|---|
| A state machine with a qualification shape | the `supplier` machine in `ontology/state-machines.yaml` |
| Types, actions, relations | `ontology/object-types.yaml`, `ontology/action-types.yaml`, `ontology/relation-types.yaml` |
| Declaring institutional acts | `ontology/action-types.yaml`, consulted by the database (KF-SAS-RQ-044) |
| Projections | `ontology/projections.yaml`, `packages/projections/src` |
| Warrants as records | `packages/warrants/src` |
| People and roles by the owner credential | `apps/api/src/bootstrap-organization.ts`, `apps/api/src/grant-authority.ts`, `docs/deployment/identity-and-login.md` |
| The fixture company | `fixtures/veracier/README.md` |
| Re-cutting the schema pack | `pnpm ontology:pack`, then the owner's `pnpm ontology:approve` |

## The unknown

How much of Start Here can be a declared projection in the existing closed grammar (KF-SAS-RQ-116)
and how much needs a new projection kind. If it needs a new kind, that is a grammar change with its
own review, not a shortcut inside the page.
