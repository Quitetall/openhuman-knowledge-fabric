# Knowledge Fabric web boundary

This application has two identity profiles. They never fall back into each other.

- `development`: requires `KF_ALLOW_FIXED_IDENTITY=1` plus explicit `KF_DEV_*` values. It sends
  header identity and is non-authoritative.
- `dogfood`: requires OIDC authorization-code flow with PKCE. It stores an encrypted,
  `HttpOnly`, `Secure`, `SameSite=Lax`, host-only session cookie, forwards only bearer identity
  to the KF API, and requires an explicit role assignment, organization, and classification
  ceiling. The API validates that context before the web session retains it.

Dogfood web configuration:

```text
KF_DEPLOYMENT_PROFILE=dogfood
KF_WEB_OIDC_ISSUER=https://identity.example/realms/knowledge-fabric
KF_WEB_OIDC_CLIENT_ID=knowledge-fabric-web
KF_WEB_OIDC_REDIRECT_URI=https://fabric.example/auth/callback
KF_WEB_SESSION_SECRET_FILE=/run/secrets/kf_web_session_secret
KF_API_URL=http://127.0.0.1:4000
```

The secret file contains the canonical base64 encoding of exactly 32 random bytes, with an
optional trailing newline. Production refuses `KF_WEB_SESSION_SECRET` so the encryption key does
not ride in the process environment. Inline `KF_WEB_SESSION_SECRET` remains available only for
development fixtures. Encrypted session values are capped at 3,800 bytes, including a reserved
authority context; an oversized identity-provider token fails login instead of being silently
dropped by the browser's cookie limit.

The context picker asks the API (`GET /session/contexts`, the bearer token and nothing else) which
live role assignments the person holds, in every organization they hold one in, and offers them
grouped by organization under its legal name, each with ceilings up to the person's clearance
there. Whose assignments these are is the verified token's to say: kf-attestor lists the linked
person's own, and no organization they hold nothing in is named. The typed-ids form stays
available beneath the list as a fallback. Nothing is granted by the list: the choice is still
validated by the API before it is kept.

Optional: `KF_WEB_ORGANIZATION=<organization UUIDv7>` names the deployment's organization. It is a
preference, not a limit: the picker lists it first (after the context already in use) when the
person holds an assignment there, and fills the typed-ids form with it only when nothing is
listed. It never hides another organization the person holds an assignment in, and never adds one
they do not.

A successful choice is also remembered in `__Host-kf_context_hint` (sealed like the session, no
token, 12 hours from the choice). The session lives only as long as its access token, so after
renewal the callback re-validates the remembered context with the API for the same OIDC subject
and, if accepted, returns the person to the page they asked for without the picker. Sign-out
clears it.

Web client must be public, use authorization code plus required PKCE S256, and allow exact
callback and post-logout URLs. Access token must carry KF API audience. OIDC role claims are
ignored; subject must already be linked to `org.person`, and selected role assignment must be
live in selected organization.

## Runtime seams

Functional now:

- `GET /documents`
- `POST /documents`
- `GET /documents/:id`
- `GET /documents/:id/source` through the authenticated web proxy; API retrieves an exact immutable
  storage version and rechecks its recorded size and SHA-256 digest
- `GET /documents/:id/workbench` with a unique authored-fragment target, finalized Compilation
  Basis, retained run diagnostics, compiled views, and bounded semantic diff; ambiguous mappings
  return no target facts and disable controls
- `GET /documents/:id/projections/:viewId` through the authenticated web proxy, constrained to the
  exact workbench Basis and reverified immutable bytes
- `POST /documents/:id/proposals` for a human `source_patch` through the sole typed
  `record_document_proposal` action, with exact target, row-version, revision, current Holder,
  Basis id, and Basis digest preconditions
- `GET /search` for classification-aware canonical search; the API limits results to the selected
  organization and caller classification ceiling before returning them. `/search` renders the
  composed answer (KF-SAS-RQ-224): the lexical and semantic lists apart, each under its ranking's
  name; near misses only when the reader ticks for them, labelled with their scoring function
  (RQ-217); the withheld count as one sentence in ADR 0037's terms; and why the semantic ranking is
  missing when the engine could not rank (RQ-216)
- `GET /search/recorded-queries` and `POST /search/recorded-queries/:id/replay` behind
  `/search/recorded`: the reader's own recorded queries, and a replay of one at their ceiling now,
  which shows what the original ceiling withheld and counts toward access demand (RQ-221)
- `POST /search/demand/replay` behind the same page: replays every recorded query asked below the
  reader's ceiling, at that ceiling, and shows only the records the reader may read with how many
  distinct people wanted each — never a query's text, id, time or asker (ADR 0029, amended
  2026-09-24). Other people's recorded queries are deliberately never listed
- `GET /publications/:publicationId/revisions/:controlledRevisionId/views/:compiledViewId` is a
  read-only API delivery boundary for an already-authorized signed public bundle. It is
  fail-closed until operators supply immutable signed-bundle storage and trusted public
  verification keys to the read-only package loader, which binds public-only RLS and re-verifies
  authority, signature, receipt, and bytes. The route has no approve, sign, or publish operation.
- `GET /objects/:id` (the Object View). It never compiles: a stale master record answers
  `409 master_record_stale`
- `POST /objects/:id/refresh`, the same view after recompiling the caller's master record, recorded
  as the person. The Object View page issues it without a click only on the person's own
  navigation (`Sec-Fetch-Site` `same-origin` or `none`, never a prefetch); any other arrival
  asks first
- `GET /objects/:id/available-actions`
- `POST /actions/:actionType`
- `POST /verifications/bulk`, one `verify_record` act per record with basis `promoted_in_bulk`,
  answered per record (API only; this client has no control for it yet)
- `POST /capture/observation` from the capture form at `/capture` (ADR 0034, KF-SAS-RQ-200/203).
  The form asks for the note and, optionally, tags and the objects it is about; it sends no role,
  idempotency key or row version in the body. The session's selected role travels as the
  `x-kf-acting-role` header, as on every request; the API forms the idempotency key from a
  gesture id this page generates once per form render (so a double submit replays) and the note's
  digest. The result shows the observation's verification label exactly as the API returned it,
  which at capture is the unverified label. This app writes nothing itself:
  `tests/conformance/capture-surfaces.test.ts` refuses a database driver, `@kf/database`, the
  dispatcher, or a SQL write statement anywhere under `apps/web`.
- `GET /ml/runs/:authorityId/revisions/:revisionId` with independent event, lineage-member,
  segment, and promotion-receipt cursors (`limit`/`afterSequence`, `memberLimit`/`afterMember`,
  `segmentLimit`/`afterOrdinal`, `promotionLimit`/`afterReceiptDigest`)

Workbench source metadata, Parsed Block preview, outline, and provenance use `GET /documents/:id`.
Compilation and proposal controls additionally require `GET /documents/:id/workbench` to return
exactly one target/Basis mapping. ML metrics remain attached to ML run lineage; no
document-to-run relation is inferred.

Fail-closed surfaces:

- raw-text source editing/upload from the workbench: no safe operation can invent an artifact
  version or Holder; proposals accept only an already-recorded exact typed Holder replacement
- proposal application, document approval, compilation acceptance, and publication mutation:
  human-authority workflows remain disabled in this workbench
- public signed-bundle delivery: route exists but returns `public_projection_unconfigured` until
  operator-owned immutable bundle storage and trusted verification keys are composed into the
  package loader; no private-key custody or signing belongs to the API
- composition DAG, topics, backlinks, ADR links, and traceability navigation are read-only typed
  projections under the exact visible Basis; empty results are explicit and never inferred from
  source text
- machine graph projection: only an exact retained view listed by the workbench is downloadable;
  no graph view is claimed when the compiler did not retain one
- document-linked metrics: no typed document-to-run binding

## Real-Keycloak E2E blocker

The repository ships a workstation realm,
[`deploy/keycloak/knowledge-fabric-realm.json`](../../deploy/keycloak/knowledge-fabric-realm.json),
which Compose imports: the public `knowledge-fabric-web` client (PKCE S256) and the
`knowledge-fabric-api` audience. It does not ship a user, a test subject link, or a live KF role
assignment — `scripts/deploy/create-dev-user.sh` and `pnpm kf:grant-authority` supply those. Browser tests use a controlled OIDC and KF API fixture
to exercise redirects, PKCE, encrypted session, context validation, access denial, and UI
boundaries. That is browser proof of web behavior, not proof against real Keycloak. Real-provider
qualification remains blocked until those operator-owned records exist and TLS hostnames are
available.

## The experience (ADR 0040, milestone M3)

- `/` is the dashboard for a signed-in person: the panels of `GET /dashboard`, in its declared
  layout order, each scoped by the reader's grants; a panel the API marks empty is not rendered.
  Nothing in the page branches on a role or title. Needs you is a separated slot
  (`src/app/components/needs-you-slot.tsx`) holding KF-WAR-0004's (M2) panel, filled from
  `GET /needs-you`; it renders nothing, and collapses, when nothing waits on the reader. A
  gesture there returns to `/`, which shows its outcome. `/needs-you` is the same panel alone.
  A signed-out visitor sees how to sign in and the status report, which is also at `/status`.
- `/master-document` reads `GET /master-document`: the compiled claim by record type, paged with
  the `next` cursor, the living organization overview first when the reader's grants reach it.
  "Compile now" is the act `POST /master-record/compile`, with one idempotency key per render.
- The density switch (`kf_density` cookie, `data-density` on `<html>`) is presentation only.
- `e2e/experience.test.mjs` holds the layout, the collapse of empty panels, presentation-only
  density and phone width (390 px) in a real browser.
