# Master-record runtime and disclosure boundary

**Status:** accepted for OW-WAR-0054 implementation
**Date:** 2026-08-26
**Decision owner:** Knowledge Fabric technical authority
**Scope:** permission enumeration, master-record compilation, withholding, withdrawal, and KF-only delivery

## Decision

KF stores one immutable master-record claim per `(person, organization, permission_digest)`. A
claim contains the full permission enumeration after subtractive entitlement exclusions. Relation
metadata in `registry.relation_type` controls relevance traversal and only sections the claim:
`your_record` and `org_view` are presentation partitions, never membership filters.

Every claim carries a canonical manifest, compilation time, permission-set digest, record digest,
included members, withdrawn members, and withholding ledger. Legal holds and person exclusions
identify each withheld object. Third-party material is represented only by reasoned counts; its
object identity is not placed in the person-facing manifest.

One master record never stitches organizations. Compilation rejects foreign members, and the API
self-view resolves only the authenticated actor in the authenticated organization. Federated
content enters this invariant only after materialization into KF-governed rows; live external
records remain outside the claim.

## Permission boundary classification

The permission set is intentionally closed over KF-governed materialized records:

| Surface                                                                           | Classification         | Entry rule                                                                                                           |
| --------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `core.object` envelopes and `core.relation` graph                                 | materialized           | Enumerated under current organization/classification RLS; relation policy controls sectioning only.                  |
| Typed rows keyed by a `core.object` (documents, work, quality, ML and operations) | materialized           | Enter through existing action/typed-table guards; the master record carries envelope identity and digest.            |
| Object-store bytes and compiled artifacts                                         | materialized reference | Bytes stay in governed object store; manifest members carry content digests and readers verify bytes before serving. |
| Live Google Drive, PHI or other external records                                  | live external          | Not members of this invariant. They require explicit ingestion/materialization decision before entering KF.          |

This is a closed boundary, not an assumption that an unlisted source is safe to include. The
compiler refuses to treat live external records as permission members, and no release claims
completeness for them until a source-specific materialization contract exists.

## Authority and clearance

Identity provider proves subject only. KF resolves organization-scoped role assignment and
effective classification from an organization-scoped, effective-dated person clearance and an
optional assignment ceiling. Effective rank is the minimum of those two facts. Missing clearance,
unknown classification, and requested ceilings above effective clearance refuse; requests may
narrow but never widen. Resolver output includes both source facts and the effective/requested
values for provenance.

## Runtime surfaces

- `compile_master_record` is a typed action. It enumerates through current RLS, records one
  append-only claim, and emits normal action/audit/outbox evidence.
- `GET /master-record` exposes the authenticated person's latest claim, current permission digest,
  stale status, items, and withholding ledger.
- `renderMasterRecord` projects one compilation deterministically to Markdown or escaped HTML;
  bounded Pandoc conversion derives PDF and DOCX from that same Markdown. Rendering never drops
  members and is not a browser or management surface.
- Signed HMAC capability links store only token digest and immutable scope. Expiry, revocation,
  stale claims, invalid claims, and successful serving all append access evidence.
- Outbox delivery records are append-only and at-least-once. The worker has no direct receipt
  insert grant; it calls a narrowly validated security-definer function because delivery runs
  without a person/organization RLS context. Delivery is transport, never authority.

## Deferred boundary

OW-WAR-0056 owns browser viewer, management UI, and browser proof. This ADR adds no web viewer and
does not perform a real disclosure. M7/M8 disclosure decisions remain human authority actions.

## What was measured

- Permission membership is enumerated from the current RLS-visible envelope set and compared
  in both directions; a changed digest refuses serving.
- Relation traversal uses a visited set and current validity window; policy disagreement is a
  refusal rather than an implicit omission.
- Runtime tests cover action dispatch, third-party count-only withholding, stale claims,
  deterministic renderings, token tamper rejection, worker delivery under a non-superuser login,
  and fresh-install migration application.

These measurements cover envelope membership and runtime wiring. They do not prove that every
typed content byte is materialized in the manifest, or that a live external source is complete.

## Options considered

1. Keep master records as a read-time view. Rejected: no immutable completeness claim or
   reproducible withdrawal/withholding evidence.
2. Persist one append-only claim per person and organization. Accepted: permits deterministic
   re-checks, exports, and later human review without rewriting history.
3. Stitch all organizations into one person record. Rejected: organization boundaries and
   disclosure authority become ambiguous.

## What this record does not settle

- OW-WAR-0056 browser viewer, management UI, and browser proof.
- Human M7/M8 disclosure, approval, signing, identifier allocation, or cutover authority.
- Source-specific ingestion contracts for PHI, Google Drive, or other live external stores.
- The future materialization shape for full typed-row/content-byte manifests beyond the current
  governed envelope and digest reference.

## Consequences

The completeness assertion is reproducible and fails in both directions: over-disclosure and
under-disclosure compare separately, while a changed permission digest marks a claim stale. The
cost is full RLS enumeration per compilation and larger records; measurement and renderer design
must address that cost without dropping members.
