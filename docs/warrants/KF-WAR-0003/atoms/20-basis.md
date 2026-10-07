---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-339c-7c52-b3e9-0fe9773b6c63
role: basis
jurisdiction: authored
order: 20
classification: internal
---

# Basis

## Source of the decisions

The owner's answers to seventeen questions on 2026-10-06, summarised as twelve decisions in
`docs/ROADMAP.md` ("The experience"). That summary is the input; the answers in the owner's own
words are quoted into ADR 0040 where a decision departs from the recommended option (Q1, Q2, Q3,
Q7, Q9, Q14, Q15, Q16), because those departures are where a later reader will most want the
reason.

## The records this builds on

- **ADR 0038** (`docs/decisions/0038-qualification-is-evidence-against-a-versioned-pack.md`) and
  SAS §24A: joining is qualification. ADR 0038 places qualification last, after hosting and the
  correctness pass. The owner's Q15 answer puts Start Here and qualification before friends join,
  which the roadmap orders as M5 before M7. **ADR 0040 must record that resequencing explicitly,
  as amending ADR 0038's Consequences**, or say that the owner reversed it.
- **ADR 0035** (an agent acts for a named human), **ADR 0031** (a draft is a record that says so),
  **ADR 0034** (an observation is captured, then promoted): what "submitted, not yet verified"
  already means.
- **ADR 0016** and **ADR 0027** (access is a grant, on every read): what "scope" is.
- **ADR 0013** and **ADR 0014** (master identity is the corpus; corpus projections): what
  "master document = compile(scope)" already is.
- **ADR 0024** (friction is an architectural property) and its latency bars.
- **ADR 0028** and KF-SAS-RQ-218 (nothing leaves the host to be embedded): the stance the
  classification routing of answers extends.
- SAS §15 (organizations, people and roles: roles today are a flat list of names), §18 (access is
  a grant), §19 (explaining a denial), §64A to §64C (retrieval and the context source).
- `docs/deployment/phone-alerts.md`: the owner already chose hosted ntfy for alerts, and accepted
  that a free topic is readable by anyone who learns it. That bounds what a "Needs you" push may
  say.

## The requirements to write

One requirement per decision that a gate can check. Proposed statements, for the SAS section to
refine; the identifiers are assigned in order when the revision is proposed:

1. One dashboard layout for every person; every panel shows only what the reader's grants reach;
   no screen, route or policy branches on a role or title.
2. An agent's submission is recorded as unverified and attributed to the agent acting for its
   person, and becomes verified only by an act of someone the verification policy names.
3. The verification policy is configurable per record kind and per agent, defaults to "required",
   and can never mark an institutional act verified automatically.
4. An institutional act an agent proposes is queued for its person and performed only by that
   person's explicit act.
5. A person's master document is the compilation of their scope; the living org overview reaches
   them only by being in that scope.
6. A role is a named, composable preset of scope; role inclusion is acyclic, and a role reaches a
   person only as grants in the one grant view.
7. Content above a configured classification never reaches a provider model; the answer names the
   backend that produced it.
8. Every in-app answer cites its sources and states what was withheld, within the reader's ceiling.
9. A notification carries no record content over a channel the deployment does not control.
10. Reading, one-click verification and capture work on a phone-width screen.

## The section's home

A new SAS section; §8C ("The experience") sits beside §8A (friction) and §8B (the three layers),
which are the same kind of product-level statement. M1 may choose another home and say why.
