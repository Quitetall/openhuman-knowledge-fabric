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
 *   UNTAGGED     — a named gap that remains, with where it lives. These are the work left.
 *
 * An entry is keyed by file and the exact trimmed source line. Reformatting a line makes its
 * entry stale, which fails here too: look at it again rather than re-pasting the text.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { productionSources, scanDigests, type DigestFinding } from './digest-scan.js';

const ROOT = join(import.meta.dirname, '..', '..');

interface Allowed {
  readonly path: string;
  readonly line: string;
  readonly reason: string;
}

const ALLOWED: readonly Allowed[] = [
  {
    path: 'apps/api/src/admin/bootstrap-organization.ts',
    line: "createHash('sha256').update(`bootstrap-organization\\u0000${reason}`).digest('hex'),",
    reason:
      'UNTAGGED: request_digest of the bootstrap act, a hand-built string; stored in core.action (remaining)',
  },
  {
    path: 'apps/api/src/admin/declare-service-actor.ts',
    line: "const requestDigest = createHash('sha256')",
    reason:
      'UNTAGGED: request_digest of an admin act over JSON.stringify, not RFC 8785; stored in core.action (remaining)',
  },
  {
    path: 'apps/api/src/admin/grant-authority.ts',
    line: "const requestDigest = createHash('sha256')",
    reason:
      'UNTAGGED: request_digest of an admin act over JSON.stringify, not RFC 8785; stored in core.action (remaining)',
  },
  {
    path: 'apps/api/src/admin/retire-organization.ts',
    line: "createHash('sha256')",
    reason:
      'UNTAGGED: request_digest of the retire act, a hand-built string; stored in core.action (remaining)',
  },
  {
    path: 'apps/api/src/admin/revoke-identity.ts',
    line: "const requestDigest = createHash('sha256')",
    reason:
      'UNTAGGED: request_digest of an admin act over JSON.stringify, not RFC 8785; stored in core.action (remaining)',
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
    path: 'packages/documents/src/master-record-links.ts',
    line: "payload_digest: digestBytes(Buffer.from(JSON.stringify(claims.scope), 'utf8')),",
    reason: 'UNTAGGED: link payload digest over JSON.stringify, not RFC 8785 (remaining)',
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
    path: 'packages/ontology-compiler/src/model.ts',
    line: 'return { ...ontology, sourceDigest: digest(ontology) };',
    reason: 'UNTAGGED: ontology/registry source digest recorded in the generated pack (remaining)',
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
    const keys = ALLOWED.map((entry) => `${entry.path}\u0000${entry.line}`);
    expect(new Set(keys).size).toBe(keys.length);
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
