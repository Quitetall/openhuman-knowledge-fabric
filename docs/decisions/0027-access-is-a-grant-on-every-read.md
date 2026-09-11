# ADR 0027 — Access is a grant on every read; the session ceiling is the clearance; people and organizations are the lowest tier

- **Status:** accepted, 2026-09-11
- **Extends:** ADR 0011 (organization-scoped authority), ADR 0016 (access is a grant),
  ADR 0025, ADR 0026.

## Context

The first fixture company could not give a customer's contact their own master record, and
the reason was three model decisions that had never met a customer.

1. **The role ceiling capped the whole session.** `org.resolve_effective_classification` took
   the lower of the person's clearance and the acting role assignment's ceiling as the
   classification bound to the session. A contact cleared to `confidential` for their own
   agreement, capped at `public` through their role, could reach nothing above `public` —
   including the object-scoped `grant_access` recorded for them, which was therefore useless.
2. **Only the master record checked grants.** `GET /documents/:id`, its bytes, its workbench,
   its projections and search served on row-level security alone. That is why the role
   ceiling _had_ to cap the session: it was the only thing keeping an organization-wide
   reader away from records they were cleared for but not granted.
3. **Every person and organization was `internal`**, the envelope default. A member capped
   at `public` could not see the people around them, the organization they belong to, or —
   fatally — their own person object, the target of `compile_master_record`.

Two smaller findings arrived with them: `content.artifact.artifact_kind` was checked against
a vocabulary the ontology never declared, and most materializers ignored the classification
an act stated, so every decision record, configuration item and project was `internal`.

## Decision

**The session ceiling is the person's clearance.** The resolver no longer lowers it by the
assignment's ceiling. The assignment ceiling means what `org.effective_access_grant` always
said: the cap on the organization-wide read grant that a role assignment is.

**Every read surface checks the grant.** `apps/api/src/routes/documents/read-grant.ts`
answers one question — does a live grant reach this object at its classification — from the
same view the master record uses, and the document read, source bytes, workbench,
projection, list and search routes all ask it. Not granted reads as not found, deliberately:
the difference between "no such record" and "not yours" is itself information.

**People and organizations are `public`** — the lowest classification inside a tenancy that
row-level security already scopes to one organization. This is not publication, which
remains an act. Existing rows were reclassified by migration `20260911000200`, under a
transaction context and per-organization binding, because the guard is right to demand both.

**One artifact-kind vocabulary**, the ontology's; the column's check follows it and the old
values were mapped in the same migration. **Every materializer passes the classification the
act states** through `classificationFrom(payload)` in `@kf/record-atoms`; the insert policy
still refuses a classification above the session ceiling, so nothing can widen.

**Two minimal definer answers for the bootstrap tier**, `org.organization_by_name` and
`org.person_lookup`, so the owner login — which is not the table owner — can find an
organization before it can bind one and verify a decider from another organization, and
learns nothing else.

## Consequences

- A customer's contact holds `customer_contact` with a `public` role ceiling and a
  `confidential` clearance: they read what the organization publishes to everyone in it, and
  their own agreement through an object-scoped grant, and nothing else confidential. The
  fixture demonstrates all nine personas.
- `tests/permissions/identity.test.ts` encodes the new ceiling rule;
  `tests/database/access-grants.test.ts` proves the read gate reaches exactly the granted
  object; the route unit tests answer the gate's two tagged queries.
- Grants are still not enforced inside row-level security itself. A caller with database
  access at their clearance sees what RLS shows; the grant is applied at the API. That is
  the boundary today and it is stated, not hidden.
