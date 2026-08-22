# 0006 — The product and the OpenHuman instance are different things

- **Status:** accepted; database half implemented 2026-08-22, prefix pinned by approved artifact
- **Date:** 2026-08-21
- **Decision owner:** OpenHuman Technologies LLC

## Context

The repository went public under Apache-2.0 on 2026-08-21 so that anyone could run a records
system like this one. Reading it back as a stranger, they cannot: the software is entangled with
one organisation's policy, and nothing in the repository said which parts were which.

Concretely, a clone gives you a system that seeds an organisation called "OpenHuman Technologies
LLC" and enforces an identifier scheme — the `OH-` prefix, nineteen specific namespaces, product
families named `SOMA` and `ATLS` — that belongs to one company's controlled document.

The entanglement is thinner than it looks and deeper than it looks, in different places. Measured
rather than estimated:

- 65 tracked files mention `OpenHuman` or an `OH-` identifier, but **most are comments citing the
  specification and test fixtures**, not coupling.
- Exactly **three lines** hardcode the legal name, all in `apps/api/src/dogfood/bootstrap.ts`.
- All six `registries/openhuman/*.yaml` files carry `source: {document: OH-DOC-000001-3}`. That
  directory is **a transcription of a controlled document**, not product logic.
- The compiler was **already** parameterised — `loadRegistryPolicy(dir)` takes a path.

## Decision

**The Knowledge Fabric is the product. An identifier registry is one deployment's policy. They
are separate authorities, and the registry directory is the seam.**

- `ontology-registry/` becomes `registries/openhuman/` — named for whose policy it is.
- `KF_REGISTRY_DIR` selects the registry. It defaults to `registries/openhuman` **because that
  is the only instance that exists**, not because it is privileged.
- The README says the product does not know your company, and points here.

Rejected: splitting the instance into a separate repository. It is the cleaner story, but it
requires the seam to hold first, and today it does not (below). Doing the split before proving
the seam would move the problem rather than fix it. Revisit when the leaks are closed.

> **UPDATED 2026-08-22.** The database half of this is FIXED — see
> `20260822000100_instance_identifier_namespaces.sql`. `core.valid_enterprise_id` is now
> prefix-agnostic and allocation moved to a foreign key against per-instance data, so the
> database accepts `AC-PART-000042-7` once that namespace is seeded.
>
> The remaining obstacle is **not** the one this section originally named, and the correction
> matters. I wrote that widening `ontology/meta.yaml` would collide with the
> `ontology_pattern_no_longer_looser` check. It would not: that check is a WARNING that fires
> when the ontology gets NARROWER, because the design already intends "the ontology is
> deliberately the looser of the two". Widening is consistent with it. I had the direction
> backwards.
>
> The real obstacle is `tests/conformance/r01-golden.test.ts`, and it is firmer. Measured by
> widening the pattern and regenerating, rather than reasoned about:
>
> ```
> × every R01 JSON Schema definition survives byte-identically
>   $defs.OrganizationNode was redefined:
>   + ".properties.enterprise_id.anyOf[0].pattern"
>   + ".properties.enterprise_id.anyOf[1].pattern"
> ```
>
> That suite's PRESERVATION rule is "an approved semantic cannot be redefined by an extension,
> ever". The `OH-` prefix is part of an APPROVED, signed R01 pack. Un-pinning it is therefore a
> spec amendment requiring the pack owner — a governance act, not a refactor — and the system
> refusing a developer the ability to do it quietly is the control working, not a defect.
> The change was reverted; 15/15 conformance tests pass.

## Where the line leaks — the honest part

**A different registry compiles and is then rejected by the database.** The seam is real in the
compiler and absent below it. Three layers still hardcode `OH-` and OpenHuman's nineteen
namespaces:

| Layer                                                              | What is hardcoded                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `ontology/meta.yaml`                                               | `enterprise_id.any_of_patterns: '^OH-(?:[A-Z]{2,5})-[0-9]{6}-[0-9]$'` — still true                  |
| `generated/`                                                       | compiled from the above, so it inherits it — still true                                             |
| `database/migrations/20260819000100_enterprise_id_check_digit.sql` | ~~`core.valid_enterprise_id()` enumerates the nineteen namespaces~~ **superseded 2026-08-22** below |

So `KF_REGISTRY_DIR=registries/acme` would pass `registry-check` and then fail on insert, because
`core.object.enterprise_id`'s constraint rejects `AC-DOC-000001-3`. The Damm digit is enforced
correctly and generically; the _prefix and namespace set_ are not.

**This was stated rather than fixed because fixing it is a real decision, not a cleanup.** The
options, with their costs — **option 2 was taken on 2026-08-22**:

1. **Generalise the shape, keep allocation in the registry.** Widen the pattern to
   `^[A-Z]{2,4}-[A-Z]{2,5}-[0-9]{6}-[0-9]$` and let the registry be the narrower authority. Cheap
   and consistent with Appendix B.1's own "regex conformance is necessary but not sufficient" —
   but the database stops rejecting an unallocated namespace, which is a control this
   organisation currently has.
2. **Seed the allowed namespaces into a table.** ✅ **TAKEN.** Not by having
   `core.valid_enterprise_id` read it, which was my proposal here and is UNSOUND — a CHECK
   constraint must be IMMUTABLE and a function that reads a table is STABLE at best, so it
   survives testing and breaks on dump/restore. Implemented instead as a composite FOREIGN KEY
   from two stored generated columns on `core.object` to `registry.identifier_namespace`, which
   is declarative, dump-safe, and additionally refuses to let a namespace be deleted while
   identifiers still reference it.
3. **Leave the database as OpenHuman's** and document that adopters write their own migration.
   Honest, and makes "anyone can run this" require real work from the adopter.

## What is NOT claimed

**No second registry has ever been compiled.** A seam that has held exactly one instance is not
demonstrated to be a seam — the same standard this repository applies to a test that has never
failed. The intended proof is a `registries/minimal/` example that is genuinely different, and a
CI check that compiles it.

**2026-08-22: the database no longer blocks that, but the prefix does, and the difference is
worth stating precisely.** Option 2 above was taken, so a second registry can now store records.
What a second registry still cannot do is use its own PREFIX, because the `OH-` prefix is fixed
in an approved R01 conformance artifact (above).

So the swappable surface, measured rather than assumed, is:

| Part of a registry                      | Swappable today                                               |
| --------------------------------------- | ------------------------------------------------------------- |
| namespaces, and which grammar each uses | **yes** — data, seeded per instance, enforced by FK           |
| codes, rules, lifecycle, Damm vectors   | **yes** — compiled from the registry directory                |
| the enterprise prefix (`OH-`)           | **no** — pinned by an approved artifact; needs the pack owner |

A `registries/minimal/` example proving the first two rows is worth shipping and is not done yet.
It would have to keep the `OH-` prefix, which is an odd-looking example and an honest one: it
would demonstrate exactly which single element remains pinned, instead of implying the whole
thing is free.

## Consequences

- Adopters can see which directory is theirs to replace, which was previously unguessable.
- The instance data stays in the repository — `dogfood/document-constitution.json`, the seeded
  organisation, `tests/conformance/r01-golden/` — and is now identifiable as instance data.
- `registries/openhuman/rules.yaml` `enforced_by` paths were repointed; they name real files and
  would otherwise have become stale references.
- The `OH-` coupling in the database is now written down. It was previously true and unstated,
  which is the condition under which someone builds on it by accident.
