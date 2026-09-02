# An enterprise identifier is allocated by the registry, in the act that asks, and never proposed

**Status:** accepted — implemented 2026-09-02; builds on ADR 0006, ADR 0016
**Date raised:** 2026-09-02
**Date decided:** 2026-09-02
**Decision owner:** technical authority
**Scope:** R01 rule R6 (atomic allocation), the action that performs it, what it refuses, how
the identifier reaches the caller, and what remains a pack-owner decision

## The problem, measured

`registries/openhuman/rules.yaml` said it in its own words: "ATOMIC ALLOCATION IS NOT YET
IMPLEMENTED — there is no sequence table or allocator." Every identifier this instance holds
arrived from a reviewed seed file; 68 sit `reserved` in the quality repository. An identifier a
process could not allocate is one a process could only fabricate, which is exactly what §12.4 of
the OpenWarrant SAS forbids ("SHALL NOT be fabricated from a filename or local sequence") and
why OW-WAR-0044's second milestone — "a real enterprise identifier is allocated by KF" — has been
blocked since 2026-08-23. The manifest validator on that side refuses a non-empty identifier as
fabricated; the refusal has never been contrasted with a real allocation, because there was
none.

## Decision

**Allocation is one typed action.** `allocate_enterprise_identifier` targets exactly one object.
The database function `core.allocate_enterprise_id` reads the namespace the object's TYPE
declares (`registry.object_type.enterprise_namespace`), resolves it to the qualified head this
instance allocated (`registry.identifier_namespace`, `OH-DOC` for `DOC`), locks that
namespace's row in `registry.identifier_sequence`, takes the next free value, writes the Damm
digit, attaches the identifier to the object (R9: never a new object), and records the receipt
in `registry.identifier_allocation`. All of it in the action's transaction, so two concurrent
allocations serialise on the namespace and the second sees the first's advance.

**The caller never proposes.** The request has no field for an identifier. A payload that
names one is refused by name before anything is allocated — the refusal §12.4 needs, made
structural. The identifier returns in the action **receipt**, a new channel on the dispatcher:
an action may declare a receipt reader that reads back from durable state by action id, and the
dispatcher attaches the result both on first application and on replay. A retried request
therefore returns the same receipt as the first, and a receipt can never say something the
ledger does not.

**What it refuses, by name.** Already allocated (R8: permanent, so a second allocation is a
contradiction, not a retry). A type that declares no namespace. A namespace this instance has
not allocated (R01 §8: an identifier absent from the registry does not exist) — which today
includes `BND`, `IFC`, `CFG`, `CPA` and `NCR`, declared by object types the registry never
allocated. A namespace that is not `active` (§13.3: no new allocation into a retired one; what
was issued stays valid). A namespace exhausted at 999999.

**Seeds keep their numbers.** An occupied sequence value — a reviewed identifier that arrived
before there was an allocator — is skipped, never reissued. The cursor is a floor, not a
promise.

**The receipt is also a read.** `GET /identifiers/:enterpriseId` serves the ledger row under
the caller's row-level security; an identifier of the right shape that was never allocated, or
whose object the caller cannot see, is _not found_.

## What this does not decide

- **A namespace for Warrants.** The SAS example is `OH-WAR-000042`; the registry allocates
  nineteen namespaces and `WAR` is not one. Allocating a namespace is a pack-owner act on
  OH-DOC-000001-3, not a code change. Until it is made, a Warrant can be registered as an
  object but not numbered — and the allocator will say so by name.
- **Reconciling object-type namespaces with the registry.** Five declared namespaces have no
  registry allocation. Whether the types change or the registry grows is the same pack-owner
  question.
- **The §67 vocabulary.** This is the allocator OW-WAR-0044's milestone M2 needs; the warrant
  object types and the thirty-two actions of §67 are the next step, not this one.

## How this is held

`tests/database/identifier-allocation.test.ts`, against a real database: one dispatched
allocation attaches a valid identifier under `OH-DOC`, returns it in the receipt, and a replay
returns the same receipt with one ledger row; a payload naming an identifier is refused before
anything is allocated; a second allocation on the same object is refused; a seed occupying the
next value is skipped; two concurrent allocations yield two distinct identifiers; a type whose
namespace is unallocated is refused by name; the route serves the receipt and hides what was
never allocated. `rules.yaml` R6 now names the allocator as enforcement.
