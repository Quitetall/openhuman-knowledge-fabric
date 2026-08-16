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
  organization and caller classification ceiling before returning them
- `GET /publications/:publicationId/revisions/:controlledRevisionId/views/:compiledViewId` is a
  read-only API delivery boundary for an already-authorized signed public bundle. It is
  fail-closed until operators supply immutable signed-bundle storage and trusted public
  verification keys to the read-only package loader, which binds public-only RLS and re-verifies
  authority, signature, receipt, and bytes. The route has no approve, sign, or publish operation.
- `GET /objects/:id/available-actions`
- `POST /actions/:actionType`
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

Repository does not provision a Keycloak realm, public web client, API audience mapper, test
subject link, or live KF role assignment. Browser tests use a controlled OIDC and KF API fixture
to exercise redirects, PKCE, encrypted session, context validation, access denial, and UI
boundaries. That is browser proof of web behavior, not proof against real Keycloak. Real-provider
qualification remains blocked until those operator-owned records exist and TLS hostnames are
available.
