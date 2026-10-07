---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a0-76f3-97a5-dc84fe99ad07
role: work_order
jurisdiction: authored
order: 40
classification: internal
---

# Work order

## Deliverables

1. **Roles as scope presets.** A role carries a declared scope: grants (capability, scope object or
   collection, classification ceiling) that a person holding the role receives. Changing a role's
   preset is an attributed act. The ontology declares the shape; the database holds it.
2. **Role inclusion.** A role may include other roles. Inclusion is a directed acyclic graph:
   the database refuses an inclusion that would close a cycle, by name. A person's effective scope
   is the union over every role reachable from their live assignments. Subsets and supersets are
   just inclusion.
3. **Projected into the one grant view**, by the mechanism the unknown in the basis chose, in a
   migration, with a note appended to ADR 0016. Every row produced from a role preset names its
   path (assignment → role → included role → grant) so the explanation can show it.
4. **Explain-access shows the role path**: the existing access explanation names, for a grant that
   came from a preset, every role on the path from the person's assignment.
5. **The living org overview** as a generated record: compiled from the records it summarises
   (what the organization is, its projects, recent decisions, open risks, who does what), each
   statement linking to its source, compiled per reader under the projection rules. It is visible
   to a reader only through an ordinary grant on it, typically through a role preset.
6. **The master-document page**: the reader's master record rendered as one calm, readable
   document (overview first when in scope, then hand-written documents and records in scope),
   each section from a declared projection, unverified members labelled.
7. **The dashboard**, the home page for every person: panels Overview and master document, Needs
   you (from KF-WAR-0004), Work in flight, Recent record, People and qualification. Each panel
   reads through the API under the reader's grants; a panel with nothing in scope collapses; no
   panel branches on a role.
8. **Typography and density**: a reading-first style (generous measure and line height for
   documents, dense lists only where one scans), and a density switch that makes every view
   extremely compact, remembered per person.
9. **Phone**: dashboard, master document, record reading, one-click verify and quick capture
   (text, photo, voice into an observation) usable at phone width.
10. **§100.42 and §100.43**: an Object View no longer recounts every reader's permitted set after
    any write in the organization, and the master-record reads stop reading the whole manifest;
    measured before and after on the multi fixture with `scripts/latency-bars.mjs`.

## Owner-only

- Accept the ADR 0016 note (or the new ADR) that changes the grant view's sources.
- Define the real organization's first role presets (the fixture presets are the agent's).
- Authorize and resolve this Warrant.

## Depends on

KF-WAR-0003 (M1). Runs in parallel with KF-WAR-0004 (M2); the Needs-you panel is KF-WAR-0004's and
is placed here, not rebuilt.
