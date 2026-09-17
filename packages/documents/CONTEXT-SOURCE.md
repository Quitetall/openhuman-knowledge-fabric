# LAMU Context Source Foundation

Status: partial implementation. This module is not a qualified integration.

`contextSourceReferencesIn` filters KF-ranked object IDs through the current
permitted set. It preserves order and removes duplicates. `readContextSourceIn`
resolves access again and returns only the exact revision and canonical text
digest requested. Missing and hidden objects both return no record. Authority
and storage failures propagate; no prior result is used as a fallback.

The caller must supply a KF-authenticated identity and a transaction. Request
body assertions are not authentication. Each call uses
`setResolvedAccessContext` and `enumeratePermittedSet`; this module creates no
grants and changes no source records.

Only materialized facts visible through the existing permitted-set projection
are included. External protected source bytes are not fetched. Records carry
untrusted, local-only, ephemeral restrictions. These labels are requirements
for consumers, not proof of transport or retention enforcement.

Candidate input is limited to 200 IDs. Each rendered record is limited to 1 MiB
of UTF-8 bytes and is refused rather than truncated. The existing permitted-set
enumeration still visits the organization corpus. These limits do not bound
database work or peak memory before rendering.

## Remaining Integration Gates

- Complete paired LAMU transport proof and full cancellation review.
- Reuse KF ranking; do not create a second policy or ranking authority in LAMU.
- Add the LAMU source adapter, authority recheck, and invalidation behavior.
- Enforce cancellation, deadlines, response limits, and no persistent source copy.
- Prove revocation, tenant isolation, outages, and retention with real servers
  and database authorization, not only mocked unit tests.

## Private Read Transport

`KF_CONTEXT_SOURCE_ENABLED=1` enables `POST /context-source/read` and
`POST /context-source/retrieve`. Retrieval accepts `query` (1-512 characters)
and `limit` (1-200). It uses KF search order, then filters current eligibility;
it can return fewer references than requested. It requires
configured OIDC identity, a database, and a literal `127.0.0.1` or `::1` listener.
The request body is a source reference, not an identity or a grant. The endpoint
uses token-backed caller resolution and current source authorization. It refuses
nonloopback peers, returns `Cache-Control: no-store`, and limits request bodies to
4 KiB. Database statements receive a five-second timeout.

Do not expose this endpoint through a reverse proxy. Loopback peer checks do not
prove the original requester is local when a local proxy forwards remote traffic.
Source operations use an abortable read-only transaction. A response socket close
or ten-second route deadline aborts source work and discards its connection.
Database statements retain a five-second server timeout; disconnect does not
claim instantaneous server-side cancellation. Authentication is awaited rather
than abandoned, and an expired request cannot start source work afterward.
The deadline is therefore not a hard bound on identity-provider completion or
response transmission. End-to-end LAMU retention enforcement remains open.

## Focused Checks

Run from the repository root:

```sh
pnpm exec tsc --build packages/documents
pnpm exec vitest run packages/documents/src/context-source.test.ts
pnpm exec eslint packages/documents/src/context-source.ts packages/documents/src/context-source.test.ts packages/documents/src/index.ts
```

For the broader document suite, first build its orchestrator test dependency:

```sh
pnpm exec tsc --build packages/orchestrator
pnpm exec vitest run packages/documents/src
```

The source-specific database suite uses a disposable PostgreSQL instance and
the unprivileged application role. It checks exact byte/revision binding,
cross-organization refusal, and refusal after clearance retirement. It also uses
real signed JWTs and a local verification key set to exercise retrieval and read
over actual loopback HTTP, then proves both refuse a revoked identity:

```sh
pnpm exec vitest run tests/database/context-source.test.ts
pnpm exec vitest run apps/api/src/routes/context-source.test.ts
```

The API tests cover configuration, rejection paths, and real socket disconnect
propagation into a controlled pending transaction. A separate real PostgreSQL
test confirms an executing query aborts and its pool remains usable. The database
HTTP test blocks retrieval on a real database lock, observes the waiting query,
disconnects the client, observes connection disposal, and proves fresh retrieval
still works. It also proves token verification and database identity mapping,
but does not exercise remote JWKS retrieval or a live LAMU consumer.

These checks do not replace the full repository gate or qualify C3.
