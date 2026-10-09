/**
 * KF-SAS-RQ-016: every digest is taken over an RFC 8785 canonical form under a named format tag,
 * and the tag is part of the preimage. `taggedDigest(tag, fields)` is how production source takes
 * one. This gate finds every other way a SHA-256 is taken (see `digest-scan.ts`) and requires
 * each to be named below with its reason — so a new untagged digest cannot land silently, and the
 * list can only be shortened by fixing one.
 *
 * Reasons, by kind:
 *   raw bytes    — content hashed as received or stored, never canonical JSON: exempt by design.
 *   self-tagged  — the preimage carries its own tag (a `format`, a `schemaVersion`).
 *   equality     — two canonical forms compared; nothing is recorded.
 *   legacy       — recomputes an untagged format that recorded rows carry and are verified under.
 *   protocol     — a hash an external standard fixes (SCRAM, PKCE, UUIDv8, Merkle nodes).
 *   secret       — a bearer token hashed for lookup; opaque text, not a structure.
 *   superseded   — (SQL only) a function body a later migration replaced; the file still holds it.
 *   UNTAGGED     — a named gap that remains, with where it lives. These are the work left.
 *
 * An entry is keyed by file and the exact trimmed source line. Reformatting a line makes its
 * entry stale, which fails here too: look at it again rather than re-pasting the text.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  migrationSources,
  productionSources,
  scanDigests,
  scanSqlDigests,
  type DigestFinding,
} from './digest-scan.js';

const ROOT = join(import.meta.dirname, '..', '..');

interface Allowed {
  readonly path: string;
  readonly line: string;
  readonly reason: string;
}

const ALLOWED: readonly Allowed[] = [
  {
    path: 'packages/operations/src/internal/commissioning/unit-composition.ts',
    line: "const digest = (text: string): string => createHash('sha256').update(text).digest('hex');",
    reason:
      'raw bytes: SHA-256 of regular UTF-8 systemd fragments for exact release-file comparison; not a structured record or authority digest',
  },
  {
    path: 'apps/api/src/dogfood/config.ts',
    line: "const storedKey = createHash('sha256').update(clientKey).digest();",
    reason: 'protocol: SCRAM-SHA-256 StoredKey = H(ClientKey), fixed by RFC 5802/7677',
  },
  {
    path: 'apps/api/src/dogfood/repository/legacy-actions.ts',
    line: "const legacyDigest = createHash('sha256')",
    reason:
      'legacy format: recomputes the recorded kf-action-legacy-v1 request digest of pre-semantic actions; its tag is a string prefix and it is verified as recorded',
  },
  {
    path: 'apps/api/src/ingest/cli.ts',
    line: 'idempotencyKey: `kf-ingest-v1-${digest({',
    reason:
      'UNTAGGED: idempotency-key material for one ingest act (prefixed kf-ingest-v1-, outside the preimage); key, not a recorded digest (remaining)',
  },
  {
    path: 'apps/api/src/master-record/cli.ts',
    line: "const idempotencyKey = createHash('sha256')",
    reason: 'not a digest: a random idempotency key, hashed only to shape it',
  },
  {
    path: 'packages/export/src/warrant-runtime-evidence.ts',
    line: 'const computed = digest({',
    reason:
      "self-tagged: OpenWarrant's dispatch digest, whose preimage carries digest_domain oh.war/dispatch/v1",
  },
  {
    path: 'apps/api/src/overview/collect.ts',
    line: "const hash = createHash('sha256').update('kf-overview-v1');",
    reason: 'self-tagged: streamed over file bytes with kf-overview-v1 as its first input',
  },
  {
    path: 'apps/api/src/routes/context-source.ts',
    line: "if (body === undefined || digestBytes(Buffer.from(body, 'utf8')) !== reference.digest) {",
    reason:
      "protocol: LAMU's SourceRef.digest is the bare SHA-256 of the served text, which context_kf.rs recomputes over the bytes it receives; for a text source it equals the artifact version's recorded sha256",
  },
  {
    path: 'apps/api/src/routes/documents/master-record-link-route.ts',
    line: "const suppliedDigest = digestBytes(Buffer.from(request.params.token, 'utf8'));",
    reason:
      'secret: hashes a bearer link token to look it up; the token is opaque text, not a structure',
  },
  {
    path: 'apps/api/src/routes/documents/master-record-link-route.ts',
    line: 'digest(link.scope) !== digest(claims.scope)',
    reason: 'equality: canonical comparison of two scopes; nothing is recorded',
  },
  {
    path: 'apps/api/src/routes/ml/promotion-key.ts',
    line: "createHash('sha256').update(publicKeyBytes).digest('hex') !== publicKeyDigest ||",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'apps/checkpoint/src/merkle.ts',
    line: "const h = createHash('sha256');",
    reason: 'protocol: Merkle node hashing over leaf/node bytes with its own domain prefixes',
  },
  {
    path: 'apps/kf-storage/src/verify-object-store.ts',
    line: "sha256: createHash('sha256').update(bytes).digest('hex'),",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'apps/web/src/lib/auth/context.ts',
    line: "challenge: createHash('sha256').update(verifier).digest('base64url'),",
    reason: 'protocol: PKCE S256 code challenge, fixed by RFC 7636',
  },
  {
    path: 'apps/worker/src/compiler-runtime/runtime.ts',
    line: "const bytes = createHash('sha256')",
    reason:
      'protocol: UUIDv8 run id derived from a namespace and the action id (RFC 9562); an identifier, not a digest',
  },
  {
    path: 'packages/agent-tools/src/ai/proposal.ts',
    line: 'content_digest: digest(item.content),',
    reason:
      'UNTAGGED: AI planner content/instruction/context digests, owned by the read-grant work this pass (remaining)',
  },
  {
    path: 'packages/agent-tools/src/ai/proposal.ts',
    line: 'const instructionDigest = digest(request.instruction);',
    reason:
      'UNTAGGED: AI planner content/instruction/context digests, owned by the read-grant work this pass (remaining)',
  },
  {
    path: 'packages/artifacts/src/store.ts',
    line: "return createHash('sha256').update(bytes).digest('hex');",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/authorization/src/access-grants.ts',
    line: 'return digest(explanation);',
    reason:
      'self-tagged: the explanation carries format kf-access-explanation-v2 inside the canonicalized body',
  },
  {
    path: 'packages/documents/src/compiler/acceptance.ts',
    line: 'if (digest(compilationRunPreimage(run)) !== run.runDigest) {',
    reason: 'self-tagged: the run preimage carries format kf-document-compilation-run-v2',
  },
  {
    path: 'packages/documents/src/compiler/basis.ts',
    line: 'return Object.freeze({ ...claim, basisDigest: digest(claim) });',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/bindings.ts',
    line: 'const valueDigest = digest(value);',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/bindings.ts',
    line: 'return Object.freeze({ ...claim, bindingDigest: digest(claim) });',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/composition.ts',
    line: 'return Object.freeze({ ...claim, revisionDigest: digest(claim) });',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/proposal-overlay.ts',
    line: 'return Object.freeze({ ...claim, proposalDigest: digest(claim) });',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/receipts.ts',
    line: "if (digestBytes(Buffer.from(canonicalPreimage, 'utf8')) !== runDigest) {",
    reason:
      'self-tagged: recomputes the recorded kf-document-compilation-run-v2 canonical preimage from its stored text',
  },
  {
    path: 'packages/documents/src/compiler/receipts.ts',
    line: "if (digest(row['semanticGraph']) !== row['semanticDigest']) {",
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/run.ts',
    line: 'compilerDigest: digest(basis.compiler),',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/run.ts',
    line: 'return markVerifiedCompilationRun({ ...claim, runDigest: digest(compilationRunPreimage(claim)) });',
    reason: 'self-tagged: the run preimage carries format kf-document-compilation-run-v2',
  },
  {
    path: 'packages/documents/src/compiler/run.ts',
    line: 'const compilerDigest = digest(compiler);',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/run.ts',
    line: 'if (compilerDigest !== digest(basis.compiler)) {',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/run.ts',
    line: 'if (digest(semanticGraph) !== response.semanticDigest) {',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/compiler/run.ts',
    line: 'runDigest: digest(compilationRunPreimage(claim)),',
    reason: 'self-tagged: the run preimage carries format kf-document-compilation-run-v2',
  },
  {
    path: 'packages/documents/src/compiler/source-holder.ts',
    line: 'return Object.freeze({ ...claim, revisionDigest: digest(claim) });',
    reason:
      'UNTAGGED: document-compiler protocol digest (kf-document-v1 is an envelope, not a digest tag); stored and exchanged with the Liminal compiler, needs a protocol version (remaining)',
  },
  {
    path: 'packages/documents/src/internal/compilation-authorization.ts',
    line: 'digest(preimage.semanticGraph) !== digest(receipt.semantic_graph) ||',
    reason:
      'equality: compares a preimage field with the recorded receipt field canonically; nothing is recorded',
  },
  {
    path: 'packages/documents/src/internal/compilation-authorization.ts',
    line: 'digest(preimage.hirProvenance) !== digest(receipt.hir_provenance) ||',
    reason:
      'equality: compares a preimage field with the recorded receipt field canonically; nothing is recorded',
  },
  {
    path: 'packages/documents/src/internal/compilation-authorization.ts',
    line: 'digest(preimage.cirProvenance) !== digest(receipt.cir_provenance) ||',
    reason:
      'equality: compares a preimage field with the recorded receipt field canonically; nothing is recorded',
  },
  {
    path: 'packages/documents/src/internal/compilation-authorization.ts',
    line: 'digest(preimage.unresolvedReferences) !== digest(receipt.unresolved_references) ||',
    reason:
      'equality: compares a preimage field with the recorded receipt field canonically; nothing is recorded',
  },
  {
    path: 'packages/documents/src/internal/compilation-authorization.ts',
    line: 'digest(preimage.omittedSubgraphs) !== digest(receipt.omitted_subgraphs) ||',
    reason:
      'equality: compares a preimage field with the recorded receipt field canonically; nothing is recorded',
  },
  {
    path: 'packages/documents/src/internal/compilation-authorization.ts',
    line: 'digest(preimage.projectionCapabilities) !== digest(receipt.projection_capabilities) ||',
    reason:
      'equality: compares a preimage field with the recorded receipt field canonically; nothing is recorded',
  },
  {
    path: 'packages/documents/src/internal/compilation-authorization.ts',
    line: 'digest(preimage.diagnostics) !== digest(receipt.diagnostics) ||',
    reason:
      'equality: compares a preimage field with the recorded receipt field canonically; nothing is recorded',
  },
  {
    path: 'packages/documents/src/internal/compilation-authorization.ts',
    line: 'digest(preimage.conversionLoss) !== digest(receipt.conversion_loss) ||',
    reason:
      'equality: compares a preimage field with the recorded receipt field canonically; nothing is recorded',
  },
  {
    path: 'packages/documents/src/internal/compilation-authorization.ts',
    line: 'digest(preimage.views) !== digest(recordedViewClaims)',
    reason:
      'equality: compares a preimage field with the recorded receipt field canonically; nothing is recorded',
  },
  {
    path: 'packages/documents/src/internal/pandoc-projection.ts',
    line: 'if (document.meta !== undefined && digest(document.meta as JsonValue) !== digest({})) {',
    reason: 'equality: tests Pandoc metadata for emptiness; nothing is recorded',
  },
  {
    path: 'packages/documents/src/lamquant-compat/manifest.ts',
    line: "sha256: createHash('sha256').update(bytes).digest('hex'),",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/documents/src/lamquant-compat/manifest.ts',
    line: 'return digest({ commitSha, expected, actual });',
    reason: 'UNTAGGED: LamQuant golden-corpus manifest identity (remaining)',
  },
  {
    path: 'packages/documents/src/lamquant-compat/manifest.ts',
    line: 'return digest({ commitSha, manifest });',
    reason: 'UNTAGGED: LamQuant golden-corpus manifest identity (remaining)',
  },
  {
    path: 'packages/documents/src/lamquant-compat/semantic-generated.ts',
    line: "return createHash('sha256').update(text).digest('hex');",
    reason:
      "raw bytes: hashes normalized generated Markdown text, compared with LamQuant's own recorded file hashes",
  },
  {
    path: 'packages/documents/src/lamquant-compat/semantic-projection.ts',
    line: "return createHash('sha256').update(text).digest('hex');",
    reason:
      "raw bytes: hashes normalized Markdown text, compared with LamQuant's own recorded file hashes",
  },
  {
    path: 'packages/documents/src/lamquant-compat/source-contracts.ts',
    line: "sha256: createHash('sha256').update(bytes).digest('hex'),",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/documents/src/liminal-adapter/identity.ts',
    line: 'return digest(entries.map(({ path, contentDigest }) => ({ path, contentDigest })));',
    reason: 'UNTAGGED: Liminal runtime-closure digest, pinned in the compiler identity (remaining)',
  },
  {
    path: 'packages/documents/src/liminal-adapter/identity.ts',
    line: "const hash = createHash('sha256');",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/documents/src/master-record-links.ts',
    line: "return digestBytes(Buffer.from(token, 'utf8'));",
    reason: 'secret: hashes a bearer link token for storage; opaque text, not a structure',
  },
  {
    path: 'packages/documents/src/master-record-repository.ts',
    line: 'digest(compilation.manifest),',
    reason:
      'self-tagged: record_digest is over the manifest, which carries its own format (kf-master-record-v3)',
  },
  {
    path: 'packages/documents/src/master-record.ts',
    line: 'return digest(preimage);',
    reason:
      'legacy format: kf-master-record-member-v1, the untagged member digest v1/v2 claims recorded and are re-checked under',
  },
  {
    path: 'packages/documents/src/master-record.ts',
    line: "return digestBytes(Buffer.from([...lines].sort(byteOrder).join('\\n'), 'utf8'));",
    reason:
      'UNTAGGED: corpus and permission line digests, reproduced by content.master_record_corpus_digest in SQL (remaining)',
  },
  {
    path: 'packages/documents/src/proposal/model-provenance.ts',
    line: '? digest(fields)',
    reason:
      'legacy format: kf-ai-proposal-context-v1, the untagged context digest stored proposals recorded and are re-verified under',
  },
  {
    path: 'packages/export/src/backup-manifest/file-tree.ts',
    line: "const hash = createHash('sha256');",
    reason: "raw bytes: streamed over a backup tree's paths and file bytes",
  },
  {
    path: 'packages/export/src/internal/offsite/io.ts',
    line: "const hash = createHash('sha256');",
    reason:
      'raw bytes: streamed ciphertext SHA-256 for exact-version transfer/read-back, compatible with ops.backup_copy.ciphertext_sha256 and sha256sum; not a semantic-record digest',
  },
  {
    path: 'packages/export/src/internal/importer/legacy-actions.ts',
    line: "return createHash('sha256').update(`kf-action-legacy-v1:${actionId}`, 'utf8').digest('hex');",
    reason:
      'legacy format: recomputes the recorded kf-action-legacy-v1 request digest of pre-semantic actions; its tag is a string prefix and it is verified as recorded',
  },
  {
    path: 'packages/integration/src/federation.ts',
    line: "return createHash('sha256')",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/ml-registry/src/internal/lineage.ts',
    line: 'return Object.freeze({ ...unsigned, authorizationDigest: digest(unsigned) });',
    reason: 'self-tagged: the unsigned body carries schemaVersion kf.ml.*.vN',
  },
  {
    path: 'packages/ml-registry/src/internal/metric-events.ts',
    line: 'const candidate = Object.freeze({ ...unsigned, eventDigest: digest(unsigned) });',
    reason: 'self-tagged: the unsigned body carries schemaVersion kf.ml.*.vN',
  },
  {
    path: 'packages/ml-registry/src/internal/metric-events.ts',
    line: 'const runIdentity = digest(candidate.run);',
    reason:
      'UNTAGGED: ML registry sub-digest (run identity, event manifest, evidence) inside a schemaVersion-tagged receipt (remaining)',
  },
  {
    path: 'packages/ml-registry/src/internal/metric-segments.ts',
    line: 'eventManifestDigest: digest(eventDigests),',
    reason:
      'UNTAGGED: ML registry sub-digest (run identity, event manifest, evidence) inside a schemaVersion-tagged receipt (remaining)',
  },
  {
    path: 'packages/ml-registry/src/internal/metric-segments.ts',
    line: 'return Object.freeze({ ...unsigned, metadataDigest: digest(unsigned) });',
    reason: 'self-tagged: the unsigned body carries schemaVersion kf.ml.*.vN',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-receipts.ts',
    line: 'const byDigest = evidence.map((reference) => ({ reference, digest: digest(reference) }));',
    reason:
      'UNTAGGED: ML registry sub-digest (run identity, event manifest, evidence) inside a schemaVersion-tagged receipt (remaining)',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-receipts.ts',
    line: 'if (digest(qualityAuthorityDecision) === digest(technicalAuthorityDecision)) {',
    reason: 'equality: two decisions must differ; nothing is recorded',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-receipts.ts',
    line: 'const evidenceDigests = new Set(evidence.map((reference) => digest(reference)));',
    reason:
      'UNTAGGED: ML registry sub-digest (run identity, event manifest, evidence) inside a schemaVersion-tagged receipt (remaining)',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-receipts.ts',
    line: 'if (!evidenceDigests.has(digest(technicalAuthorityDecision))) {',
    reason:
      'UNTAGGED: ML registry sub-digest (run identity, event manifest, evidence) inside a schemaVersion-tagged receipt (remaining)',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-receipts.ts',
    line: 'if (!evidenceDigests.has(digest(qualityAuthorityDecision))) {',
    reason:
      'UNTAGGED: ML registry sub-digest (run identity, event manifest, evidence) inside a schemaVersion-tagged receipt (remaining)',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-receipts.ts',
    line: 'evidenceSetDigest: digest(normalized.evidence),',
    reason:
      'UNTAGGED: ML registry sub-digest (run identity, event manifest, evidence) inside a schemaVersion-tagged receipt (remaining)',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-receipts.ts',
    line: 'receiptDigest: digest(unsigned),',
    reason: 'self-tagged: the unsigned body carries schemaVersion kf.ml.*.vN',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-receipts.ts',
    line: 'if (evidenceSetDigest !== digest(normalized.evidence)) {',
    reason:
      'UNTAGGED: ML registry sub-digest (run identity, event manifest, evidence) inside a schemaVersion-tagged receipt (remaining)',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-receipts.ts',
    line: "if (typeof receipt.receiptDigest !== 'string' || digest(unsigned) !== receipt.receiptDigest) {",
    reason: 'self-tagged: the unsigned body carries schemaVersion kf.ml.*.vN',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-revocations.ts',
    line: 'revocationDigest: digest(unsigned),',
    reason: 'self-tagged: the unsigned body carries schemaVersion kf.ml.*.vN',
  },
  {
    path: 'packages/ml-registry/src/internal/promotion-revocations.ts',
    line: 'digest(unsigned) !== revocation.revocationDigest',
    reason: 'self-tagged: the unsigned body carries schemaVersion kf.ml.*.vN',
  },
  {
    path: 'packages/ml-registry/src/internal/run-seal.ts',
    line: 'if (digest(segment.run) !== digest(lineage.run)) {',
    reason: 'equality: a segment must name the lineage run; nothing is recorded',
  },
  {
    path: 'packages/ml-registry/src/internal/run-seal.ts',
    line: 'lineageDigest: digest(lineage),',
    reason: 'self-tagged: the lineage carries schemaVersion kf.ml.run-lineage.v1',
  },
  {
    path: 'packages/ml-registry/src/internal/run-seal.ts',
    line: 'eventManifestDigest: digest(segments.flatMap((segment) => segment.eventDigests)),',
    reason:
      'UNTAGGED: ML registry sub-digest (run identity, event manifest, evidence) inside a schemaVersion-tagged receipt (remaining)',
  },
  {
    path: 'packages/ml-registry/src/internal/run-seal.ts',
    line: 'sealDigest: digest(unsigned),',
    reason: 'self-tagged: the unsigned body carries schemaVersion kf.ml.*.vN',
  },
  {
    path: 'packages/ml-registry/src/internal/run-seal.ts',
    line: "if (typeof seal.sealDigest !== 'string' || digest(unsigned) !== seal.sealDigest) {",
    reason: 'self-tagged: the unsigned body carries schemaVersion kf.ml.*.vN',
  },
  {
    path: 'packages/ontology-compiler/src/approval.ts',
    line: "manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'),",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/ontology-compiler/src/approval.ts',
    line: "const actual = createHash('sha256').update(bytes).digest('hex');",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/ontology-compiler/src/approval.ts',
    line: "const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/ontology-compiler/src/pack.ts',
    line: "sha256: createHash('sha256').update(bytes).digest('hex'),",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/ontology-compiler/src/registry-pack.ts',
    line: 'return { ...parsed, sourceDigest: digest(parsed) };',
    reason: 'UNTAGGED: ontology/registry source digest recorded in the generated pack (remaining)',
  },
  {
    path: 'packages/ontology-compiler/src/registry-pack.ts',
    line: "sha256: createHash('sha256').update(bytes).digest('hex'),",
    reason:
      'raw bytes: hashes bytes as received or stored, never canonical JSON — exempt by design',
  },
  {
    path: 'packages/operations/src/internal/commissioning/host.ts',
    line: "digest = createHash('sha256').update(bytes).digest('hex');",
    reason: 'raw bytes: hashes a host file or unit text as installed',
  },
  {
    path: 'packages/operations/src/internal/commissioning/units.ts',
    line: "digest: createHash('sha256').update(text).digest('hex'),",
    reason: 'raw bytes: hashes a host file or unit text as installed',
  },
  {
    path: 'packages/work-control/src/internal/observations.ts',
    line: "const digest = createHash('sha256').update(gesture.body, 'utf8').digest('hex');",
    reason: 'raw bytes: hashes an observation body as typed',
  },
];

/**
 * Digests the database takes (SAS §100.27: the TypeScript scan alone missed them). Keyed like
 * ALLOWED; `superseded` names a body a later migration replaced, which still shows in its file.
 */
const ALLOWED_SQL: readonly Allowed[] = [
  {
    path: 'database/migrations/20260814000200_ml_registry.sql',
    line: "sha256(convert_to(v_manifest_canonical, 'UTF8')),",
    reason:
      'UNTAGGED: ml.enforce_run_seal (trigger run_seal_validate, live) — segment-manifest digest over a bare JSON array; recorded in ml.run_seal.segment_manifest_sha256 (remaining)',
  },
  {
    path: 'database/migrations/20260814000300_secure_object_authority.sql',
    line: "public_key_sha256 = encode(digest(decode(public_key_spki_der_base64, 'base64'), 'sha256'), 'hex')",
    reason:
      'raw bytes: check constraint authority_signing_key_material_digest — SHA-256 of DER public-key bytes',
  },
  {
    path: 'database/migrations/20260814000800_ml_promotion_signature_authority.sql',
    line: "ml.ed25519_le_to_numeric(public.digest(v_r_encoded || p_public_key_raw || p_message, 'sha512')),",
    reason: 'protocol: ml.verify_ed25519 — SHA-512 of R||A||M is RFC 8032 Ed25519 verification',
  },
  {
    path: 'database/migrations/20260814000800_ml_promotion_signature_authority.sql',
    line: "public.digest(decode(public_key_spki_der_base64, 'base64'), 'sha256'),",
    reason:
      'raw bytes: ml.promotion_signing_key table constraint — SHA-256 of DER public-key bytes',
  },
  {
    path: 'database/migrations/20260814000800_ml_promotion_signature_authority.sql',
    line: 'public.digest(',
    reason:
      'UNTAGGED: ml.append_signed_promotion_receipt — digest of canonical_aggregate_reference (no tag), used to order evidence; mirrors TS digest(reference) (remaining)',
  },
  {
    path: 'database/migrations/20260814000800_ml_promotion_signature_authority.sql',
    line: "public.digest(convert_to(v_evidence_json, 'UTF8'), 'sha256'),",
    reason:
      'UNTAGGED: ml.append_signed_promotion_receipt — evidenceSetDigest over bare JSON array; recorded inside the kf.ml.promotion-receipt.v1 receipt (remaining)',
  },
  {
    path: 'database/migrations/20260814000800_ml_promotion_signature_authority.sql',
    line: "public.digest(convert_to(v_unsigned_receipt, 'UTF8'), 'sha256'),",
    reason:
      'self-tagged: ml.append_signed_promotion_receipt — unsigned receipt carries schemaVersion kf.ml.promotion-receipt.v1',
  },
  {
    path: 'database/migrations/20260814000800_ml_promotion_signature_authority.sql',
    line: "public.digest(convert_to(v_unsigned_revocation, 'UTF8'), 'sha256'),",
    reason:
      'self-tagged: ml.append_signed_promotion_revocation — preimage carries schemaVersion kf.ml.promotion-revocation.v1',
  },
  {
    path: 'database/migrations/20260814001200_ml_typed_actions.sql',
    line: "return encode(public.digest(convert_to(v_event_json, 'UTF8'), 'sha256'), 'hex');",
    reason:
      'self-tagged: ml.canonical_metric_event_sha256 — event JSON carries schemaVersion kf.ml.metric-event.v1',
  },
  {
    path: 'database/migrations/20260814001300_ml_run_seal_authority.sql',
    line: "public.digest(decode(public_key_spki_der_base64, 'base64'), 'sha256'),",
    reason: 'raw bytes: ml.run_seal_signing_key table constraint — SHA-256 of DER public-key bytes',
  },
  {
    path: 'database/migrations/20260814001300_ml_run_seal_authority.sql',
    line: "public.digest(convert_to(v_lineage_json, 'UTF8'), 'sha256'),",
    reason:
      'superseded: ml.append_signed_run_seal v1, renamed append_signed_run_seal_v1_archive and execute revoked by 20260814002300; preimage kf.ml.run-lineage.v1',
  },
  {
    path: 'database/migrations/20260814001300_ml_run_seal_authority.sql',
    line: "public.digest(convert_to(v_segment_json, 'UTF8'), 'sha256'),",
    reason:
      'superseded: ml.append_signed_run_seal v1 (renamed _v1_archive, execute revoked, 20260814002300); preimage kf.ml.metric-segment.v1',
  },
  {
    path: 'database/migrations/20260814001300_ml_run_seal_authority.sql',
    line: "public.digest(convert_to(v_segment_manifest_json, 'UTF8'), 'sha256'),",
    reason:
      'superseded: ml.append_signed_run_seal v1 (renamed _v1_archive, execute revoked, 20260814002300); untagged segment-manifest array',
  },
  {
    path: 'database/migrations/20260814001300_ml_run_seal_authority.sql',
    line: "public.digest(convert_to(v_unsigned_seal, 'UTF8'), 'sha256'),",
    reason:
      'superseded: ml.append_signed_run_seal v1 (renamed _v1_archive, execute revoked, 20260814002300); preimage kf.ml.run-seal.v1',
  },
  {
    path: 'database/migrations/20260814001700_ml_human_promotion_authority.sql',
    line: "v_claim_sha256 := encode(public.digest(convert_to(v_claim, 'UTF8'), 'sha256'), 'hex');",
    reason:
      'superseded: ml.authorize_promotion_decision_action, replaced by 20260816000200 (same claim, kf.ml.promotion-decision.v1)',
  },
  {
    path: 'database/migrations/20260814001900_action_semantic_idempotency.sql',
    line: "public.digest(convert_to('kf-action-legacy-v1:' || id::text, 'UTF8'), 'sha256'),",
    reason:
      'legacy format: one-time UPDATE in migration 019 — kf-action-legacy-v1 reservation digest, tag prefixed in the preimage',
  },
  {
    path: 'database/migrations/20260814001900_action_semantic_idempotency.sql',
    line: "public.digest(convert_to('kf-action-legacy-v1:' || new.id::text, 'UTF8'), 'sha256'),",
    reason:
      'superseded: core.assert_action_semantic_scope, replaced by 20260814002800 (kf-action-legacy-v1 reservation digest)',
  },
  {
    path: 'database/migrations/20260814002200_compiler_preimage_provenance.sql',
    line: "if encode(public.digest(convert_to(new.loss_preimage, 'UTF8'), 'sha256'), 'hex')",
    reason:
      'superseded: content.verify_document_parse_preimage, replaced by 20260925114000 (kf-document-parse-v2); v1 loss digest untagged',
  },
  {
    path: 'database/migrations/20260814002200_compiler_preimage_provenance.sql',
    line: "if encode(public.digest(convert_to(new.projection_preimage, 'UTF8'), 'sha256'), 'hex')",
    reason:
      'superseded: content.verify_document_parse_preimage, replaced by 20260925114000 (kf-document-parse-v2); v1 content digest untagged',
  },
  {
    path: 'database/migrations/20260814002200_compiler_preimage_provenance.sql',
    line: "if encode(public.digest(convert_to(new.atom_preimage, 'UTF8'), 'sha256'), 'hex')",
    reason:
      'superseded: content.verify_document_atom_preimage, replaced by 20260925114000 (kf-document-atom-v1)',
  },
  {
    path: 'database/migrations/20260814002200_compiler_preimage_provenance.sql',
    line: "if encode(public.digest(convert_to(p_canonical_preimage, 'UTF8'), 'sha256'), 'hex')",
    reason:
      'self-tagged: content.record_compilation_preimage — run preimage carries format kf-document-compilation-run-v2 (exact keys checked)',
  },
  {
    path: 'database/migrations/20260814002200_compiler_preimage_provenance.sql',
    line: "or encode(public.digest(convert_to(p_semantic_preimage, 'UTF8'), 'sha256'), 'hex')",
    reason:
      'UNTAGGED: content.record_compilation_preimage — semantic-graph digest, no tag; recorded as compilation_run.semantic_digest (Liminal protocol) (remaining)',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_claim, 'UTF8'), 'sha256'),",
    reason:
      'self-tagged: ml.authorize_metric_stream_action — claim carries schemaVersion kf.ml.metric-write-authorization.v2',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_actual_manifest_json, 'UTF8'), 'sha256'),",
    reason:
      'UNTAGGED: ml.enforce_metric_segment_v2_event_manifest — event-manifest digest over bare JSON array; sub-digest of the v2 segment (remaining)',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_metadata, 'UTF8'), 'sha256'),",
    reason:
      'self-tagged: ml.enforce_metric_segment_v2_event_manifest — metadata carries schemaVersion kf.ml.metric-segment.v2',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_event_manifest_json, 'UTF8'), 'sha256'),",
    reason:
      'UNTAGGED: ml.enforce_run_seal_v2_event_manifest — event-manifest digest over bare JSON array; recorded on ml.run_seal (remaining)',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_lineage_json, 'UTF8'), 'sha256'),",
    reason:
      'self-tagged: ml.append_signed_run_seal (v2) — lineage preimage carries schemaVersion kf.ml.run-lineage.v1',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_segment_event_manifest_json, 'UTF8'), 'sha256'),",
    reason:
      'UNTAGGED: ml.append_signed_run_seal (v2) — per-segment event-manifest digest over bare JSON array; inside kf.ml.metric-segment.v2 (remaining)',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_segment_json, 'UTF8'), 'sha256'),",
    reason:
      'self-tagged: ml.append_signed_run_seal (v2) — segment preimage carries schemaVersion kf.ml.metric-segment.v2',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_global_event_manifest_json, 'UTF8'), 'sha256'),",
    reason:
      'UNTAGGED: ml.append_signed_run_seal (v2) — global event-manifest digest over bare JSON array; recorded inside kf.ml.run-seal.v2 (remaining)',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_segment_manifest_json, 'UTF8'), 'sha256'),",
    reason:
      'UNTAGGED: ml.append_signed_run_seal (v2) — segment-manifest digest over bare JSON array; recorded inside kf.ml.run-seal.v2 (remaining)',
  },
  {
    path: 'database/migrations/20260814002300_ml_segment_event_binding.sql',
    line: "public.digest(convert_to(v_unsigned_seal, 'UTF8'), 'sha256'),",
    reason:
      'self-tagged: ml.append_signed_run_seal (v2) — unsigned seal carries schemaVersion kf.ml.run-seal.v2',
  },
  {
    path: 'database/migrations/20260814002550_legacy_action_cohort_recovery.sql',
    line: 'public.digest(',
    reason:
      'legacy format: one-time DO block (migration 025.5) recomputing the kf-action-legacy-v1 reservation digest; tag prefixed in preimage',
  },
  {
    path: 'database/migrations/20260814002550_legacy_action_cohort_recovery.sql',
    line: "public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),",
    reason:
      'legacy format: one-time DO block recomputing the kf-action-legacy-v1 reservation digest; tag prefixed in preimage',
  },
  {
    path: 'database/migrations/20260814002800_legacy_action_digest_reservation.sql',
    line: "public.digest(convert_to('kf-action-legacy-v1:' || new.id::text, 'UTF8'), 'sha256'),",
    reason:
      'legacy format: core.assert_action_semantic_scope (live) — refuses kf-action-legacy-v1 reservation digest; tag prefixed in preimage',
  },
  {
    path: 'database/migrations/20260814002800_legacy_action_digest_reservation.sql',
    line: "public.digest(convert_to('kf-action-legacy-v1:' || action.id::text, 'UTF8'), 'sha256'),",
    reason:
      'legacy format: one-time DO block checking the kf-action-legacy-v1 reservation digest; tag prefixed in preimage',
  },
  {
    path: 'database/migrations/20260815000200_ml_registry_bootstrap_actions.sql',
    line: "v_computed_sha256 := encode(public.digest(convert_to(v_lineage_json, 'UTF8'), 'sha256'), 'hex');",
    reason:
      'self-tagged: ml.register_run_lineage_action — lineage preimage carries schemaVersion kf.ml.run-lineage.v1',
  },
  {
    path: 'database/migrations/20260815000200_ml_registry_bootstrap_actions.sql',
    line: "public.digest(convert_to(v_manifest_json, 'UTF8'), 'sha256'), 'hex'",
    reason:
      'UNTAGGED: ml.register_metric_segment_action — event-manifest digest over bare JSON array; sub-digest of kf.ml.metric-segment.v2 (remaining)',
  },
  {
    path: 'database/migrations/20260815000200_ml_registry_bootstrap_actions.sql',
    line: "public.digest(convert_to(v_metadata_json, 'UTF8'), 'sha256'), 'hex'",
    reason:
      'self-tagged: ml.register_metric_segment_action — metadata carries schemaVersion kf.ml.metric-segment.v2',
  },
  {
    path: 'database/migrations/20260816000200_transaction_identity_width.sql',
    line: "v_claim_sha256 := encode(public.digest(convert_to(v_claim, 'UTF8'), 'sha256'), 'hex');",
    reason:
      'self-tagged: ml.authorize_promotion_decision_action (live) — claim carries schemaVersion kf.ml.promotion-decision.v1',
  },
  {
    path: 'database/migrations/20260901000100_master_record_corpus_identity.sql',
    line: "sha256(convert_to(coalesce(string_agg(line, E'\\n' order by line collate \"C\"), ''), 'UTF8')),",
    reason:
      'UNTAGGED: content.master_record_corpus_digest and content.master_record_permission_digest — sorted lines, no tag; mirror TS master-record.ts and are recorded with the master record (remaining)',
  },
  {
    path: 'database/migrations/20260923000200_writes_match_the_context.sql',
    line: "select encode(sha256(decode(p_prev_digest, 'hex') || convert_to(",
    reason:
      'legacy format: core.audit_event_digest (9-arg) — kf-audit-link-v1 links, still called by the v1 branch of 20260924001100 to verify recorded rows',
  },
  {
    path: 'database/migrations/20260924001000_the_person_is_present.sql',
    line: 'values (sha256(v_secret), p_person, p_assignment, p_organization, v_ceiling, v_expiry);',
    reason:
      'secret: core.issue_attestation — attestation secret hashed for lookup; superseded by 20260925100000 (dropped and recreated)',
  },
  {
    path: 'database/migrations/20260924001000_the_person_is_present.sql',
    line: "where a.digest = sha256(decode(p_attestation, 'hex'))",
    reason:
      'secret: core.bind_principal — attestation hashed for lookup; superseded by 20260925100000 create or replace',
  },
  {
    path: 'database/migrations/20260924001100_audit_links_name_their_format.sql',
    line: "return encode(sha256(decode(p_prev_digest, 'hex') || convert_to(",
    reason:
      'self-tagged: core.audit_event_digest (link-format variant) — kf-audit-link-v2 preimage carries "format":"kf-audit-link-v2"',
  },
  {
    path: 'database/migrations/20260925030200_an_observation_is_captured_then_promoted.sql',
    line: "new.body_sha256 := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');",
    reason:
      'raw bytes: content.observation_body_digest trigger — SHA-256 of the observation body as typed',
  },
  {
    path: 'database/migrations/20260925100000_an_agent_acts_for_a_named_human.sql',
    line: 'values (sha256(v_secret), p_person, p_assignment, p_organization, v_ceiling, v_expiry,',
    reason: 'secret: core.issue_attestation (live) — attestation secret hashed for lookup',
  },
  {
    path: 'database/migrations/20260925100000_an_agent_acts_for_a_named_human.sql',
    line: "where a.digest = sha256(decode(p_attestation, 'hex'))",
    reason:
      'secret: core.bind_principal (live, and the body its migrate:down restores) — a presented attestation hashed for lookup',
  },
  {
    path: 'database/migrations/20260925100000_an_agent_acts_for_a_named_human.sql',
    line: 'values (sha256(v_secret), p_person, p_assignment, p_organization, v_ceiling, v_expiry);',
    reason:
      'secret: core.issue_attestation in migrate:down (rollback restores earlier body) — attestation secret hashed for lookup',
  },
  {
    path: 'database/migrations/20260925114000_document_parse_digests_carry_tags.sql',
    line: "if encode(public.digest(convert_to(new.loss_preimage, 'UTF8'), 'sha256'), 'hex')",
    reason:
      'self-tagged: content.verify_document_parse_preimage (live) — loss preimage carries format kf-document-conversion-loss-v1',
  },
  {
    path: 'database/migrations/20260925114000_document_parse_digests_carry_tags.sql',
    line: "if encode(public.digest(convert_to(new.projection_preimage, 'UTF8'), 'sha256'), 'hex')",
    reason:
      'self-tagged: content.verify_document_parse_preimage (live) — projection preimage carries format kf-document-projection-v1',
  },
  {
    path: 'database/migrations/20260925114000_document_parse_digests_carry_tags.sql',
    line: "if encode(public.digest(convert_to(new.atom_preimage, 'UTF8'), 'sha256'), 'hex')",
    reason:
      'self-tagged: content.verify_document_atom_preimage (live) — atom preimage carries format kf-document-atom-v1',
  },
  {
    path: 'database/migrations/20260926110100_a_current_claim_is_known_without_recounting_it.sql',
    line: "select encode(sha256(convert_to(coalesce(string_agg(entry, E'\\n' order by entry), ''), 'UTF8')), 'hex')",
    reason:
      'equality: content.master_record_schema_fingerprint — catalog-xmin fingerprint stored as a cache-currency key and compared for equality',
  },
];

/**
 * The UNTAGGED entries, counted. A ceiling, not a target: closing a gap lowers it in the same
 * commit, and an entry added under UNTAGGED fails here rather than slipping into the list. Last
 * lowered for SAS §100.27 from 35 TypeScript entries, when the five owner-credential admin acts,
 * the master-record link payload and the ontology source digest took tags.
 */
const UNTAGGED_CEILING = { typescript: 28, sql: 11 } as const;

const untaggedCount = (allowed: readonly Allowed[]): number =>
  allowed.filter((entry) => entry.reason.startsWith('UNTAGGED')).length;

function unexplained(findings: readonly DigestFinding[], allowed: readonly Allowed[]): string[] {
  const keys = new Set(allowed.map((entry) => `${entry.path}\u0000${entry.line}`));
  return findings
    .filter((finding) => !keys.has(`${finding.path}\u0000${finding.text}`))
    .map((finding) => `${finding.path}:${String(finding.line)}: ${finding.text}`);
}

function stale(findings: readonly DigestFinding[], allowed: readonly Allowed[]): string[] {
  const seen = new Set(findings.map((finding) => `${finding.path}\u0000${finding.text}`));
  return allowed
    .filter((entry) => !seen.has(`${entry.path}\u0000${entry.line}`))
    .map((entry) => `${entry.path}: ${entry.line}`);
}

describe('every digest carries its format tag, or says why not (KF-SAS-RQ-016)', () => {
  const sources = productionSources(ROOT);
  const findings = scanDigests(ROOT, sources);

  it('scans the production source it claims to (non-vacuous)', () => {
    expect(sources.length).toBeGreaterThan(300);
    expect(sources).toContain('packages/actions/src/internal/state.ts');
    expect(sources.some((path) => path.endsWith('.test.ts'))).toBe(false);
    expect(findings.length).toBeGreaterThan(20);
  });

  it('finds no untagged digest the allowlist does not explain', () => {
    expect(unexplained(findings, ALLOWED)).toEqual([]);
  });

  it('carries no stale entry: each names a line that still exists', () => {
    expect(stale(findings, ALLOWED)).toEqual([]);
  });

  it('gives every entry a reason of a known kind, and no duplicates', () => {
    const kinds =
      /^(raw bytes|self-tagged|equality|legacy format|protocol|secret|not a digest|UNTAGGED): ./;
    for (const entry of ALLOWED) expect(entry.reason, entry.path).toMatch(kinds);
    expect(ALLOWED.some((entry) => entry.reason.startsWith('superseded'))).toBe(false);
    const keys = ALLOWED.map((entry) => `${entry.path}\u0000${entry.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('holds the untagged list at or below its ceiling (it can only shrink)', () => {
    expect(untaggedCount(ALLOWED)).toBeLessThanOrEqual(UNTAGGED_CEILING.typescript);
    expect(untaggedCount(ALLOWED_SQL)).toBeLessThanOrEqual(UNTAGGED_CEILING.sql);
    // A ceiling left above the count would let a new gap in silently; lower it with the fix.
    expect(untaggedCount(ALLOWED)).toBe(UNTAGGED_CEILING.typescript);
    expect(untaggedCount(ALLOWED_SQL)).toBe(UNTAGGED_CEILING.sql);
  });

  it('finds planted bare digests and leaves the tagged form and hash methods alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'kf-digest-scan-'));
    try {
      mkdirSync(join(root, 'packages', 'planted', 'src'), { recursive: true });
      mkdirSync(join(root, 'apps', 'planted', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'planted', 'src', 'uses-canonical.ts'),
        [
          "import { digest, digestBytes, taggedDigest } from '@kf/canonicalization';",
          'export const a = digest({ a: 1 });',
          "export const b = taggedDigest('kf-planted-v1', { a: 1 });",
          "export const c = digestBytes(Buffer.from('text', 'utf8'));",
          'export const d = digestBytes(received);',
          '// digest(x) in a comment computes nothing',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(root, 'apps', 'planted', 'src', 'by-hand.ts'),
        [
          "import { createHash } from 'node:crypto';",
          "export const e = createHash('sha256').update('x').digest('hex');",
          'function digest(value: string): string { return value; }',
          "export const f = digest('local, not canonical');",
          '',
        ].join('\n'),
      );
      const planted = scanDigests(root, [
        'packages/planted/src/uses-canonical.ts',
        'apps/planted/src/by-hand.ts',
      ]);
      expect(planted.map((finding) => `${finding.path}:${String(finding.line)}`)).toEqual([
        'packages/planted/src/uses-canonical.ts:2',
        'packages/planted/src/uses-canonical.ts:4',
        'apps/planted/src/by-hand.ts:2',
      ]);
      expect(unexplained(planted, ALLOWED)).toHaveLength(3);
      expect(
        stale(planted, [{ path: 'gone.ts', line: 'digest(x)', reason: 'equality: x' }]),
      ).toEqual(['gone.ts: digest(x)']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('every digest the database takes carries its format tag, or says why not (SAS §100.27)', () => {
  const migrations = migrationSources(ROOT);
  const findings = scanSqlDigests(ROOT, migrations);

  it('scans the migrations it claims to (non-vacuous)', () => {
    expect(migrations.length).toBeGreaterThan(100);
    expect(migrations).toContain(
      'database/migrations/20260901000100_master_record_corpus_identity.sql',
    );
    expect(findings.length).toBeGreaterThan(40);
  });

  it('finds no untagged SQL digest the allowlist does not explain', () => {
    expect(unexplained(findings, ALLOWED_SQL)).toEqual([]);
  });

  it('carries no stale SQL entry: each names a line that still exists', () => {
    expect(stale(findings, ALLOWED_SQL)).toEqual([]);
  });

  it('gives every SQL entry a reason of a known kind, and no duplicates', () => {
    const kinds =
      /^(raw bytes|self-tagged|equality|legacy format|protocol|secret|not a digest|superseded|UNTAGGED): ./;
    for (const entry of ALLOWED_SQL) expect(entry.reason, entry.path).toMatch(kinds);
    const keys = ALLOWED_SQL.map((entry) => `${entry.path}\u0000${entry.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('finds planted SQL digests, in both spellings, and leaves comments and names alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'kf-digest-scan-sql-'));
    try {
      mkdirSync(join(root, 'database', 'migrations'), { recursive: true });
      writeFileSync(
        join(root, 'database', 'migrations', '20990101000000_planted.sql'),
        [
          "select encode(sha256(convert_to('x', 'UTF8')), 'hex');",
          "select encode(public.digest(convert_to('x', 'UTF8'), 'sha256'), 'hex');",
          "select encode(digest('x', 'sha256'), 'hex');",
          '-- sha256(x) in a comment computes nothing',
          'select ml.canonical_metric_event_sha256(1);',
          'select a.digest from t a;',
          '',
        ].join('\n'),
      );
      const planted = scanSqlDigests(root, ['database/migrations/20990101000000_planted.sql']);
      expect(planted.map((finding) => finding.line)).toEqual([1, 2, 3]);
      expect(unexplained(planted, ALLOWED_SQL)).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
