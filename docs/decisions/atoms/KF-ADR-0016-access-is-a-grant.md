---
schema: oh.war/atom/v1
adr_uuid: b879123b-a0a1-5378-9911-705d5aa2eb7d
local_alias: KF-ADR-0016
role: adr
jurisdiction: bound
order: 30
classification: public
status: accepted
decided: 2026-09-02
---

# ADR KF-0016: Access is a grant, and a denial is a path

**Status:** accepted — implemented 2026-09-02; builds on ADR 0008, ADR 0011, ADR 0013
**Date raised:** 2026-09-01
**Date decided:** 2026-09-02
**Decision owner:** technical authority
**Scope:** the positive primitive that admits an object into a person's corpus, how the three
existing sources of access are read through it, and how "why can't this person see this" is
answered

> **UPDATED 2026-09-24.** The `requires: act` rule below is now also enforced by the database: a
> trigger on `core.action` asks `org.act_grant_reaches` the dispatcher's question and refuses a
> service actor outright (`20260924000100_the_database_checks_act_authority.sql`).
>
> **UPDATED 2026-09-25.** The explanation now walks every bar the dispatcher applies, not only the
> grant path (KF-SAS-RQ-042). A `principal_kind` step follows organization membership: for `act`
> it fails for a service actor (ADR 0020), whatever grants reach it, and the explanation then
> ends `deniedBy: 'service_actor'` — the fact that decided, not the name of the question. Given
> an action type (`explainAccess({ actionType })`, `GET /objects/:id/access?capability=act&action=`),
> a `separation_of_duty` step follows grant coverage wherever the dispatcher's separation-of-duty
> rule covers that action and the object's type, and fails when the person created the record
> (`deniedBy: 'separation_of_duty'`). For `read` the principal-kind step passes: a service actor
> reads like anyone.
>
> **UPDATED 2026-10-07 — proposed; the owner's acceptance is owed (KF-WAR-0005 STAGE-007).** The
> view has a fifth source. A role is a composable preset of scope ([ADR 0040](KF-ADR-0040-the-experience-scope-is-the-product.md)
> decision 4, KF-SAS-RQ-269): `org.role_preset_grant` holds what holding a role in an organization
> grants — a capability at a scope object, the scope an access grant has, with an optional ceiling
> — and `org.role_inclusion` lets one role include another, a directed acyclic graph the database
> keeps acyclic (`20261007200000`). `org.effective_access_grant` presents, as source `role_preset`,
> every template of every role reachable from each live, active, organization-scoped assignment,
> one row per person, capability and scope (KF-SAS-RQ-040), with the role path in a new last
> column `role_path`; the permitted set, every read surface and `org.act_grant_reaches` read it
> unchanged, and the explanation's grant-coverage step names the path (KF-SAS-RQ-270). The four
> acts that change a preset are institutional and must target the organization. Inclusion composes
> scope only: it confers no authority (`org.holds_role` is unchanged) and no delegation (ADR 0036),
> and the session ceiling stays the clearance.
>
> The preset is **recomputed on read, not materialized** into `org.access_grant`. Measured on a
> workstation against the multi fixture's EnterpriseRAG-Bench organization (50 311 records),
> through the real paths (`scripts/scope-preset-cost.mjs`), 2 000 templates at the end of a
> three-role inclusion chain against the same 2 000 documents granted directly: the coverage read
> costs 14.5 ms (recomputed) and 14.6 ms (materialized) at the median; `GET /dashboard` and
> `GET /master-document` answer in 150–260 ms and 125–180 ms at the median either way. The write
> decides it: a template is one act for every holder (9.6 ms each), where materializing costs one
> act per holder per template (3.9 ms each) on every preset change, and a materialized grant to a
> person who already holds a direct grant on the same scope collides on `access_grant_no_overlap`.
> One finding: right after a bulk change, before `org.role_preset_grant` has statistics, the
> planner joined every assignment envelope to every template (80 ms per read); autovacuum's analyze
> restores the 14 ms plan.

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
