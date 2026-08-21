# 0005 — Apache-2.0 replaces BUSL-1.1, before first publication

- **Status:** accepted
- **Date:** 2026-08-21
- **Decision owner:** OpenHuman Technologies LLC
- **Supersedes:** the licence half of [ADR 0004](0004-production-release.md); the rest of 0004 stands

## Context

ADR 0004 chose BUSL-1.1 with a Change Date of 2030-08-17 converting to Apache-2.0. That choice
was made while the repository was private and before the question "what do we actually want
people to be able to do with this?" had been answered.

It has now been answered, by the decision owner, plainly: _"I don't care what people do with it.
It's just a project for myself that I maintain."_

BUSL-1.1 exists to prevent exactly one thing — a third party offering the licensed work to
others as a hosted or managed service. That is a commercial-protection mechanism. Against a
stated position of not caring, it protects nothing and costs something real:

- it is **not** an open-source licence, is not OSI-approved, and does not meet the Open Source
  Definition, so the repository would have had to say so prominently and repeatedly;
- publishing under it means exposing the entire source and receiving none of the reciprocal
  benefit — no drive-by contributions, no downstream adoption, no reuse — while adding legal
  friction that stops a casual reader from touching it.

Public plus BUSL is the worst of the available squares.

AGPL-3.0 was considered and rejected for the same reason at a different angle. It does not
prevent commercial use; it forces anyone who modifies and network-serves the work to publish
their source. That is the same anti-hosted-service instinct as BUSL, achieved by copyleft
instead of a time bomb, and it is still more restriction than "I don't care" calls for. It also
costs: many organizations refuse AGPL on sight, and a project with outside contributors cannot
relicense off AGPL without collecting an agreement from every one of them.

## Decision

**Apache License, Version 2.0.** `LICENSE` is the canonical ASF text, byte-identical, with the
appendix placeholders intact. The copyright statement moves to `NOTICE`.

Apache-2.0 over MIT for three reasons, in ascending order of weight:

1. It was already the stated destination. ADR 0004 named Apache-2.0 as the BUSL Change License,
   so this executes the existing plan early rather than reversing it.
2. **Section 6 grants no trademark rights.** The project is named after the company that owns
   the mark. MIT is silent on trademarks entirely.
3. **Section 3 states the patent grant explicitly** instead of leaving it to be argued about,
   which is what MIT does by omission.

### The patent grant was checked, not assumed

Section 3 grants every user a licence to any patent the Licensor holds that this code
necessarily infringes. That is irreversible for every version published under it, so it was
verified rather than waved through:

- `git grep -i patent` over the tracked tree returns **zero** hits;
- this repository is a records and ontology system; the inventions tracked in `openhuman-ip`
  concern the signal codec and the hardware, neither of which is embodied here;
- the decision owner confirmed on 2026-08-21: _"This code shouldn't handle any of my patents."_

Worth recording for whoever revisits this: **no open licence preserves patent optionality.**
AGPL-3.0 section 11 contains its own patent grant. If patents on a codebase must be preserved,
the only options are a non-open licence or not publishing it. That was not the situation here.

## Consequences

- The project is open source, and may now say so without qualification. The careful
  "source-available, not open source until 2030" language in `README.md` is deleted rather than
  softened, because it is no longer true.
- **No version was ever distributed under BUSL-1.1.** The repository was private for the whole
  time that licence was in effect, so nobody holds rights under it and nothing needs honouring.
  This is why the change is clean, and it is the reason it was done before flipping public
  rather than after.
- Commercialization is not foreclosed. The copyright holder may dual-license future versions,
  and hosting, support and bespoke work are sellable under any licence. What is given up is the
  ability to stop someone else doing the same.
- `scripts/publish-public.sh` gained a stronger gate than it lost. It used to parse five BUSL
  parameter lines and check that `Licensed Work` named the tag. Apache-2.0 has no parameters and
  is not per-version, so those checks are gone — replaced by a **sha256 identity check against
  the canonical text**, plus a `NOTICE` presence-and-copyright check and a `package.json`
  agreement check. Any edit to `LICENSE` at all now stops a publish.
- GitHub reported the licence as `NOASSERTION` under BUSL. Verbatim Apache-2.0 is detected, so
  the repository will identify correctly to tooling and to licence scanners downstream.

## What this does not decide

Publication itself. Flipping the repository to public remains a separate act by the decision
owner, as ADR 0004 said, and this ADR only settles the terms it would be published under.
