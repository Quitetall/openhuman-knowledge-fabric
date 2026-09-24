# @kf/canonicalization

RFC 8785 (JCS) canonical JSON and SHA-256 digests. Every hash that appears in a snapshot,
manifest, audit event or export is computed here, so two implementations cannot disagree
about what a record's bytes are.

Authority: none — but it is the definition every digest in the system depends on.

## Format tags

A digest is domain-separated by a format tag that sits inside its preimage, as a `format`
property of the canonicalized object (`{ format: 'kf-action-request-v1', … }`). A format change
is a new tag, never a reinterpretation of bytes already recorded (SAS §102, KF-SAS-RQ-016,
RQ-158).

`taggedDigest(tag, fields)` is the one way a new digest is taken: `digest({ ...fields, format:
tag })`. The tag must read `kf-<name>-v<n>`; `fields` must be a plain object that does not
already carry a `format` property (a caller cannot overwrite the tag, and a list or scalar is
wrapped in a named property first — `{ objects: [...] }`, never the bare list). It is
byte-identical to the older spelling `digest({ format: 'kf-…-vN', … })`, so a call site moved
onto it keeps every value it ever produced. Bare `digest()`, `createHash('sha256')` and
`digestBytes(Buffer.from(…))` in production source are refused by
`tests/conformance/digest-tags.test.ts` unless an allowlist entry names the reason: raw bytes
(artifact content, files, keys, tokens — never canonical JSON) are exempt by design; a preimage
that carries its own tag under another name (`schemaVersion`, `projectionContract`, a manifest's
`format`) is recorded as such; an equality test that stores nothing is recorded as such; and a
digest still untagged is recorded as the named gap it is, so the list can only shrink.

Tags taken through `taggedDigest`, and where each value lives:

- `kf-action-state-v1` — the `before_digest` / `after_digest` an act commits to its audit link:
  `{ objects: [{ id, state }], format }`. Stored in `core.audit_event`, but only as opaque strings
  inside the link preimage; nothing recomputes them from object state. Links recorded before the
  change carry the untagged digest of the bare list, and still verify, because a link is
  verified over the strings it recorded.
- `kf-compilation-dependencies-v1` — a compilation run's `dependencyDigest`: `{ basisDigest,
inputs: [{ key, contentDigest }] }`. Stored in `content.compilation_run.dependency_digest` and
  inside the run's own `kf-document-compilation-run-v2` preimage; compared within one
  invocation to the adapter's echo, never re-derived from a stored basis, so runs recorded before
  the change keep their untagged value and verify as recorded.
- `kf-master-record-member-v2` — a master-record member's `contentDigest` (envelope fields, row
  version and typed payload). It is identity: `corpus_digest` is a line digest over members'
  content digests, and a stored claim is re-checked against a fresh enumeration on every read.
  So the member format is versioned by the manifest that recorded it: `kf-master-record-v3`
  manifests carry v2 members, and `kf-master-record-v1`/`-v2` manifests carry
  `kf-master-record-member-v1` — the untagged preimage, a name that never appears in a digest.
  `masterRecordMemberFormat(manifest)` maps one to the other, and every staleness check
  enumerates the current corpus under the RECORDED member format, so a claim compiled before the
  change is exactly as current as it was. A withdrawn member carries forward the digest its
  earlier claim recorded; its content is no longer visible, so it is never recomputed.
- `kf-pandoc-atom-v1`, `kf-pandoc-loss-source-v1` and `kf-pandoc-conversion-loss-v1` — the
  Pandoc parser's atom digest, each conversion loss's `sourceDigest` (`{ source, format }`), and
  the parse's `lossDigest` (`{ conversionLoss, format }`). All three are recorded, with their
  preimages, in `content.document_parse` / `content.document_atom`, and the database recomputes
  them on insert. They are versioned by the parse's recorded `projection_contract`:
  `kf.pandoc-atoms.v3` parses carry the tagged forms, and `kf.pandoc-atoms.v1`/`-v2` parses the
  untagged ones; the insert triggers (migration `20260925114000`) check each row's preimage
  shape under its own contract, so an exported v2 parse still imports. The parse's
  `contentDigest` was already tagged — its preimage carries `projectionContract`.

Two digests defined here, or hashed with what is defined here, carry versions whose history
matters to a verifier:

- **Audit-chain links.** `auditChainDigest(previous, entry, format)` takes the link format
  explicitly; there is no default. `kf-audit-link-v2` is
  `sha256(previous || canonical({ …eight fields, format: 'kf-audit-link-v2' }))`, and every
  link appended since migration `20260924001100` is v2. `kf-audit-link-v1` names the earlier,
  untagged preimage — the same eight fields with no `format` property — which recorded links
  still carry and verifiers still accept. Each `core.audit_event` row records its own
  `link_format`; the database sets it (the column default) and refuses any other value on a new
  row, `core.audit_event_digest` recomputes a link under either format, and every verifier —
  the insert trigger, readiness, the checkpoint signer and ledger verifier, the export importer,
  idempotent replay — checks each link under its recorded format and refuses a v1 link that
  follows a v2 one. `kf:audit-chain:v1` is not a digest tag: it keys the advisory lock that
  serializes appends.
- **Access explanations.** `kf-access-explanation-v2` is `digest()` of the explanation body
  (everything but `explainedAt` and the digest itself). `kf-access-explanation-v1` hashed
  `JSON.stringify` of the same body in insertion order; it was only ever computed on request
  and returned, never stored or verified by the system, so nothing still verifies it.
