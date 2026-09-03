# Access is a grant, and a denial is a path

**Status:** accepted — implemented 2026-09-02; builds on ADR 0008, ADR 0011, ADR 0013
**Date raised:** 2026-09-01
**Date decided:** 2026-09-02
**Decision owner:** technical authority
**Scope:** the positive primitive that admits an object into a person's corpus, how the three
existing sources of access are read through it, and how "why can't this person see this" is
answered

## The problem, measured

Before this, a person's permitted set was every object in the organization at or below their
effective classification (`enumeratePermissionSet` selected `core.object where organization_id`
under row-level security), minus subtraction: `content.person_entitlement_exclusion` and
retention holds. Need-to-know existed only as a list of what to take away. Three tables already
said "this person may reach this thing" — `org.role_assignment` (scope, role, ceiling),
`org.project_membership` (project) and `secure_object.capability_issue` (an external opaque
object) — in three shapes that nothing read as one, and none of which the permitted set
consulted. A project-scoped role saw the whole organization; a project membership granted
nothing. And a denial could not be explained without reading five tables by hand.

## Decision

**`org.access_grant` is the positive primitive.** A grant names a principal (a person, or a role
assignment so authority can attach to a role), a capability (`read` — the scope object enters the
principal's permitted set; `act` — the principal may be named as acting authority on it), a
scope object, an optional classification ceiling that never raises the person's clearance, an
effective window, who decided, the recorded act that decided (`granted_by_action` is NOT NULL
and is the reason the two action types exist), an optional delegation parent, and a reason.
Revocation is a state on the row — `revoked_at/by/by_action/reason`, complete or absent — never
a delete: what was permitted, and until when, remains evidence. A GiST exclusion refuses two
live grants of the same capability to the same principal at the same scope over overlapping
windows; a revoked grant no longer blocks a fresh one. A trigger refuses a principal of the
wrong kind, or one from another organization (ADR 0006).

**Scope means the object, or the organization.** The organization itself as scope covers every
object in it — which is what an organization-scoped role has always meant, so every existing
fixture and deployment keeps its corpus unchanged. Any other object covers that object and
nothing transitive: reach through relations is a projection concern (ADR 0014), not an access
one.

**The existing sources are read through one view, not replaced.** `org.effective_access_grant`
presents direct grants, active role assignments (as `read` and `act` at their scope, with their
ceiling), project memberships (as `read` on the project) and secure-object capabilities (as
`read` on an external reference, through a definer function so the application role never
reads the ledger) in one shape. The plan had these tables _becoming_ compatibility views; that
was measured infeasible — `org.role_assignment` is a first-class `core.object` type and the
foreign-key target of `ml.promotion_decision.approver_role_id` and
`ml.metric_stream.acting_role_id` — so the compatibility direction is reversed: the tables stay
authoritative for what they are and the unified surface is the view over them. It is
`security_invoker`, so the caller's row-level security applies underneath.

**The permitted set reads the view.** In both places it is computed (`enumeratePermittedSet`
and master-record compilation) an object must be visible under RLS _and_ covered by a live
`read` grant that reaches the person — directly, or through a role assignment they hold —
whose ceiling, if any, admits the object's classification. Nothing ungranted enters the corpus,
so nothing ungranted is "withheld": it was never permitted. A cleared person with no grant has
an empty corpus.

**A denial is a path.** `explainAccess(person, organization, object)` evaluates the same facts
in the order the permitted set applies them — organization membership, object in organization,
clearance, classification within clearance, grant coverage (naming each covering grant and its
source), entitlement exclusions, retention holds — and names the first failing step as
`deniedBy`. Later steps are still evaluated, because an auditor wants to know a person was both
excluded _and_ ungranted. `GET /objects/:id/access[?person=]` serves it; the asker must be able
to see the object themselves, so asking about a colleague can never reveal a record the asker
has no access to.

**Two action types.** `grant_access` targets the object being made reachable and carries the
principal, capability and optional ceiling and `valid_to` in its payload; an overlapping live
grant surfaces as `precondition_failed`, not a 500, because "already granted" is a fact about
the record. `revoke_access` targets the same scope object and names the grant. Both are owned by
the `authority` group beside `grant_person_clearance`, and both are declared additions to R01.

## What this does not decide

- **Bootstrap.** The first grant in an organization is an organization-scoped role assignment,
  made by the owner-credential path of ADR 0011. There is no `kf:grant-access` command yet; one
  is not needed until an instance has a person who should hold access without holding a role.
- ~~`act` in the dispatcher.~~ Decided 2026-09-02: an action type may declare `requires: act`
  in the ontology (carried to `registry.action_type.requires_capability`). For those — the
  institutional acts: authorize, approve, grant, revoke, allocate, issue, publish, supersede,
  deprecate, annul, make-effective, resolve — the dispatcher requires a live `act` grant
  reaching every target or the organization (`org.act_grant_reaches`, over the same view the
  read side uses), refused as `act_not_granted` (403). An organization-scoped role assignment
  is organization-wide `act`, so every existing flow keeps working; a project-scoped role acts
  only on its project. `explainAccess` takes `capability: 'act'`;
  `GET /objects/:id/access?capability=act` explains it. Other actions stay role-only.
- **Expiry of role assignments and memberships** stays where it was; the view reads their
  windows as they are.
- **Delegation depth and re-delegation policy.** `delegated_from` is recorded; no rule yet
  says how far a delegated grant may go.

## How this is held

`tests/database/access-grants.test.ts` proves, against a real database, that an
organization-scoped role reads as organization-wide `read` and `act` through the view; that a
cleared, ungranted person has an empty permitted set; that one dispatched `grant_access` admits
exactly the granted object, an overlapping grant is refused, and `revoke_access` removes it
leaving the row as evidence; that a principal of the wrong kind is refused before anything is
recorded; that an explanation for an excluded person passes grant coverage and is denied by the
exclusion; and that the route serves the explanation and answers _not found_ for an object the
asker cannot see. The closed preservation inventory (`extended-roundtrip.test.ts`) requires the
new table to be exported, and it is (`access-grants`).
