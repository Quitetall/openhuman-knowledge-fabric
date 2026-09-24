# @kf/canonicalization

RFC 8785 (JCS) canonical JSON and SHA-256 digests. Every hash that appears in a snapshot,
manifest, audit event or export is computed here, so two implementations cannot disagree
about what a record's bytes are.

Authority: none — but it is the definition every digest in the system depends on.

## Format tags

A digest is domain-separated by a format tag that sits inside its preimage, as a `format`
property of the canonicalized object (`{ format: 'kf-action-request-v1', … }`). A format change
is a new tag, never a reinterpretation of bytes already recorded (SAS §102, KF-SAS-RQ-016,
RQ-158). Two digests defined here, or hashed with what is defined here, carry versions whose
history matters to a verifier:

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
