# Federated ML provenance and secure-object authority contract

**Status:** implementation contract — candidate ADR identifier and acceptance remain human actions
**Applies to:** restricted datasets, BLUT training, metrics, model evaluation and promotion

## Authority split

| Authority               | Owns                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| Knowledge Fabric        | official registry, policy decisions, sealed lineage and promotions   |
| Secure Object Authority | PHI bytes, keys, locators, access logs, retention and physical erase |
| BLUT                    | training execution and source-native execution artifacts             |

KF never proxies PHI bytes. It stores opaque authority and revision identifiers, digests,
classification, policy identities, safe aggregates, receipts and tombstones. Subject/session
identifiers, paths, object locators and reidentification maps remain inside Secure Object
Authority.

## Secure access

Secure Object Authority exposes an mTLS policy plane and encrypted S3-compatible byte plane.
After KF authorization and workload-identity verification, it may issue a short-lived,
read-only capability for one exact immutable revision. Issuance, consumption, expiry,
revocation and denial produce attributable receipts. Vault and BLUT sign with isolated service
keys; KF registers public keys and their rotation/revocation state.

Every KF secure-object ledger append is the effect of one audited typed action in the same
database transaction. The action targets exactly the visible owning organization object and
its parameters bind the opaque authority, revision, raw-byte SHA-256 digest, purpose, workload
identity and policy decision. A committed action cannot be reused as later write authority.
KF stores only Ed25519 public SPKI material and key identifiers; private keys remain with the
Secure Object Authority. A tombstone is accepted only when its external signer proves
possession of an active, owner-registered, non-revoked key for that exact authority.

PHI admission requires three independent physical power/storage failure domains, a separate
encrypted backup location, approved key custody, retention/destruction rules, incident
response, Data Steward approval and Privacy Authority approval. Targets are:

- metadata and receipt RPO: at most 15 minutes;
- immutable object RPO: at most 24 hours;
- complete service RTO: at most 24 hours.

Repo checks record and verify this evidence. They cannot assert physical placement, mTLS,
encryption or restore success without substrate evidence.

Preservation exports include the opaque ledger and public verification-key history across
organizations and classifications through a SELECT-only backup role. That role cannot request
access, issue capabilities, revoke keys, or append receipts.

Full recovery is three proofs, never one label: authenticated database round-trip, audit
checkpoint verification against historical public keys, and external object-store inventory
verification through a federation adapter. `ops.restore_drill` records each dimension plus
proof digest/reference. Outcome `verified` requires all three; missing external substrate is
`partial`, exits nonzero, and blocks readiness. KF stores external proof identity, not PHI bytes,
object locators, or credentials.

Authorized erasure destroys protected bytes and locators. KF retains a signed non-PHI
tombstone, authorization history and now-unusable content digest.

## ML lineage and metrics

KF registers datasets, immutable revisions, splits, labels, transforms, runs, configurations,
code/environment identities, metric series, metric segments, checkpoints, evaluations,
candidates, releases, revocations and retirements.

BLUT sends idempotent append-only provisional metric events during execution. Events may
contain schema-declared numeric values, safe enums, timestamps, steps and aggregates. Free
text, filesystem/object paths, subject/session identifiers, samples, labels and arbitrary
payloads are rejected.

Canonical metric segments live as immutable objects; PostgreSQL indexes run, series, step
range, summary, classification and segment digest. A canonical-JSON Ed25519 receipt seals
exact segments, gaps, inputs, configuration, code, artifacts and outcome. Before sealing,
metrics remain visibly provisional.

## Promotion

KF alone owns governed aliases such as `production` and `released`. A promotion receipt binds
alias, exact object revision, sealed run, policy, digest, complete evidence set, typed human
authority decisions and effectivity. Every promotion currently requires distinct Technical
Authority and Quality Authority humans. `riskTier` remains descriptive and cannot reduce that
gate. Conditional Quality admission stays unavailable until KF has a separately ratified,
immutable organization-owned risk-classification binding over the exact candidate, run seal
and policy. BLUT resolves governed aliases only after verifying the current KF signature.
Revocation removes alias validity without deleting history.
