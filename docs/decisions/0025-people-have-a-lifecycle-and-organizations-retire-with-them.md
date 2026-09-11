# ADR 0025 — People have a lifecycle, and an organization is retired with its people

- **Status:** accepted, 2026-09-11
- **Supersedes:** nothing. Extends ADR 0011 (organization-scoped authority) and the
  `organization` lifecycle added 2026-09-10.
- **Requirements touched:** KF-SAS-RQ-062 (bootstrap acts extend the chain), §100 gaps on
  organization identity.

## Context

The first retirement of organizations in this repository was done with raw SQL inside the
migration that created the legal-name uniqueness index. It set `org.organization.retired_at`
on nine duplicates and left three things wrong that were found only when the fixture company
was asked to work:

1. `core.object.lifecycle_state` for those nine organizations was still `active`. The update
   that was meant to move it could never have run: the transition guard on `core.object`
   requires an action in context, and a migration has none. So the denormalised column said
   _retired_ and the authoritative column said _active_.
2. Nine people were still `active` inside organizations that no longer existed, because a
   person had no lifecycle at all — R01 approved `person` with states `active, inactive` and
   `state_machine: null`.
3. The `retire_organization` act had never been dispatched. When it was, its effect failed on
   the first statement: it named a column `core.relation` does not have, and the relation it
   tried to record — _successor supersedes retired_ — cannot exist anyway, because a
   `core.relation` needs both ends visible in one organization's row-level scope and a
   successor is by definition another organization.

Separately, the first grant of authority in any organization was impossible: `grant-authority`
required the grantor to already hold a role assignment in the organization, and nobody in a new
organization holds one, including its founder.

## Decision

**A person has a lifecycle between R01's two states.** `deactivate_person` moves
`active → inactive`; `reactivate_person` moves back. No state is invented. Deactivation ends
the person's authority under the same act: live role assignments are end-dated and live
clearances are retired through `org.person_clearance_retirement` (the row the resolver and
`explainAccess` already read) with their interval closed, so the no-overlap constraint does not
refuse the person a later grant. Reactivation restores nothing; authority is re-granted on
purpose, with a fresh reason. A person does not deactivate themself.

**An organization is retired with its people.** A person's object is bound to its organization
by row-level security and cannot move. `retire_organization` therefore refuses while active
people remain unless the act states `with_people: true`, and with it drives each of them to
`inactive` — the ontology declares that transition for this action, so the guard allows it —
and ends their authority as above. "Move them to the successor" was a promise the database
could never keep; it is no longer made.

**The successor is a fact about the retired organization, not a relation.** It is recorded on
`org.organization.succeeded_by` by the act that named it, and in that act's payload. A named
successor must exist and must not itself be retired; the check reads through a definer function
(`org.organization_retirement`) because the successor's rows are invisible from the retiring
organization's scope.

**The founding grant.** `grant-authority` admits one exception to "the grantor exercises a role
in this organization": when the organization holds no live role assignment at all and the
person being granted is the grantor. The founder assigns themself the role first and exercises
that assignment for the clearance that follows, so the act is still recorded under a real
assignment held by the actor in this organization. The action row now records the assignment
as `acting_role_id`; it had recorded the person, contradicting its own comment.

**A bootstrap-tier way to retire an organization nobody can act in.** `kf retire-organization`
runs the act's own precondition and effect on the owner connection, around the two things the
dispatcher would otherwise do — record the act, move the object — and refuses any organization
in which somebody holds a live role assignment, with the instruction to dispatch the act as that
person. It is for the duplicate created by a defect and the organization created in error; it
is not a second way to do what the API does.

**Two roles for external parties.** `customer_contact` and `partner_contact`, because a
customer's contact reading this organization's public documents is a person in this
organization's tenancy, and the ten institutional roles all say something untrue about them.
`grant-authority --role-ceiling` caps the organization-wide grant a role assignment is, so a
contact cleared to `confidential` for their own agreement does not read every confidential
record; object-scoped `grant_access` names the one they may.

## Consequences

- The nine mis-retired organizations on the dogfood host are retired again, this time through
  `kf retire-organization --with-people`, each as a recorded act with a reason and a decider,
  each person made inactive under it. The migration that did it wrong is left as it is: its
  index and column are correct, and the data repair it attempted is superseded by acts.
- Data repairs in migrations are not a pattern. A migration has no action in context and the
  guard is right to refuse it. Repairs go through acts, and where no authority exists to act,
  through a bootstrap-tier command that reuses the act's own atoms.
- The lifecycle test (`tests/database/organization-lifecycle.test.ts`) dispatches every path
  against a real database. It found all three defects above on its first run.
