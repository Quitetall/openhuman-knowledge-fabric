# @kf/retrieval

Builds the authorization mask a retrieval engine scores under, and speaks to that engine (§64A).

Authority: none. Everything here is derived from `core.object` and from the access grants
resolved for one caller, and is recomputed rather than stored. A band bitmap is a copy of an
authorization input, which KF-SAS-RQ-223 permits only for the life of the process holding it —
so nothing in this package may be written to durable storage of any kind, and the check that
proves it is a test rather than a convention (`src/no-durable-state.test.ts`: no filesystem
import and no SQL other than `select` in this package; `tests/database/retrieval-schema.test.ts`:
no bitmap-, mask- or bit-typed column anywhere in the `retrieval` schema).

## What crosses the socket

`src/protocol.ts` is the compatibility contract. KF pins protocol version 1, never an engine
version. Every exchange opens with `hello`, and the engine's answer is checked every time:

- **Protocol** — a different version is refused.
- **Embedder locality** (KF-SAS-RQ-218) — a non-local embedder is refused, never used as a
  fallback.
- **Embedder identity** (KF-SAS-RQ-218) — the first identity a `RetrievalClient` hears is pinned
  for the life of that client; a later, differing identity is refused. The composition roots
  (`apps/api`, `apps/worker`) each build exactly one client per engine, so the pin is the
  process's.
- **Capabilities** — `vectors_only_write` is required before any record text is sent to be
  embedded (KF-SAS-RQ-225). An engine that does not declare it is refused at the worker's startup
  handshake, and again on every write.

Messages: `hello`, `bands` (band bitmaps by version), `slots` (the engine's slot ordering, which
KF needs to build the bitmaps), `search` (ceiling, per-object allow and deny lists, query text; the
ceiling is `none` when no organization-wide grant reaches any band, so that only the allow list is
scorable), and `write_vector` (object id and text; the engine keeps a vector and the identifier
and nothing else). `slots`, `write_vector`, the `none` ceiling, `capabilities` and the result's
`ranking` name were added in September 2026 without a version bump: each is an optional field or a
new message, which the protocol's own rule makes additive. None is implemented on the engine's side
yet (SAS §100.21).

## Semantic ranking for one query

`SemanticRetrieval.rank` (`src/engine.ts`) caches band bitmaps in memory per organization, keyed by
`(band_version, generation)`, rebuilds them when either moves, pushes them, and asks for a ranking
under the caller's ceiling and grants. It returns a ranking or `unavailable` with a reason — never
a partial list (KF-SAS-RQ-216). Every identifier the engine returns is then re-checked against the
records the caller can see before anything is shown (`@kf/search`, `composeSearch`), and an engine
that names a record outside the caller's mask has its whole answer refused.

## Embed on ingest

After an act commits, the outbox drain enqueues each object it touched in
`retrieval.embed_pending` — a derived queue: enqueueing every object again rebuilds it. A separate
worker pump claims a batch in one short transaction and commits, sends `write_vector` for each
object outside any transaction, and completes each in another short transaction
(`apps/worker/src/embedding.ts`). No database transaction is open while the engine works.
