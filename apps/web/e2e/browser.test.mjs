import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_ID = 'knowledge-fabric-web';
const SUBJECT = 'fixture-subject';
const ROLE_ID = '01900000-0000-7000-8000-000000000001';
const BAD_ROLE_ID = '01900000-0000-7000-8000-000000000099';
const ORGANIZATION_ID = '01900000-0000-7000-8000-000000000002';
const DOCUMENT_ID = 'document-constitution';
const TARGET_ID = '22222222-2222-7222-8222-222222222222';
const BASE_REVISION_ID = '33333333-3333-7333-8333-333333333333';
const HOLDER_ID = '44444444-4444-7444-8444-444444444444';
const BASIS_ID = '55555555-5555-7555-8555-555555555555';
const VIEW_ID = '66666666-6666-7666-8666-666666666666';
const RUN_AUTHORITY_ID = 'training-run:encoder-2026-08';
const RUN_REVISION_ID = 'r01';
const DIGEST = 'a'.repeat(64);
const SOURCE_BYTES = Buffer.from('# Purpose\n\nExact retained source.');
const PROJECTION_BYTES = Buffer.from('<h1>Purpose</h1><p>Exact retained projection.</p>');

function json(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  response.end(data);
}

function redirect(response, location) {
  response.writeHead(302, { location, 'cache-control': 'no-store' });
  response.end();
}

function binary(response, bytes, mediaType, fileName) {
  response.writeHead(200, {
    'content-type': mediaType,
    'content-length': bytes.byteLength,
    'content-disposition': `attachment; filename="${fileName}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(bytes);
}

async function requestBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`fixture request exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function reservePort() {
  const server = createServer();
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForWeb(origin, child, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next exited with ${child.exitCode}\n${logs()}`);
    }
    try {
      const response = await globalThis.fetch(origin, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Development server is still compiling.
    }
    await delay(150);
  }
  throw new Error(`Next did not become ready\n${logs()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), delay(5_000, undefined, { ref: false })]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function aggregateReference(kind, authorityId, revisionId) {
  return {
    kind,
    authorityId,
    revisionId,
    sha256: DIGEST,
    classificationId: 'internal',
    policyId: 'policy:ml-default',
  };
}

test(
  'dogfood OIDC, authority context, document workbench and ML projection hold in a browser',
  // Production Next builds share this workstation with long-running ML/fuzz jobs. Keep this
  // gate bounded, but leave enough headroom for a two-minute build before browser assertions.
  { timeout: 300_000 },
  async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const codes = new Map();
    const apiMutations = [];
    const apiRequests = [];
    let importedDocumentBytes = 0;
    let lastMlQuery;
    let readinessMode = 'ready';
    let forceDocumentListError = false;
    let fixtureOrigin = '';
    let webOrigin = '';
    let issuer = '';

    const fixture = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', fixtureOrigin);
        if (url.pathname === '/realms/kf/.well-known/openid-configuration') {
          return json(response, 200, {
            issuer,
            authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
            token_endpoint: `${issuer}/protocol/openid-connect/token`,
            jwks_uri: `${issuer}/protocol/openid-connect/certs`,
            end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
          });
        }
        if (url.pathname === '/realms/kf/protocol/openid-connect/auth') {
          assert.equal(request.method, 'GET');
          assert.equal(url.searchParams.get('response_type'), 'code');
          assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
          assert.equal(url.searchParams.get('redirect_uri'), `${webOrigin}/auth/callback`);
          assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
          assert.match(url.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
          assert.ok((url.searchParams.get('scope') ?? '').split(' ').includes('openid'));
          const state = url.searchParams.get('state');
          const nonce = url.searchParams.get('nonce');
          assert.ok(state);
          assert.ok(nonce);
          const code = randomBytes(24).toString('base64url');
          codes.set(code, {
            challenge: url.searchParams.get('code_challenge'),
            nonce,
          });
          const callback = new URL('/auth/callback', webOrigin);
          callback.searchParams.set('code', code);
          callback.searchParams.set('state', state);
          return redirect(response, callback.toString());
        }
        if (url.pathname === '/realms/kf/protocol/openid-connect/token') {
          assert.equal(request.method, 'POST');
          assert.match(
            request.headers['content-type'] ?? '',
            /^application\/x-www-form-urlencoded/,
          );
          const form = new globalThis.URLSearchParams(await requestBody(request));
          const code = form.get('code') ?? '';
          const transaction = codes.get(code);
          assert.ok(transaction, 'authorization code must be live and one-use');
          assert.equal(form.get('grant_type'), 'authorization_code');
          assert.equal(form.get('client_id'), CLIENT_ID);
          assert.equal(form.get('redirect_uri'), `${webOrigin}/auth/callback`);
          assert.equal(
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url'),
            transaction.challenge,
          );
          codes.delete(code);
          const idToken = await new SignJWT({ nonce: transaction.nonce })
            .setProtectedHeader({ alg: 'RS256', kid: 'fixture-signing-key' })
            .setIssuer(issuer)
            .setAudience(CLIENT_ID)
            .setSubject(SUBJECT)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);
          return json(response, 200, {
            access_token: 'fixture-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
          });
        }
        if (url.pathname === '/realms/kf/protocol/openid-connect/certs') {
          return json(response, 200, {
            keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid: 'fixture-signing-key' }],
          });
        }
        if (url.pathname === '/realms/kf/protocol/openid-connect/logout') {
          assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
          const destination = url.searchParams.get('post_logout_redirect_uri');
          assert.equal(destination, `${webOrigin}/`);
          return redirect(response, destination);
        }

        if (url.pathname.startsWith('/api/')) {
          apiRequests.push({
            method: request.method,
            path: url.pathname,
            headers: request.headers,
          });
          if (request.method !== 'GET') apiMutations.push(`${request.method} ${url.pathname}`);
          if (url.pathname === '/api/readiness' && request.method === 'GET') {
            if (readinessMode === 'malformed') {
              return json(response, 200, { ready: true, checks: [] });
            }
            const institutionalChecks = [
              {
                id: 'fixture_checkpoint',
                scope: 'institutional',
                status: 'failed',
                detail: 'Controlled browser fixture has no human-signed checkpoint evidence.',
                measured: { checkpoints: 0 },
              },
            ];
            if (readinessMode === 'failed') {
              const serviceChecks = [
                {
                  id: 'fixture_runtime',
                  scope: 'service',
                  status: 'failed',
                  detail: 'Controlled browser fixture reports a failed dependency.',
                  measured: { requests: apiRequests.length },
                },
              ];
              return json(response, 503, {
                ready: false,
                checks: serviceChecks,
                service: { ready: false, checks: serviceChecks },
                institutional: { ready: false, checks: institutionalChecks },
              });
            }
            const serviceChecks = [
              {
                id: 'fixture_runtime',
                scope: 'service',
                status: 'ok',
                detail: 'Controlled browser fixture reports its request path ready.',
                measured: { requests: apiRequests.length },
              },
            ];
            return json(response, 200, {
              ready: true,
              checks: serviceChecks,
              service: { ready: true, checks: serviceChecks },
              institutional: { ready: false, checks: institutionalChecks },
            });
          }
          if (
            request.headers.authorization !== 'Bearer fixture-access-token' ||
            request.headers['x-kf-organization'] !== ORGANIZATION_ID ||
            request.headers['x-kf-acting-role'] === BAD_ROLE_ID ||
            request.headers['x-kf-acting-role'] !== ROLE_ID
          ) {
            return json(response, 401, { error: 'unidentified', message: 'context refused' });
          }
          assert.equal(request.headers['x-kf-actor'], undefined);
          const classification = request.headers['x-kf-classification'];
          assert.ok(['public', 'internal', 'confidential', 'restricted'].includes(classification));

          if (url.pathname === '/api/search') {
            assert.equal(request.method, 'GET');
            assert.equal(url.searchParams.get('q'), 'constitution');
            assert.equal(url.searchParams.get('limit'), '50');
            if (classification === 'public') return json(response, 200, { hits: [] });
            assert.equal(classification, 'internal');
            return json(response, 200, {
              hits: [
                {
                  objectId: DOCUMENT_ID,
                  objectType: 'controlled_document',
                  title: 'OpenHuman Document Constitution',
                  lifecycleState: 'draft',
                  classification: 'internal',
                  rank: 0.98,
                  matchedBy: 'full_text',
                },
              ],
            });
          }

          const segments = url.pathname.split('/').slice(2).map(decodeURIComponent);
          if (segments.length === 1 && segments[0] === 'documents') {
            if (request.method === 'POST') {
              const body = JSON.parse(await requestBody(request, 16 * 1024 * 1024));
              const bytes = Buffer.from(body.contentBase64, 'base64');
              assert.equal(bytes.toString('base64'), body.contentBase64);
              assert.equal(bytes.length, 10 * 1024 * 1024);
              importedDocumentBytes = bytes.length;
              return json(response, 201, {
                id: DOCUMENT_ID,
                artifactId: 'fixture-artifact',
                fragmentId: 'fixture-fragment',
                fragmentRevisionId: 'fixture-fragment-revision',
                sha256: createHash('sha256').update(bytes).digest('hex'),
                replayed: false,
              });
            }
            assert.equal(request.method, 'GET');
            if (forceDocumentListError) {
              return json(response, 503, {
                error: 'document_projection_unavailable',
                message: 'Document projection is unavailable in the fixture.',
              });
            }
            if (classification === 'public') return json(response, 200, { documents: [] });
            return json(response, 200, {
              documents: [
                {
                  id: DOCUMENT_ID,
                  title: 'OpenHuman Document Constitution',
                  documentNumber: 'OH-DOC-000002-1',
                  revision: 'R01',
                  documentClass: 'policy',
                  lifecycleState: 'draft',
                  rowVersion: '1',
                  mediaType: 'text/markdown',
                  sha256: DIGEST,
                  parsedBlockCount: 8,
                },
              ],
            });
          }
          if (
            segments.length === 3 &&
            segments[0] === 'documents' &&
            segments[1] === DOCUMENT_ID &&
            segments[2] === 'workbench'
          ) {
            assert.equal(request.method, 'GET');
            return json(response, 200, {
              status: 'ready',
              target: {
                kind: 'authored_fragment',
                objectId: TARGET_ID,
                subjectId: 'fixture-subject-record',
                stableKey: 'document:constitution',
                documentPolicy: 'ordinary',
                baseRevisionId: BASE_REVISION_ID,
                rowVersion: '7',
                classification: 'internal',
                holderId: HOLDER_ID,
                holder: {
                  kind: 'fabric_native',
                  id: HOLDER_ID,
                  artifactVersionId: 'fixture-source-version',
                  contentDigest: DIGEST,
                  mediaType: 'text/markdown',
                },
                contentDigest: DIGEST,
                mediaType: 'text/markdown',
              },
              basis: {
                id: BASIS_ID,
                digest: 'b'.repeat(64),
                effectiveClassification: 'internal',
                finalizedAt: '2026-08-15T12:00:00.000Z',
                targetProfiles: [{ target: 'html', capabilities: ['human_readable'] }],
              },
              compilation: {
                runId: 'fixture-run-current',
                status: 'succeeded',
                draftOnly: true,
                semanticDigest: 'c'.repeat(64),
                diagnostics: [
                  { severity: 'warning', code: 'draft_only', message: 'Draft projection only' },
                ],
                conversionLoss: [],
                recordedAt: '2026-08-15T13:00:00.000Z',
              },
              projections: [
                {
                  id: VIEW_ID,
                  target: 'html',
                  mediaType: 'text/html',
                  artifactVersionId: 'fixture-projection-version',
                  contentDigest: 'd'.repeat(64),
                  effectiveClassification: 'internal',
                },
              ],
              composition: {
                rootRevisionId: '',
                nodes: [
                  {
                    revisionId: 'fixture-composition-revision',
                    subjectId: 'fixture-composition-subject',
                    objectId: 'fixture-composition-object',
                    title: 'Constitution composition',
                    stableKey: 'composition:constitution',
                    revisionDigest: '9'.repeat(64),
                    classification: 'internal',
                    createdAt: '2026-08-15T11:00:00.000Z',
                  },
                ],
                inputs: [
                  {
                    compositionRevisionId: 'fixture-composition-revision',
                    ordinal: 1,
                    role: 'fragment',
                    targetId: BASE_REVISION_ID,
                    targetTitle: 'Constitution source fragment',
                    contentDigest: DIGEST,
                  },
                ],
              },
              navigation: {
                backlinks: [
                  {
                    id: 'fixture-backlink',
                    relationType: 'references',
                    direction: 'inbound',
                    peerObjectId: 'fixture-policy-register',
                    peerObjectType: 'controlled_document',
                    peerTitle: 'Policy register',
                    recordedAt: '2026-08-15T11:30:00.000Z',
                  },
                ],
                traceability: [
                  {
                    id: 'fixture-traceability',
                    relationType: 'implements',
                    direction: 'outbound',
                    peerObjectId: 'fixture-requirement',
                    peerObjectType: 'requirement',
                    peerTitle: 'Preservation requirement',
                    recordedAt: '2026-08-15T11:40:00.000Z',
                  },
                ],
                adr: [
                  {
                    decisionId: 'fixture-adr-0002',
                    title: 'ADR-0002 Liminal-backed compiler',
                    lifecycleState: 'accepted',
                    latestProgressKind: 'implemented',
                    topicKey: 'document-compiler',
                  },
                ],
                topics: [
                  {
                    decisionId: 'fixture-adr-0002',
                    topicKey: 'document-compiler',
                    title: 'Document compiler',
                    lifecycleState: 'accepted',
                  },
                ],
              },
              semanticDiff: {
                status: 'available',
                fromRunId: 'fixture-run-previous',
                toRunId: 'fixture-run-current',
                changes: [{ kind: 'changed', path: '/purpose', before: 'old', after: 'current' }],
                truncated: false,
              },
            });
          }
          if (
            segments.length === 3 &&
            segments[0] === 'documents' &&
            segments[1] === DOCUMENT_ID &&
            segments[2] === 'source'
          ) {
            assert.equal(request.method, 'GET');
            return binary(response, SOURCE_BYTES, 'text/markdown', 'source.md');
          }
          if (
            segments.length === 4 &&
            segments[0] === 'documents' &&
            segments[1] === DOCUMENT_ID &&
            segments[2] === 'projections' &&
            segments[3] === VIEW_ID
          ) {
            assert.equal(request.method, 'GET');
            return binary(response, PROJECTION_BYTES, 'text/html', 'projection.html');
          }
          if (
            segments.length === 3 &&
            segments[0] === 'documents' &&
            segments[1] === DOCUMENT_ID &&
            segments[2] === 'proposals'
          ) {
            assert.equal(request.method, 'POST');
            const body = JSON.parse(await requestBody(request));
            assert.equal(body.basisId, BASIS_ID);
            assert.equal(body.basisDigest, 'b'.repeat(64));
            assert.equal(body.targetObjectId, TARGET_ID);
            assert.equal(body.baseRevisionId, BASE_REVISION_ID);
            assert.equal(body.targetRowVersion, '7');
            assert.equal(body.proposalKind, 'source_patch');
            assert.equal(body.operation.previous_holder_id, HOLDER_ID);
            return json(response, 201, {
              proposalId: body.proposalId,
              actionId: 'fixture-proposal-action',
              replayed: false,
              auditDigest: 'e'.repeat(64),
            });
          }
          if (segments.length === 2 && segments[0] === 'documents' && segments[1] === DOCUMENT_ID) {
            return json(response, 200, {
              id: DOCUMENT_ID,
              title: 'OpenHuman Document Constitution',
              documentNumber: 'OH-DOC-000002-1',
              revision: 'R01',
              documentClass: 'policy',
              lifecycleState: 'draft',
              rowVersion: '1',
              mediaType: 'text/markdown',
              sha256: DIGEST,
              parsedBlockCount: 8,
              owningRole: 'technical_authority',
              contentVersionId: 'fixture-artifact-version',
              sizeBytes: 321,
              parser: 'kf-markdown',
              parserVersion: '1.0.0',
              projectionContract: 'kf.pandoc-atoms.v2',
              conversionLoss: [],
              contentDigest: 'b'.repeat(64),
              sourceProvenance: {
                status: 'recorded',
                holderKind: 'fabric_native',
                fragmentId: 'fixture-fragment',
                fragmentRevisionId: 'fixture-fragment-revision',
                stableKey: 'openhuman.constitution.OH-DOC-000002-1',
                documentPolicy: 'controlled',
                holderId: 'fixture-holder',
                artifactVersionId: 'fixture-artifact-version',
                contentDigest: DIGEST,
                mediaType: 'text/markdown',
                classification: 'internal',
                revisionState: 'active',
                revisionDigest: 'b'.repeat(64),
                holderRecordedAt: '2026-08-14T12:00:00.123Z',
                holderRecordedByAction: 'fixture-holder-action',
                revisionCreatedAt: '2026-08-14T12:00:01.456Z',
                revisionCreatedByAction: 'fixture-revision-action',
              },
              parsedBlocks: [
                {
                  ordinal: 1,
                  kind: 'heading',
                  level: 1,
                  text: 'Purpose',
                  attributes: {},
                  digest: 'c'.repeat(64),
                },
                {
                  ordinal: 2,
                  kind: 'paragraph',
                  level: null,
                  text: 'The constitution governs controlled documentation.',
                  attributes: {},
                  digest: 'd'.repeat(64),
                },
                {
                  ordinal: 3,
                  kind: 'heading',
                  level: 2,
                  text: 'Authority boundaries',
                  attributes: {},
                  digest: 'e'.repeat(64),
                },
                {
                  ordinal: 4,
                  kind: 'list_item',
                  level: 1,
                  text: 'Auditable',
                  attributes: { list: 'bullet' },
                  digest: '4'.repeat(64),
                },
                {
                  ordinal: 5,
                  kind: 'list_item',
                  level: 1,
                  text: 'Reusable',
                  attributes: { list: 'bullet' },
                  digest: '5'.repeat(64),
                },
                {
                  ordinal: 6,
                  kind: 'heading',
                  level: 4,
                  text: 'Source H4',
                  attributes: {},
                  digest: '6'.repeat(64),
                },
                {
                  ordinal: 7,
                  kind: 'heading',
                  level: 5,
                  text: 'Source H5',
                  attributes: {},
                  digest: '7'.repeat(64),
                },
                {
                  ordinal: 8,
                  kind: 'heading',
                  level: 6,
                  text: 'Source H6',
                  attributes: {},
                  digest: '8'.repeat(64),
                },
              ],
            });
          }
          if (
            segments.length === 3 &&
            segments[0] === 'objects' &&
            segments[1] === DOCUMENT_ID &&
            segments[2] === 'available-actions'
          ) {
            return json(response, 200, {
              objectId: DOCUMENT_ID,
              objectType: 'controlled_document',
              state: 'draft',
              actions: [
                {
                  actionType: 'approve_controlled_document',
                  toStates: ['approved'],
                  requiresChoice: false,
                  reasonRequired: true,
                },
              ],
            });
          }
          if (
            segments.length === 5 &&
            segments[0] === 'ml' &&
            segments[1] === 'runs' &&
            segments[2] === RUN_AUTHORITY_ID &&
            segments[3] === 'revisions' &&
            segments[4] === RUN_REVISION_ID
          ) {
            lastMlQuery = new globalThis.URLSearchParams(url.searchParams);
            if (classification === 'public') return json(response, 404, { error: 'not_found' });
            const run = aggregateReference('run', RUN_AUTHORITY_ID, RUN_REVISION_ID);
            return json(response, 200, {
              schemaVersion: 'kf.ml.run-projection.v1',
              run,
              lineage: {
                lineageDigest: 'f'.repeat(64),
                recordedAt: '2026-08-14T12:00:00.000Z',
                code: aggregateReference('code', 'lamquant', 'e10fb063'),
                recipe: aggregateReference('recipe', 'clinical.encoder', 'r5'),
                environment: aggregateReference('environment', 'gpu-cluster', '2026-08-14'),
                metricPolicy: aggregateReference('metric_policy', 'encoder-quality', 'r1'),
                members: {
                  items: [
                    {
                      role: 'input',
                      ordinal: 1,
                      reference: aggregateReference('dataset', 'tusz-eval', 'frozen-1'),
                    },
                    {
                      role: 'output',
                      ordinal: 1,
                      reference: aggregateReference('model', 'clinical.encoder', 'candidate-7'),
                    },
                  ],
                  page: {
                    limit: Number(url.searchParams.get('memberLimit') ?? '100'),
                    afterMember: url.searchParams.get('afterMember'),
                    nextAfterMember: null,
                  },
                },
              },
              metrics: {
                events: [
                  {
                    sequence: '1',
                    recordedAt: '2026-08-14T12:01:00.000Z',
                    status: 'provisional',
                    metricId: 'validation.loss',
                    unitId: 'ratio',
                    value: { kind: 'number', number: 0.125 },
                    eventDigest: '1'.repeat(64),
                  },
                  {
                    sequence: '2',
                    recordedAt: '2026-08-14T12:02:00.000Z',
                    status: 'provisional',
                    metricId: 'model.family',
                    unitId: null,
                    value: { kind: 'safe_enum', enumId: 'clinical.encoder' },
                    eventDigest: '2'.repeat(64),
                  },
                ],
                page: {
                  limit: Number(url.searchParams.get('limit') ?? '100'),
                  afterSequence: url.searchParams.get('afterSequence') ?? '0',
                  nextAfterSequence: null,
                },
              },
              segments: {
                items: [
                  {
                    reference: aggregateReference('metric_segment', 'run-segment', '1'),
                    ordinal: 1,
                    firstSequence: '1',
                    lastSequence: '2',
                    eventCount: '2',
                    metadataDigest: '3'.repeat(64),
                  },
                ],
                page: {
                  limit: Number(url.searchParams.get('segmentLimit') ?? '100'),
                  afterOrdinal: Number(url.searchParams.get('afterOrdinal') ?? '0'),
                  nextAfterOrdinal: null,
                },
              },
              seal: {
                lineageDigest: 'f'.repeat(64),
                segmentManifestDigest: '6'.repeat(64),
                eventCount: '2',
                sealedAt: '2026-08-14T12:02:30.000Z',
                signingKeyId: 'fixture-run-seal-key',
                sealDigest: '7'.repeat(64),
                recordedAt: '2026-08-14T12:02:31.000Z',
              },
              promotions: {
                receipts: [
                  {
                    aliasId: 'released',
                    candidate: aggregateReference('candidate', 'clinical.encoder', 'candidate-7'),
                    policy: aggregateReference('metric_policy', 'research-policy', 'r01'),
                    riskTier: 'research',
                    technicalAuthorityDecision: aggregateReference(
                      'evidence',
                      'technical-decision',
                      'r01',
                    ),
                    qualityAuthorityDecision: aggregateReference(
                      'evidence',
                      'quality-decision',
                      'r01',
                    ),
                    promotedAt: '2026-08-14T12:03:00.000Z',
                    signingKeyId: 'fixture-promotion-key',
                    receiptDigest: '4'.repeat(64),
                    signature: Buffer.alloc(64, 5).toString('base64'),
                    status: 'revoked',
                    revocation: {
                      reasonCode: 'operator_withdrawal',
                      revokedAt: '2026-08-14T13:04:00.000Z',
                    },
                  },
                ],
                page: {
                  limit: Number(url.searchParams.get('promotionLimit') ?? '100'),
                  afterReceiptDigest: url.searchParams.get('afterReceiptDigest'),
                  nextAfterReceiptDigest: null,
                },
              },
            });
          }
          return json(response, 404, { error: 'not_found' });
        }

        return json(response, 404, { error: 'fixture_not_found', path: url.pathname });
      } catch (error) {
        return json(response, 500, {
          error: 'fixture_error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const fixtureAddress = fixture.address();
    assert(fixtureAddress !== null && typeof fixtureAddress === 'object');
    fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
    issuer = `${fixtureOrigin}/realms/kf`;
    const webPort = await reservePort();
    // Chromium's Secure-cookie loopback exception is defined for localhost. Keep the fixture
    // plaintext only on that exact host; production configuration still requires HTTPS.
    webOrigin = `http://localhost:${webPort}`;

    const runtimeDirectory = mkdtempSync(join(tmpdir(), 'kf-web-e2e-'));
    const nextEnvironmentDeclaration = join(WEB_ROOT, 'next-env.d.ts');
    const originalNextEnvironmentDeclaration = readFileSync(nextEnvironmentDeclaration);
    const secretPath = join(runtimeDirectory, 'session-secret');
    writeFileSync(secretPath, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
    const distDir = `.next-e2e-${process.pid}`;
    const nextEnvironment = {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      KF_NEXT_DIST_DIR: distDir,
      KF_DEPLOYMENT_PROFILE: 'dogfood',
      KF_WEB_OIDC_ISSUER: issuer,
      KF_WEB_OIDC_CLIENT_ID: CLIENT_ID,
      KF_WEB_OIDC_REDIRECT_URI: `${webOrigin}/auth/callback`,
      KF_WEB_SESSION_SECRET_FILE: secretPath,
      KF_API_URL: `${fixtureOrigin}/api`,
    };
    delete nextEnvironment.KF_WEB_SESSION_SECRET;
    let nextLogs = '';
    const collect = (chunk) => {
      nextLogs = `${nextLogs}${chunk}`.slice(-64 * 1024);
    };

    let browser;
    let next;
    try {
      const build = spawn(
        process.execPath,
        [`${WEB_ROOT}/node_modules/next/dist/bin/next`, 'build', '--webpack'],
        {
          cwd: WEB_ROOT,
          env: nextEnvironment,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      build.stdout.on('data', collect);
      build.stderr.on('data', collect);
      const [buildExitCode] = await once(build, 'exit');
      if (buildExitCode !== 0) throw new Error(`Next build failed with ${buildExitCode}`);

      next = spawn(
        process.execPath,
        [
          `${WEB_ROOT}/node_modules/next/dist/bin/next`,
          'start',
          '--hostname',
          'localhost',
          '--port',
          String(webPort),
        ],
        {
          cwd: WEB_ROOT,
          env: nextEnvironment,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      next.stdout.on('data', collect);
      next.stderr.on('data', collect);
      await waitForWeb(webOrigin, next, () => nextLogs);
      const playwrightModule = await import(
        process.env.KF_PLAYWRIGHT_CORE_PATH ?? 'playwright-core'
      );
      const launchOptions = { headless: true };
      if (process.env.KF_BROWSER_EXECUTABLE) {
        launchOptions.executablePath = process.env.KF_BROWSER_EXECUTABLE;
      }
      if (process.env.KF_BROWSER_CHANNEL) {
        launchOptions.channel = process.env.KF_BROWSER_CHANNEL;
      }
      browser = await playwrightModule.chromium.launch(launchOptions);
      const context = await browser.newContext();
      const page = await context.newPage();

      await page.goto(`${webOrigin}/documents`);
      await page.waitForURL(`${webOrigin}/session/select**`);
      await assert.doesNotReject(() =>
        page.getByRole('heading', { name: 'Choose authority context' }).waitFor(),
      );
      const signedInCookies = await context.cookies(webOrigin);
      const sessionCookie = signedInCookies.find((cookie) => cookie.name === '__Host-kf_session');
      assert.ok(sessionCookie, 'encrypted host-only session cookie must be present');
      assert.equal(sessionCookie.httpOnly, true);
      assert.equal(sessionCookie.secure, true);
      assert.equal(sessionCookie.sameSite, 'Lax');

      await page.getByLabel('Acting role assignment UUIDv7').fill(BAD_ROLE_ID);
      await page.getByLabel('Organization UUIDv7').fill(ORGANIZATION_ID);
      await page.getByLabel('Maximum classification').selectOption('internal');
      await page.getByRole('button', { name: 'Validate with KF API' }).click();
      await page.waitForURL(/error=denied/);
      await assert.doesNotReject(() => page.getByText('API refused this role').waitFor());

      await page.getByLabel('Acting role assignment UUIDv7').fill(ROLE_ID);
      await page.getByLabel('Organization UUIDv7').fill(ORGANIZATION_ID);
      await page.getByRole('button', { name: 'Validate with KF API' }).click();
      await page.waitForURL(`${webOrigin}/documents`);
      await assert.doesNotReject(() => page.getByText('OpenHuman Document Constitution').waitFor());
      const authorityContext = page.getByLabel('Current authority context');
      await assert.doesNotReject(() =>
        authorityContext.getByText(SUBJECT, { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() =>
        authorityContext.getByText(ORGANIZATION_ID, { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() =>
        authorityContext.getByText(ROLE_ID, { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() =>
        authorityContext.getByText('internal', { exact: true }).waitFor(),
      );
      await page.getByLabel('Title').fill('Oversized draft');
      await page.getByLabel('Document number').fill('OH-DOC-UPLOAD-OVER');
      await page.getByLabel('Revision').fill('R01');
      await page.getByLabel('Source file').setInputFiles({
        name: 'oversized.txt',
        mimeType: 'text/plain',
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 0x6f),
      });
      await page.getByRole('button', { name: 'Add draft' }).click();
      await page.waitForURL(
        /\/documents\?refused=Document(?:\+|%20)exceeds(?:\+|%20)10(?:\+|%20)MiB/,
      );
      await assert.doesNotReject(() => page.getByText(/Document exceeds 10 MiB limit/).waitFor());
      assert.deepEqual(apiMutations, []);

      await page.getByLabel('Title').fill('Boundary draft');
      await page.getByLabel('Document number').fill('OH-DOC-UPLOAD-MAX');
      await page.getByLabel('Revision').fill('R01');
      await page.getByLabel('Source file').setInputFiles({
        name: 'boundary.txt',
        mimeType: 'text/plain',
        buffer: Buffer.alloc(10 * 1024 * 1024, 0x62),
      });
      await page.getByRole('button', { name: 'Add draft' }).click();
      await page.waitForURL(`${webOrigin}/documents/${DOCUMENT_ID}`);
      assert.equal(importedDocumentBytes, 10 * 1024 * 1024);
      const expectedDocumentTitle = `Document ${DOCUMENT_ID} | OpenHuman Knowledge Fabric`;
      await page.waitForFunction(
        (title) => globalThis.document.title === title,
        expectedDocumentTitle,
        { timeout: 5_000 },
      );
      assert.equal(await page.title(), expectedDocumentTitle);

      const previewTab = page.getByRole('tab', { name: 'Preview' });
      const sourceTab = page.getByRole('tab', { name: 'Source' });
      const metricsTab = page.getByRole('tab', { name: 'Metrics' });
      assert.equal(await previewTab.getAttribute('aria-selected'), 'true');
      await assert.doesNotReject(() =>
        page.getByText('The constitution governs controlled documentation.').waitFor(),
      );
      const projectionLink = page.getByRole('link', { name: 'Download html' });
      const projectionDownload = await projectionLink.evaluate(async (element) => {
        const response = await globalThis.fetch(element.href);
        return {
          status: response.status,
          mediaType: response.headers.get('content-type'),
          body: await response.text(),
        };
      });
      assert.deepEqual(projectionDownload, {
        status: 200,
        mediaType: 'text/html',
        body: PROJECTION_BYTES.toString(),
      });
      const parsedList = page.locator('article').getByRole('list');
      assert.equal(await parsedList.getByRole('listitem').count(), 2);
      await assert.doesNotReject(() =>
        parsedList.getByText('Auditable', { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByRole('heading', { name: 'Source H4', level: 5 }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByRole('heading', { name: 'Source H5', level: 6 }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByRole('heading', { name: 'Source H6', level: 7 }).waitFor(),
      );

      await previewTab.focus();
      await previewTab.press('ArrowRight');
      assert.equal(await sourceTab.getAttribute('aria-selected'), 'true');
      assert.equal(
        await sourceTab.evaluate((element) => element === element.ownerDocument.activeElement),
        true,
      );
      await assert.doesNotReject(() =>
        page.getByRole('tabpanel').getByText(DIGEST, { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByText('fixture-artifact-version', { exact: true }).waitFor(),
      );
      const sourceLink = page.getByRole('link', { name: 'Download verified source' });
      const sourceDownload = await sourceLink.evaluate(async (element) => {
        const response = await globalThis.fetch(element.href);
        return {
          status: response.status,
          mediaType: response.headers.get('content-type'),
          body: await response.text(),
        };
      });
      assert.deepEqual(sourceDownload, {
        status: 200,
        mediaType: 'text/markdown',
        body: SOURCE_BYTES.toString(),
      });

      await sourceTab.press('End');
      assert.equal(await metricsTab.getAttribute('aria-selected'), 'true');
      assert.equal(
        await metricsTab.evaluate((element) => element === element.ownerDocument.activeElement),
        true,
      );
      await metricsTab.press('Home');
      assert.equal(await previewTab.getAttribute('aria-selected'), 'true');
      assert.equal(
        await previewTab.evaluate((element) => element === element.ownerDocument.activeElement),
        true,
      );

      await page.getByRole('tab', { name: 'Outline' }).click();
      await assert.doesNotReject(() => page.getByText(/Purpose.*Parsed Block 1/).waitFor());
      await page.getByRole('button', { name: 'Source H6 Parsed Block 8' }).click();
      assert.equal(await previewTab.getAttribute('aria-selected'), 'true');
      await page.waitForFunction(() => globalThis.document.activeElement?.id === 'parsed-block-8');
      assert.equal(
        await page.locator('#parsed-block-8').evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.bottom > 0 && bounds.top < globalThis.innerHeight;
        }),
        true,
        'outline selection must reveal and scroll the corresponding Preview heading into view',
      );
      await page.getByRole('tab', { name: 'Composition' }).click();
      await assert.doesNotReject(() => page.getByText('Constitution composition').waitFor());
      await assert.doesNotReject(() => page.getByText(/Constitution source fragment/).waitFor());
      await page.getByRole('tab', { name: 'Navigation' }).click();
      await assert.doesNotReject(() =>
        page.getByText('Policy register', { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByText('ADR-0002 Liminal-backed compiler', { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByText('document-compiler', { exact: true }).last().waitFor(),
      );
      await page.getByRole('tab', { name: 'Provenance' }).click();
      await assert.doesNotReject(() => page.getByText('kf-markdown 1.0.0').waitFor());
      await assert.doesNotReject(() => page.getByText('fixture-holder', { exact: true }).waitFor());
      await assert.doesNotReject(() =>
        page.getByText('fixture-fragment-revision', { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByText('fixture-holder-action', { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByText('2026-08-14 12:00:00.123Z', { exact: true }).waitFor(),
      );
      const parsedBlockDigestDisclosure = page
        .locator('summary')
        .filter({ hasText: 'Show exact Parsed Block 1 digest' });
      await parsedBlockDigestDisclosure.focus();
      await parsedBlockDigestDisclosure.press('Enter');
      assert.equal(
        await parsedBlockDigestDisclosure.evaluate((summary) =>
          summary.parentElement?.hasAttribute('open'),
        ),
        true,
      );
      await assert.doesNotReject(() => page.getByText('c'.repeat(64), { exact: true }).waitFor());
      await page.getByRole('tab', { name: 'Diagnostics' }).click();
      await assert.doesNotReject(() =>
        page.getByText(/draft_only.*Draft projection only/i).waitFor(),
      );
      await page.getByRole('tab', { name: 'Semantics & proposal' }).click();
      await assert.doesNotReject(() => page.getByText(/\/purpose.*changed/i).waitFor());
      const reasonInput = page.getByLabel('Proposal reason (audit context)');
      const proposalInput = page.getByLabel('Exact replace_fragment_source operation (JSON)');
      assert.equal(await reasonInput.isDisabled(), false);
      assert.equal(await proposalInput.isDisabled(), false);
      await reasonInput.fill('Review exact replacement Holder');
      await proposalInput.fill(
        JSON.stringify({
          operation: 'replace_fragment_source',
          media_type: 'text/markdown',
          classification: 'internal',
          holder_id: '77777777-7777-7777-8777-777777777777',
          previous_holder_id: HOLDER_ID,
          holder: {
            kind: 'fabric_native',
            artifact_version_id: '88888888-8888-7888-8888-888888888888',
            content_digest: 'f'.repeat(64),
          },
        }),
      );
      await page.getByRole('button', { name: 'Record proposal' }).click();
      await assert.doesNotReject(() =>
        page.getByText(/was recorded for separate review/).waitFor(),
      );
      await page.getByRole('tab', { name: 'Publication' }).click();
      assert.equal(await page.getByRole('button', { name: /Publish/ }).isDisabled(), true);
      await page.getByRole('tab', { name: 'Metrics' }).click();
      await assert.doesNotReject(() =>
        page.getByText(/No typed document-to-training-run binding exists/).waitFor(),
      );
      assert.equal(
        await page.getByRole('button', { name: 'Human authority required' }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByLabel('Reason for approve controlled document').isDisabled(),
        true,
      );
      await assert.doesNotReject(() =>
        page.getByText(/requires a human authority workflow/i).waitFor(),
      );

      await page.goto(`${webOrigin}/search?q=constitution`);
      await assert.doesNotReject(() =>
        page.getByRole('heading', { name: 'Search knowledge fabric' }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByRole('link', { name: 'OpenHuman Document Constitution' }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByText('Showing 1 visible match (request limit 50).').waitFor(),
      );

      await page.getByRole('link', { name: 'ML runs' }).click();
      await page.getByLabel('Run authority').fill(RUN_AUTHORITY_ID);
      await page.getByLabel('Run revision').fill(RUN_REVISION_ID);
      await page.getByRole('button', { name: 'Open run' }).click();
      await page.waitForURL(
        `${webOrigin}/ml/runs/${RUN_AUTHORITY_ID}/revisions/${RUN_REVISION_ID}`,
      );
      const expectedTitle = `ML run ${RUN_AUTHORITY_ID} ${RUN_REVISION_ID} | OpenHuman Knowledge Fabric`;
      await page.waitForFunction((title) => globalThis.document.title === title, expectedTitle, {
        timeout: 5_000,
      });
      assert.equal(await page.title(), expectedTitle);
      try {
        await page.getByText('validation.loss').waitFor({ timeout: 5_000 });
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nRendered body:\n${await page.locator('body').innerText()}\nML query: ${lastMlQuery?.toString() ?? 'none'}\nAPI paths: ${apiRequests.map((entry) => entry.path).join(', ')}`,
          { cause: error },
        );
      }
      await assert.doesNotReject(() => page.getByText('0.125 ratio').waitFor());
      await assert.doesNotReject(() =>
        page.getByText('clinical.encoder', { exact: true }).last().waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByText('fixture-run-seal-key', { exact: true }).waitFor(),
      );
      await page.getByText('Receipt evidence', { exact: true }).click();
      await assert.doesNotReject(() =>
        page.getByText('fixture-promotion-key', { exact: true }).waitFor(),
      );
      await assert.doesNotReject(() => page.getByText(/quality-decision@r01/).waitFor());
      await assert.doesNotReject(() => page.getByText(/operator_withdrawal/).waitFor());
      await assert.doesNotReject(() => page.getByText('4'.repeat(64), { exact: true }).waitFor());
      await assert.doesNotReject(() =>
        page.getByText(Buffer.alloc(64, 5).toString('base64'), { exact: true }).waitFor(),
      );
      assert.equal(lastMlQuery?.get('limit'), '100');
      assert.equal(lastMlQuery?.get('memberLimit'), '100');
      assert.equal(lastMlQuery?.get('segmentLimit'), '100');
      assert.equal(lastMlQuery?.get('promotionLimit'), '100');
      assert.equal(lastMlQuery?.has('eventLimit'), false);

      await page.setViewportSize({ width: 375, height: 800 });
      assert.equal(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth,
        ),
        true,
        'ML detail must not create page-level horizontal overflow at a narrow viewport',
      );

      await page.getByRole('link', { name: 'Change context' }).click();
      await page.waitForURL(`${webOrigin}/session/select**`);
      assert.equal(
        new URL(page.url()).searchParams.get('next'),
        `/ml/runs/${RUN_AUTHORITY_ID}/revisions/${RUN_REVISION_ID}`,
      );
      await page.getByLabel('Maximum classification').selectOption('public');
      await page.getByRole('button', { name: 'Validate with KF API' }).click();
      await page.waitForURL(
        `${webOrigin}/ml/runs/${RUN_AUTHORITY_ID}/revisions/${RUN_REVISION_ID}`,
      );
      await assert.doesNotReject(() =>
        page
          .getByRole('heading', { name: 'Run unavailable under selected authority context' })
          .waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByText(/cannot read this run, or the run does not exist/).waitFor(),
      );

      await page.goto(`${webOrigin}/search?q=constitution`);
      await assert.doesNotReject(() =>
        page.getByText('No visible matches in current access context.').waitFor(),
      );

      await page.goto(`${webOrigin}/documents`);
      await assert.doesNotReject(() => page.getByText('No documents loaded yet.').waitFor());
      forceDocumentListError = true;
      await page.reload();
      await assert.doesNotReject(() =>
        page.getByText('Document projection is unavailable in the fixture.').waitFor(),
      );
      assert.equal(await page.getByText('No documents loaded yet.').count(), 0);

      await page.getByRole('button', { name: 'Sign out' }).click();
      await page.waitForURL(`${webOrigin}/`);
      await assert.doesNotReject(() =>
        page.getByRole('heading', { name: 'Implemented capability gates' }).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByText(/Controlled-document proposal mapping.*implemented/i).waitFor(),
      );
      await assert.doesNotReject(() =>
        page.getByRole('heading', { name: 'Measured service readiness' }).waitFor(),
      );
      await assert.doesNotReject(() => page.getByText(/fixture_runtime.*ok/i).waitFor());
      await assert.doesNotReject(() =>
        page.getByRole('heading', { name: 'Measured institutional readiness' }).waitFor(),
      );
      await assert.doesNotReject(() => page.getByText(/fixture_checkpoint.*failed/i).waitFor());
      await assert.doesNotReject(() =>
        page.getByText(/Governed operations remain blocked\./i).waitFor(),
      );
      readinessMode = 'failed';
      await page.reload();
      await assert.doesNotReject(() => page.getByText(/fixture_runtime.*failed/i).waitFor());
      await assert.doesNotReject(() => page.getByText(/Not ready to serve\./).waitFor());
      readinessMode = 'malformed';
      await page.reload();
      await assert.doesNotReject(() =>
        page
          .getByText(/API readiness evidence is unavailable\. Runtime state is unknown\./i)
          .waitFor(),
      );
      await assert.doesNotReject(() =>
        page
          .getByRole('heading', { name: 'Known institutional gates outside runtime measurement' })
          .waitFor(),
      );
      const signedOutCookies = await context.cookies(webOrigin);
      assert.equal(
        signedOutCookies.some((cookie) => cookie.name === '__Host-kf_session'),
        false,
      );
      assert.deepEqual(apiMutations, [
        'POST /api/documents',
        `POST /api/documents/${DOCUMENT_ID}/proposals`,
      ]);
      assert.ok(apiRequests.length >= 7);
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      throw new Error(`${detail}\n\nNext output:\n${nextLogs}`, { cause: error });
    } finally {
      if (browser !== undefined) await browser.close();
      if (next !== undefined) await stopChild(next);
      await new Promise((resolve, reject) => {
        fixture.close((error) => (error === undefined ? resolve() : reject(error)));
      });
      rmSync(join(WEB_ROOT, distDir), { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
      writeFileSync(nextEnvironmentDeclaration, originalNextEnvironmentDeclaration);
    }
  },
);
