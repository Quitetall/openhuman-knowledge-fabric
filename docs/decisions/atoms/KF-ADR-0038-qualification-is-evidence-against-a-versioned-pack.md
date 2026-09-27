---
schema: oh.war/atom/v1
adr_uuid: dbf1bd1a-2428-59c6-9e56-49c4e19678aa
local_alias: KF-ADR-0038
role: adr
jurisdiction: bound
order: 30
classification: public
status: proposed
decided: 2026-09-26
---

# ADR KF-0038: Qualification is evidence against a versioned pack, and onboarding is its first use

- **Status:** proposed 2026-09-26
- **Decision owner:** technical authority
- **Scope:** how the Fabric records that a person is ready to contribute within a named scope,
  how that readiness is established, kept current and consulted
- **Builds on:** [ADR 0016](KF-ADR-0016-access-is-a-grant.md) (grants),
  [ADR 0019](KF-ADR-0019-warrants-as-institutional-record.md) (warrants),
  [ADR 0020](KF-ADR-0020-service-actors.md), [ADR 0027](KF-ADR-0027-access-is-a-grant-on-every-read.md),
  [ADR 0033](KF-ADR-0033-the-database-binds-the-principal.md) (authority checked in the database),
  [ADR 0036](KF-ADR-0036-delegation-is-one-level-and-assignments-expire.md) (assignments end)

## Context

Bringing a person into the organization — so that they can contribute correctly and within
bounds — was the reason the Fabric exists, and nothing in it models it. The ontology knows people,
engagements, role assignments, grants, controlled documents, warrants and evidence. It can say what
a person _may_ do. It cannot say what a person has shown they are _ready_ to do, against which
requirements, on what evidence, or what they are missing after a procedure changes.

The only qualification the Fabric records is a supplier's (`prospective → qualified | conditional →
disqualified`, with `qualified_until`). Nothing comparable exists for a person.

Onboarding systems usually fail in one of three directions. One is a role-specific checklist per
job title, forked for each new role until nobody maintains any of them. Another is reading
certified as competence: "I opened the document" recorded as "I can do the procedure". The third
is a second bureaucracy of approvals, surveys and reports laid over the work instead of drawn from
it.

The shape adopted here is the common part of five mature systems, each taken for what it does well:

- the DOE Technical Qualification Program: a common base, then functional, then local requirements;
- the Navy's Personnel Qualification Standards: qualification is demonstrated ability, not
  attendance;
- FEMA's Position Task Books: a position's requirements, evidenced by observed tasks and accepted
  by an evaluator;
- GitLab's handbook onboarding: onboarding runs in the ordinary work system, with role content
  injected;
- ISO 10015: competence is maintained, not conferred once.

It keeps none of their paperwork.

## Decision

1. **One protocol; roles are data.** Every person, in every role, follows the same five stages:
   **Read-In** (what have I joined), **Role Read-In** (what is my place in it), **References**
   (where does authoritative truth live), **Execution** (how does work move here), **First
   Contribution** (bounded, useful work through the normal system). Stages are sections, not
   waiting rooms: only a genuine prerequisite orders them. No evaluator, route, view or policy
   branches on a role or job title; a role differs only in its pack.

2. **Qualification is the primitive; onboarding is its first use.** The same mechanism serves:
   - a new hire (initial qualification);
   - a promotion or transfer (the missing requirements only);
   - a procedure change (the affected people, for the changed requirement only);
   - a return after absence;
   - a narrow contractor scope.

   There is no separate onboarding workflow.

3. **Two new record types, and nothing else new.**
   - A **qualification pack** is a controlled, versioned declaration of requirements for a scope.
     It is assembled from a common part, a role part and any scope part, with duplicates
     satisfied once. Composition is an explicit list: no inheritance language and no scripts. It
     references resources by identifier and revision and never copies them. Approving a pack is
     an institutional act.
   - A **qualification record** holds one person's qualification for one scope:
     - the exact pack revision assigned;
     - per requirement, the evidence credited and who credited it;
     - the acceptance decision;
     - its supersession or withdrawal history.

     It has a state machine in the pattern of the supplier's.

   Person, engagement, role assignment, grants, documents, artifacts, test executions, decisions
   and warrants already exist and are referenced, not duplicated.

4. **Requirements are what is checked, not documents.** A requirement states the outcome that must
   be true, the scope, the resources that help, the evidence that counts and who may accept it. A
   document is a resource; opening it establishes nothing unless the requirement says
   acknowledgement is the outcome.

5. **Three evidence modes, never upgraded.**
   - **Acknowledge:** received and reviewed.
   - **Locate:** knows where the authority is and when to use it; usually shown during real work.
   - **Demonstrate:** an accepted artifact or observed action shows it can be done.

   Reading, watching and listening are formats, not modes. Acknowledged is never demonstrated, and
   one task never implies an unrelated one. References carry an authority class (normative,
   reference, learning), and the References stage teaches that hierarchy.

6. **The test is real work, through a warrant.** The execution unit is the **warrant**
   ([ADR 0019](KF-ADR-0019-warrants-as-institutional-record.md)), not the work order. A work order
   authorizes an external party under an engagement and carries commercial acceptance, and
   qualification must not invent a contractor to reuse it. Execution and First Contribution are
   normally one bounded warrant, or another existing record where that is the work (a decision, a
   test execution). One accepted piece of work may evidence several requirements, but the mapping
   is explicit, and an accepted change evidences only what the requirement says it does.

7. **No duplicate approval.** The reviewer who accepts the work, holding the authority the
   requirement names, credits the evidence in the same act. When every requirement is evidenced,
   the record closes under the pack's standing rule. A separate approval exists only where it
   authorizes something different. Evidence already accepted elsewhere is credited against an
   equivalent requirement; a title or a résumé is not evidence.

8. **Qualified, authorized and operational are separate facts.**
   - Employment and appointment remain `engagement` and `role_assignment`.
   - Authority remains grants.
   - Qualification is evidence of readiness.

   An action that genuinely needs a qualification declares it. The database checks it at the moment
   of the act, beside act-grant coverage, as ADR 0033 checks authority. Qualification never grants a
   permission, and a permission never implies a qualification. A refusal names the specific missing
   requirement.

9. **Records are pinned; currency is computed.**
   - A qualification record preserves the pack revision and evidence it was decided on.
   - Whether it still satisfies today's pack is a separate, computed question.
   - A requirement revision declares its **behavioural impact**. Only a revision that changes
     required behaviour creates a gap, and only for the people whose scope it touches.
   - A formatting change, a moved document or a clarification creates none.
   - A missing specialized requirement restricts only the action that needs it; nobody's whole
     qualification resets.
   - Renewal needs a stated reason. There is no calendar reset.

10. **The rules against bureaucracy are rules.**
    - A mandatory requirement names what becomes unsafe, unauthorized or unreliable without it; if
      nothing does, it is optional reading.
    - Initial scope is the minimum needed to start.
    - Each person has one named contact.
    - Every prerequisite, required access and blocker is visible. An unavailable resource or
      reviewer is **blocked on the organization**, never a failure of the person.
    - Waivers cannot turn missing evidence into demonstrated competence. A legitimate scope change
      or a supervised restriction is recorded as what it is.
    - Time on page, forced watch duration and monitoring are not evidence.
    - Normal work updates the record by reference: no second report and no repeated uploads.
    - An assistant may explain, assemble and check that fields are present. It never infers
      competence and never grants anything.

11. **The person's page is a projection.** The five-stage "Start Here" view is generated from the
    record, the pack and the evidence, under the projection rules (§59). It is never edited
    separately. Every status resolves to a requirement and its evidence.

12. **Qualification records are personal.** A record is confidential. The person, their named
    contact and the crediting reviewers read it; others learn only the applicable scope and current
    eligibility, through the ordinary grant path. Public role packs do not make individual records
    public.

13. **Founding authority.** Until the organization appoints otherwise, the technical authority
    approves packs and the acceptance rules in them. This is recorded, not presumed, and
    self-attestation is not presented as independent evaluation.

## Options rejected

- **A separate onboarding platform.** It would duplicate the people, documents, evidence and
  permissions the Fabric already holds, and it would be the second system the Decision exists to
  prevent.
- **Role-specific onboarding flows.** One fork per title, maintained by nobody. A new role must
  need a new pack, not new code.
- **Reusing the work order.** It binds an external party, an engagement and commercial acceptance.
  Qualification through it would fabricate all three.
- **Quizzes as the gate.** A quiz measures recall of the pack, not readiness for the work.
- **Qualification as a permission.** It would let a reading checklist manufacture authority.
- **Retraining on any document change.** A digest change is not a behaviour change, and resetting
  qualification on one teaches people to ignore the system.

## How we will know

These are the acceptance tests of the implementation, each a planted case:

- **A new role:** a pack is added and no code changes.
- **Two packs sharing a requirement:** it is satisfied once.
- **Existing accepted evidence meeting a requirement:** it is credited without repeating the work.
- **A person qualified for the baseline but not for a specialized requirement:** the baseline
  action succeeds; the specialized action is refused, naming the requirement.
- **A mandatory resource that is inaccessible:** the record shows the organization's blocker and
  the contact, not a failure.
- **Every requirement evidenced through accepted work:** the record closes with no second approval.
- **An unrelated document revision:** no status changes.
- **A behavioural revision of one requirement:** exactly the affected people gain exactly that gap.
- **An absent grant:** qualification does not bypass it.

## Consequences

- The ontology gains two types, their relations and state machine, and the acts that assign,
  credit, accept, withdraw and supersede them. The schema pack is re-cut and re-signed.
- Actions may declare a required qualification; the database enforces it where declared and
  nowhere else.
- The first packs are written for the Véracier fixture, a CEO and an aero engineer, so the
  protocol is exercised on data that looks like a company before any real person depends on it.
- Implementation follows the owner's sequence: it is the final stage, after hosting and the
  correctness pass. This record and the specification's requirements come first, so the design
  is reviewed before it is built.
