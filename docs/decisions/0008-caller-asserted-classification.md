# The classification ceiling is asserted by the caller, not granted to them

**Status:** raised — needs a decision from the technical authority
**Date raised:** 2026-08-24
**Decision owner:** technical authority
**Scope:** how `maxClassification` reaches `core.set_access_context` on the application path,
and whether it is a privilege the system grants or a limit the caller chooses
**Decision:** none yet. Options and their consequences are below; the recommendation is
option 2, and it is not taken here.

---

## What was measured

Reading a KF record is bounded on two axes: the caller's organization, and a classification
ceiling. `core.object`'s policies enforce both, and `core.current_classification_rank()`
defaults to `-1` so an unbound context sees nothing. That part is fail-closed and correct.

The question is where the ceiling comes from. On the application path it comes from a header.

`packages/authorization/src/identity.ts` proves a great deal before admitting anyone:

- the external identity is linked to a person, and the link is not revoked;
- the acting role **is held by that person**, is `active`, belongs to **the organization the
  caller claims**, and is valid _now_ rather than at sign-in.

That organization clause is carefully built, and its comment explains why it is written in the
query rather than left to row-level security: RLS hid another organization's role assignment on
the application role and failed open on a superuser connection, so the boundary held only for
callers connecting as exactly the right database role.

**`maxClassification` receives none of that.** It is read from `x-kf-classification`, defaulted
when absent, and passed through `resolveIn` to the returned `Caller` unmodified
(`identity.ts:250`), then bound as the ceiling. `core.set_access_context` checks only that the
value **names a classification that exists** — it raises `unknown classification %` for a typo
and accepts any real one.

A search for a per-person or per-role clearance found none. The only `max_classification`
column in the schema belongs to the document compiler's runtime, which is a different thing.

**So a caller whose token verifies, whose identity is linked, and who holds a valid role in the
organization may name any ceiling up to `restricted`, and the database will honour it.**

Two smaller findings from the same reading, both already corrected:

- `apps/api/src/routes/actions/auth.ts` claimed the default was "the LOWEST tier … gets the
  least". `public` is rank 0 and the default is `internal`, rank 1 — the second-lowest.
- the fixed-identity path (`callerFrom`, used only when no token verifier is configured) is
  explicit that "a header is an assertion, not a login", and sets an empty authentication
  event so every step-up policy fails closed. That path is honest about what it is.

## Why this may be the design rather than a defect

ADR 0003 records the fabric's existing model: the direct-connection roles `kf_readonly` and
`kf_auditor` can execute `core.set_access_context` and "are trusted to bind truthfully", and it
bounds how much any policy can achieve for them. Under that model, a classification ceiling is
a **self-limit** — a caller narrowing their own view — not a privilege the system withholds.

If that is the intent, the current behaviour is consistent and nothing is broken. What is
broken is only that nobody wrote it down, and ADR 0003 says something narrower: it describes
the application path as the protected one, where "only the application derives a context from a
verified identity". The application derives organization and role from a verified identity. It
derives classification from an unverified header. That sentence is therefore true of two thirds
of the context.

## Why it may not be

`restricted` exists as a tier, and the system is built for a quality-managed organization where
who may see what is a real constraint rather than a display preference. If classification is
meant to segregate people **within** an organization, then a caller choosing their own ceiling
defeats it for every caller who thinks to try — including a compromised token that would
otherwise have been confined.

The blast radius is bounded and worth stating precisely: organization and role are still
proven, so this is not cross-tenant. It is a ceiling choice _inside_ the caller's own
organization and role.

## Options

1. **Record it as a self-limit.** Amend ADR 0003's sentence about the application path, state
   in the threat model that classification is not an access control against the caller, and
   leave the code alone. Cheapest, and honest. Costs: `restricted` stops meaning what a reader
   would assume, and every future feature that reaches for classification as a boundary has to
   be told.

2. **Clamp to a granted clearance** _(recommended)_. Add a clearance to the person or the role,
   and take `min(requested, granted)` in `resolveIn` — narrowing stays free, widening stops at
   what was granted. Fits the existing shape: `org.role_assignment` is already the thing proven
   at the moment of use, so a `max_classification` on the role assignment would be proven by
   the same query that already runs. Costs: a migration, a seeding decision for existing
   assignments, and a real risk of locking people out on the day it ships.

3. **Default to `public` and require an explicit ceiling.** Orthogonal to 1 and 2 and cheap:
   an omitted header currently yields `internal`, which is a choice nobody made deliberately.
   Worth doing under either of the above.

## Recommendation

Option 2 with option 3, once a host exists — not before. The clamp is the option that makes
`restricted` mean what a reader assumes, and doing it now would change the access behaviour of
a system in the week it is first commissioned, where a lockout is indistinguishable from a
commissioning failure. Ship v1.0 with the behaviour recorded honestly (option 1's write-up),
then clamp.

## What this record does not settle

- Whether clearance attaches to the **person** or to the **role assignment**. The role is what
  is proven at the moment of use, which argues for the role; a person's clearance is what an
  auditor would expect to see, which argues for the person. Both are defensible and the choice
  affects the migration.
- Whether `kf_readonly` and `kf_auditor` should keep `execute` on `core.set_access_context`.
  ADR 0003 accepted that they bind truthfully. If option 2 is taken for the application path,
  leaving the direct path unclamped is a deliberate asymmetry that should be stated rather
  than inherited.
