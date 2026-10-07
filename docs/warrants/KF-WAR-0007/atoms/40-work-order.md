---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a4-7fc0-8849-5349ef95a2f0
role: work_order
jurisdiction: authored
order: 40
classification: internal
---

# Work order

## Deliverables

1. **Ontology.** `qualification_pack` (controlled, versioned; composed by explicit list from a
   common part, a role part and scope parts; resources referenced by identifier and revision,
   never copied; requirements with outcome, scope, evidence mode, mandatory reason and accepting
   authority) and `qualification_record` (one person, one scope, the pinned pack revision, per
   requirement the evidence credited and by whom, the acceptance decision, supersession and
   withdrawal history), their relations, a state machine in the supplier's pattern, and the acts:
   `assign_qualification`, `credit_qualification_evidence`, `accept_qualification`,
   `withdraw_qualification`, `supersede_qualification`. Approving a pack is institutional.
2. **Database.** Migrations for the types; the evidence-mode rule (acknowledge, locate,
   demonstrate; never upgraded); the reviewer who accepts the work credits its evidence in the same
   act; `requires_qualification` as an action-level declaration checked at the moment of the act,
   whose refusal names the missing requirement; qualification records confidential to the person,
   their named contact and the crediting reviewers (ADR 0038, decision 12).
3. **Pack validator.** Refuses a pack with a mandatory requirement that names nothing unsafe,
   unauthorized or unreliable without it (KF-SAS-RQ-260), a composition cycle, or a resource by
   copy instead of by identifier and revision.
4. **Currency is computed.** Only a requirement revision that declares behavioural impact creates
   a gap, for the people whose scope it touches; nothing resets on a calendar.
5. **Start Here**: the five stages (Read-In, Role Read-In, References, Execution, First
   Contribution) generated from the record, the pack and the evidence; every status resolves to a
   requirement and its evidence; an unavailable resource or reviewer shows as the organization's
   blocker with the named contact. It is the top dashboard panel (KF-WAR-0005) while the person
   qualifies.
6. **Invite**: one link per invitation, leading to sign-in and Start Here, within the bound of
   KF-SAS-RQ-236 (the person, identity link and role assignment are owner-credential acts).
7. **Agent guide**: the M4 chat, given the person's Start Here and pack as context, explains,
   assembles and checks fields; it never infers competence and never credits evidence.
8. **The first warrant**: Execution and First Contribution as one bounded Warrant (or another
   existing record where that is the work), whose acceptance credits the mapped requirements.
9. **Fixture packs**: a common part, a CEO pack and an aero-engineer pack for Véracier, and one
   persona of each walked from invite to an accepted record.
10. **ADR 0038's test table as tests**, one planted case per row (see the assurance atom).
11. **Pack re-cut**: `pnpm ontology:pack` for the next schema pack, with the additions declared
    (KF-SAS-RQ-022); the signature is the owner's.

## Owner-only

- Accept ADR 0038 (and ADR 0040's resequencing) before this Warrant is authorized.
- Approve the fixture packs as technical authority (ADR 0038, decision 13), and later every real
  pack.
- Sign the re-cut schema pack (`pnpm ontology:approve`).
- Create real people, identity links and role assignments for the first invitees (owner
  credential).
- Authorize and resolve this Warrant.

## Depends on

KF-WAR-0005 (M3: role presets, the dashboard, Start Here's panel) and KF-WAR-0006 (M4: the chat
the agent guide uses).
