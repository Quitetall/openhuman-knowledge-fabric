# 0006 — The product and the OpenHuman instance are different things

- **Status:** accepted, partially implemented — see "Where the line leaks"
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

## Where the line leaks — the honest part

**A different registry compiles and is then rejected by the database.** The seam is real in the
compiler and absent below it. Three layers still hardcode `OH-` and OpenHuman's nineteen
namespaces:

| Layer                                                              | What is hardcoded                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `ontology/meta.yaml`                                               | `enterprise_id.any_of_patterns: '^OH-(?:[A-Z]{2,5})-[0-9]{6}-[0-9]$'`     |
| `generated/`                                                       | compiled from the above, so it inherits it                                |
| `database/migrations/20260819000100_enterprise_id_check_digit.sql` | `core.valid_enterprise_id()` enumerates the nineteen namespaces literally |

So `KF_REGISTRY_DIR=registries/acme` would pass `registry-check` and then fail on insert, because
`core.object.enterprise_id`'s constraint rejects `AC-DOC-000001-3`. The Damm digit is enforced
correctly and generically; the _prefix and namespace set_ are not.

**This is stated rather than fixed because fixing it is a real decision, not a cleanup.** The
options, with their costs:

1. **Generalise the shape, keep allocation in the registry.** Widen the pattern to
   `^[A-Z]{2,4}-[A-Z]{2,5}-[0-9]{6}-[0-9]$` and let the registry be the narrower authority. Cheap
   and consistent with Appendix B.1's own "regex conformance is necessary but not sufficient" —
   but the database stops rejecting an unallocated namespace, which is a control this
   organisation currently has.
2. **Seed the allowed namespaces into a table** and have `core.valid_enterprise_id` read it.
   Preserves the control and makes it per-instance. More work: a new migration, a seeding step in
   the instance bootstrap, and a decision about what happens to rows already issued.
3. **Leave the database as OpenHuman's** and document that adopters write their own migration.
   Honest, and makes "anyone can run this" require real work from the adopter.

## What is NOT claimed

**No second registry has ever been compiled.** A seam that has held exactly one instance is not
demonstrated to be a seam — the same standard this repository applies to a test that has never
failed. The intended proof is a `registries/minimal/` example that is genuinely different, and a
CI check that compiles it. That is not done, because it cannot pass end-to-end until one of the
three options above is chosen, and shipping a second registry that compiles but cannot store a
record would be a worse claim than shipping none.

## Consequences

- Adopters can see which directory is theirs to replace, which was previously unguessable.
- The instance data stays in the repository — `dogfood/document-constitution.json`, the seeded
  organisation, `tests/conformance/r01-golden/` — and is now identifiable as instance data.
- `registries/openhuman/rules.yaml` `enforced_by` paths were repointed; they name real files and
  would otherwise have become stale references.
- The `OH-` coupling in the database is now written down. It was previously true and unstated,
  which is the condition under which someone builds on it by accident.
