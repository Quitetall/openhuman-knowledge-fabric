# ADR 0029 — Transient observations are a third category of stored thing, and expiry only counts if every copy expires

- **Status:** proposed, 2026-09-14
- **Extends:** ADR 0016 (access is a grant), ADR 0024 (friction is an architectural property).
- **Bears on:** Law 6 (retire by sequester, never delete), §55 preservation export,
  §62 the master-record boundary, §88 backup and restore, §89 checkpoints.

## Context

A manager cannot tell which records would be most useful if they were shared more widely.
The signal exists — people search for things they cannot reach — and nothing captures it.
The proposal was to record queries, let an executive re-run one at their own clearance, and
see whether the search wanted material the original asker could not see.

The instinct is right and the mechanism is structurally necessary rather than incidental.
Under ADR 0028 a masked slot is never scored, so the original query genuinely cannot know
whether a withheld record would have ranked. Only an unmasked run can answer that, and only
somebody cleared for the records may perform one. A replay is the only thing that works.

**But it inverts the threat model.** The results of the replay are fine — the executive sees
only what they are cleared for. What is new is that the system would durably hold _what people
were trying to find out_, and a query log is frequently more revealing than the documents it
searched. It is a fresh high-value target that did not previously exist.

**And it collides with a law.** Law 6 retires by sequester and never deletes. A permanent,
unforgettable record of every search anyone ever ran is a surveillance artifact by construction,
and it belongs to the same family as the health information, bank details and payroll secrets
§8 already refuses. Carving an exception into Law 6 for this would be the wrong repair: the law
is right, and the mistake is treating a query as a record.

**KF has two categories of stored thing and needs a third.** Records are authoritative and
governed by Law 6. Derived projections — `search.document`, the retrieval index — are not
authoritative and are rebuildable, so losing one costs a rebuild. A query log is neither. It is
not authoritative, and it cannot be recomputed from anything, because it observes something that
happened once. Without a name for that category, a later reader infers that anything outside
`core.object` is rebuildable, writes a restore procedure on that assumption, and silently loses
what was never recoverable.

## Decision

**A third category exists and is named: the transient observation.** Not authoritative, not
rebuildable, and expected to expire. Losing one is the intended behaviour rather than a fault,
and no restore procedure may treat it as recoverable.

|                       | Authoritative | Rebuildable | On loss              |
| --------------------- | ------------- | ----------- | -------------------- |
| Record                | yes           | —           | Law 6; never deleted |
| Derived projection    | no            | yes         | rebuild it           |
| Transient observation | no            | **no**      | expected             |

**Raw queries are transient observations, not records.** They are declared in §70 alongside the
other things KF refuses to be the authority for. Law 6 is untouched, because a query was never a
record to begin with.

**Expiry only counts if every copy expires.** A sweeper that deletes the rows while another
mechanism retains them is decorative. A transient observation is therefore excluded from four
places, and missing any one of them makes the guarantee false:

- the preservation export (§55, §78), whose retention is explicitly unbounded and which would
  otherwise keep every query forever by the back door;
- the master-record boundary (§62), classified as excluded rather than incidentally absent;
- checkpoint coverage (§89), which signs state and would pin it cryptographically;
- backup retention (§88), which must not outlive the window.

**Ninety days by default**, configurable downward with a stated floor below which the aggregate
stops being meaningful.

**The demand signal and the query log are different artifacts.** Conflating them is what turns a
provisioning tool into workplace monitoring. The durable record is an **aggregate**: records that
recur in high-clearance replays of lower-clearance queries, ranked, carrying a count of **distinct
persons and never which persons**. The transient log carries identity, because otherwise the
aggregate cannot distinguish fifty people wanting a document from one person wanting it fifty
times, and those mean opposite things for a provisioning decision. Reading the transient log _with_
attribution is its own act requiring its own grant — so de-anonymising is deliberate, recorded and
answerable for, rather than a column on a dashboard.

**The delta is never persisted.** "What was withheld from this person" is a derived fact about
records they may not see. Computed on replay at the replayer's ceiling it is legitimate; written
to a row it becomes a classified fact sitting at whatever classification the writer guessed.
Compute, return, discard.

## Consequences

- Replay works only inside the retention window. Demand is a recent signal, so this is a small
  cost, but it is a real one and it is stated rather than discovered.
- The signal is biased and the requirement says so. It measures demand from people who searched
  for things they could not find; people who have learned the system will not help them stop
  searching. So it decays toward zero exactly where the access problem is worst, and a quiet
  report must not be read as "no unmet demand."
- Anything else with the same shape — rate-limit state, draft capture buffers, session scratch —
  now has a category to go in, and its exclusions are already specified.
- A restore drill must assert that transient observations are **absent** after restore. A drill
  that finds them present has found a defect, not a success.

## Provenance

Drafted by an agent under direction, per §103.5. The demand-signal idea, the ninety-day window and
the no-attribution-by-default split are the owner's. The third-category framing, the four
exclusions and the distinct-persons refinement came from this side. Acceptance is a human act
under §94.2.
