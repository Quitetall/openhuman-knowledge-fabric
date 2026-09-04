# Friction is an architectural property, and a platform engineers skip records nothing

- **Status:** accepted — 2026-09-04; recorded for KF SAS `0.1.0-draft.3`
- **Date raised:** 2026-09-04
- **Date decided:** 2026-09-04
- **Decision owner:** technical authority
- **Scope:** whether speed of capture and retrieval are architectural requirements of the
  Knowledge Fabric, and what may be written without prior approval

## The problem, stated plainly

Every write in this system is an attributed act: an actor, an acting role, a resolved clearance,
a grant where the act is institutional, an idempotency key, and often a stated reason. That is
friction, and it is deliberate — it is the whole reason the record can be trusted.

It is also, given a web form and nothing else, a guaranteed loss to Slack.

This is a research, biotech and hardware company. Engineers run tests, break boards, prepare
samples and take decisions all day. If recording one of those costs a form and a think, they
will narrate it in a chat window instead, and the Fabric will hold a beautifully governed record
of the small fraction of work somebody had the patience to enter. **A record that is expensive
to write is a record that is not written, and an authority nobody writes to is not an
authority.**

Neither ADR nor specification said any of this. §5 through §8 argue at length for correctness
and say nothing about whether using the system is bearable. That silence is the defect this
record fixes: an unwritten requirement loses to the next architectural argument, every time.

## Decision

**Speed of capture and speed of retrieval are architectural requirements, not product polish.**
They rank with correctness, and a change that makes either materially worse is a change to this
specification rather than a trade somebody makes quietly.

**The friction lives in the API contract, not in the experience.** Nothing in the act model
requires a person to see an idempotency key. One gesture may dispatch a fully formed act. The
machinery is a seam, not a user interface, and it has been treated as both by accident.

**Capture is cheap; governance is on promotion.** Recording that something happened is not an
institutional act and must not cost like one. An observation enters as an ordinary object in a
draft lifecycle state — attributed and audited from the first moment, because attribution is
what makes it worth having — and becomes a controlled record only when somebody makes it so.
Approval, effective state, enterprise identifiers and act grants apply at promotion, which is
rare, not at capture, which is constant.

**Four capture surfaces, one act model behind all of them.** An agent in natural language and
Slack are first class. The command line and a web form are conventionally useful and included.
Every one of them dispatches the same typed acts through the same seam; none gets a private path
to storage, and none gets its own record shape. A corpus with four shapes for one kind of fact
is the drift this system exists to prevent.

**Retrieval is half the requirement.** A record nobody reads back does not repay the cost of
writing it. Finding prior work — what was tried, what the numbers were, who decided what and why
— is the same hot path as capture and gets the same standing.

## The bars

Stated as numbers because "fast" is not a requirement and cannot fail. These are initial and
will be re-measured; §103.3's rule applies, and a bar nobody measures is prose.

| Interaction                                      | Bar                                         |
| ------------------------------------------------ | ------------------------------------------- |
| Recording an observation, from intent to durable | under 5 seconds, including the human part   |
| The act itself, dispatched and committed         | under 500 ms at the API                     |
| Finding prior work by text                       | first useful result under 2 seconds         |
| Reading an object view                           | under 1 second                              |
| Attaching evidence to an existing record         | under 10 seconds for a file already on disk |

## What this does not license

- **It does not weaken the act model.** Every capture is still an attributed act in the audit
  chain. Cheap means fewer decisions asked of the person, not fewer facts recorded.
- **It does not create an ungoverned path.** No surface writes to storage outside the
  dispatcher. §8.7's refusal of a general-purpose write path stands.
- **It does not make a draft a lesser record.** A draft is an ordinary object with a lifecycle
  state, subject to the same row-level security, the same corpus membership and the same audit
  as everything else. It is early, not second class.
- **It does not lower the bar for institutional acts.** Approving, allocating, publishing and
  resolving stay exactly as expensive as they are. They should be.

## Consequences

- KF-SAS-RQ-200 through RQ-204 make these requirements rather than intentions.
- The product gap this exposes is real and now has an owner: there is no Slack integration, no
  cheap capture path, and no measurement of any of the bars above. All three are recorded in
  §100 rather than assumed.
- Agents stop being a downstream consumer and become part of the answer: an engineer describes
  what happened, an agent forms and dispatches the act, and the record is complete without the
  person composing one. This is why ADR 0014's projection engine and the existing agent tools
  matter more than their size suggests.

## What this does not decide

- **Which chat platform**, beyond Slack being the one being lost to today.
- **How an agent authenticates** when acting for a person, which is a real question and is not
  answered by the service-actor model in ADR 0020: a service actor acts for itself, and this is
  acting on behalf of a named human.
- **What a draft observation's object type is**, or whether existing types suffice.
