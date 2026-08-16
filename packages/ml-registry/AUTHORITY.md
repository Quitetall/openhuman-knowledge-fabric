# @kf/ml-registry

Defines the canonical privacy-minimal ML lineage, typed metric, run-seal, promotion-receipt,
and revocation records. PostgreSQL schema `ml` owns those operational facts; external systems
remain authoritative for aggregate bytes and are referenced only by opaque revision and
digest metadata. Every aggregate reference is organization-scoped and has one declared kind.

Metric visibility is not write authority. Each append requires a live actor-role transaction
context and an immutable authorization naming the exact run lineage, metric definition, and
metric policy. A run seal stores the ordered segment-digest manifest and its canonical digest;
PostgreSQL refuses a seal that does not match the immutable segment rows.

Promotion records bind one exact candidate and run seal to descriptive risk tier, immutable
evidence set, and independent Technical Authority and Quality Authority decisions. Risk tier
cannot reduce this fail-closed gate until a separately ratified, immutable organization-owned
classification binds exact candidate, run seal, and policy. Constructors sign only
caller-supplied references; they do not create, infer, or approve authority decisions.
PostgreSQL accepts a governed promotion only through
`ml.append_signed_promotion_receipt`: that database boundary rebuilds the RFC 8785 receipt
and evidence bytes from stored references, recomputes both digests, and verifies the signature
against an active owner-registered Ed25519 public key. It accepts revocations only through
`ml.append_signed_promotion_revocation`, which rebuilds the revocation bytes from the stored
receipt before verification. Keys are append-only, organization-scoped, rotatable, and
revocable; private key material has no database representation. The operational promoter has
no raw insert privilege on receipt, evidence, or revocation tables.

`ml.promotion_verification_key` exposes organization-scoped public verification material,
validity, rotation, and revocation state as read-only data. `ml.governed_alias` ranks the latest
receipt first and then suppresses it on receipt or key revocation, so invalid authority never
falls back to an older model. Ordinary key expiry blocks new signing but does not silently
withdraw a receipt whose key was valid at promotion time; withdrawal requires an explicit,
append-only revocation.

Authority: owns ML registry records in PostgreSQL. It owns no source dataset, subject,
session, sample, label, model bytes, or object-store locator.
