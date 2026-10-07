---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a4-7fc0-8849-5349ef95a2f0
role: intent
jurisdiction: authored
order: 10
classification: internal
---

# Intent

Make joining work: a person is invited, granted the scope their role needs, and qualifies by doing
one real piece of work through the same record everyone else uses, guided by the agent. Target, in
the owner's words (Q6): understand the project in the first hour, a first accepted contribution on
the first day.

This is milestone **M5, Joining**. It builds what ADR 0038 and SAS §24A specify and nothing
in the ontology, database or code holds today (SAS §100.41):

- two record types, `qualification_pack` and `qualification_record`, with their state machine and
  the acts that assign, credit evidence, accept, withdraw and supersede;
- a pack validator;
- the **Start Here** page as a projection, never edited;
- the **invite** flow, from link to signed-in person with a role;
- the **agent guide**: the M4 chat pointed at the person's Start Here;
- the **first warrant**: Execution and First Contribution as one bounded Warrant;
- `requires_qualification` as a precondition an action may declare, checked by the database;
- the first packs, on the Véracier fixture: a CEO and an aero engineer;
- ADR 0038's "How we will know" table, every row a planted test.

## Sequence

ADR 0038 places this build last, after hosting and the correctness pass. The owner's answer to Q15
puts Start Here and qualification among what must exist before his friends join, so the roadmap
orders M5 before the host (M6) and the owner pass (M7). KF-WAR-0003's ADR 0040 records that
resequencing; this Warrant does not start before it does.

## What is deliberately not in scope

- Packs for real people in the real organization. Those are the owner's to approve once the
  mechanism exists.
- Any qualification that grants access. Qualification grants nothing (KF-SAS-RQ-258).
