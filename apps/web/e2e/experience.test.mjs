// The experience in a real browser (ADR 0040; KF-SAS-RQ-262, RQ-267, RQ-273, RQ-276).
//
// A production build of the web application against a fixture OIDC provider and a fixture API
// whose /dashboard and /master-document answer as three different readers would be answered:
//
//   (a) the dashboard renders panels in the API's layout order and omits every empty one;
//   (b) a CEO's and an engineer's dashboards are the same panel sequence with different contents;
//   (c) the density switch changes presentation and nothing a reader reads: the text of every
//       record and statement is identical at both densities;
//   (d) at phone width (390 × 844) the dashboard, the master document, an object page and the
//       capture form scroll vertically only;
//   (e) Needs you is a separated slot element in its place in the layout, holding M2's panel
//       filled from the reader's own Needs-you answer, and empty when nothing waits.
//
// Run with the other browser tests: `pnpm --filter @kf/web test:browser`.

/* global document, getComputedStyle -- evaluated in the browser page, not in Node */

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
const SUBJECT = 'experience-subject';
const ROLE_ID = '01900000-0000-7000-8000-0000000000e1';
const ORGANIZATION_ID = '01900000-0000-7000-8000-0000000000e2';
const OBJECT_ID = '01900000-0000-7000-8000-0000000000e3';
const LAYOUT = [
  'start_here',
  'overview',
  'master_document',
  'needs_you',
  'work_in_flight',
  'recent_record',
  'people',
];

const verified = {
  verified: true,
  basis: 'reviewed_individually',
  verifiedAt: '2026-10-01T09:00:00.000Z',
  verifiedBy: '01900000-0000-7000-8000-0000000000aa',
  label:
    'verified reviewed individually by 01900000-0000-7000-8000-0000000000aa at 2026-10-01T09:00:00.000Z',
};
const unverified = { verified: false, label: 'UNVERIFIED — nobody has checked this record' };

let next = 0;
const id = () => `01900000-0000-7000-8000-${String(0x100 + (next += 1)).padStart(12, '0')}`;

function line(title, objectType, state, verification = unverified) {
  return {
    id: id(),
    objectType,
    title,
    lifecycleState: state,
    classification: 'internal',
    updatedAt: '2026-10-06T12:00:00.000Z',
    verification,
  };
}

function statement(title, objectType, state, text, verification = unverified) {
  return {
    objectId: id(),
    objectType,
    title,
    lifecycleState: state,
    classification: 'internal',
    verification,
    text,
  };
}

function overview(sections, withheld) {
  return {
    status: 'ready',
    format: 'kf-organization-overview-v1',
    overview: {
      id: id(),
      title: 'Véracier at a glance',
      classification: 'internal',
      verification: unverified,
    },
    sections,
    withheld,
    corpusMemberCount: 4000,
    statementCount: sections.reduce((n, s) => n + s.statements.length, 0),
    projection: {
      definition: { id: 'organization_overview', version: 1 },
      projectionDigest: 'a'.repeat(64),
      scopeDigest: 'b'.repeat(64),
    },
  };
}

// Three readers, three answers. Nothing here varies the LAYOUT: only what is inside it.
const READERS = {
  ceo: {
    panels: [
      { id: 'start_here', empty: true, pages: [] },
      {
        id: 'overview',
        empty: false,
        overview: overview(
          [
            {
              id: 'projects',
              title: 'Projects and engagements',
              total: 7,
              statements: [
                statement(
                  'AV-3000 servo valve programme',
                  'initiative_project',
                  'active',
                  'Project “AV-3000 servo valve programme” is active.',
                  verified,
                ),
                statement(
                  'Acquisition of Précis-Tec',
                  'initiative_project',
                  'evaluating',
                  'Project “Acquisition of Précis-Tec” is evaluating.',
                ),
              ],
            },
            {
              id: 'risks',
              title: 'Risks and quality',
              total: 1,
              statements: [
                statement(
                  'Export control breach, Véracier Défense',
                  'nonconformity',
                  'open',
                  'Nonconformity “Export control breach, Véracier Défense” is open.',
                ),
              ],
            },
          ],
          0,
        ),
      },
      {
        id: 'master_document',
        empty: false,
        claim: {
          status: 'compiled',
          id: id(),
          compiledAt: '2026-10-07T08:00:00.000Z',
          corpusDigest: 'c'.repeat(64),
          memberCount: 2142,
          currency: 'current',
        },
      },
      { id: 'needs_you', slot: 'needs-you' },
      {
        id: 'work_in_flight',
        empty: false,
        total: 31,
        records: [
          line('Board decision: second source for TA6V forgings', 'decision_record', 'proposed'),
          line('Acquisition of Précis-Tec', 'initiative_project', 'evaluating'),
        ],
      },
      {
        id: 'recent_record',
        empty: false,
        total: 2142,
        records: [line('Rapport de conformité 2026', 'artifact', 'draft', verified)],
      },
      {
        id: 'people',
        empty: false,
        assignments: [
          {
            assignmentId: ROLE_ID,
            roleId: 'chief_executive',
            organizationWide: true,
            validTo: '2027-09-30T00:00:00.000Z',
            reaches: [['chief_executive'], ['chief_executive', 'executive', 'staff']],
          },
        ],
        presetGrants: 2,
        qualification: null,
      },
    ],
  },
  engineer: {
    panels: [
      { id: 'start_here', empty: true, pages: [] },
      {
        id: 'overview',
        empty: false,
        overview: overview(
          [
            {
              id: 'projects',
              title: 'Projects and engagements',
              total: 1,
              statements: [
                statement(
                  'AV-3000 servo valve programme',
                  'initiative_project',
                  'active',
                  'Project “AV-3000 servo valve programme” is active.',
                ),
              ],
            },
          ],
          12,
        ),
      },
      {
        id: 'master_document',
        empty: false,
        claim: { status: 'missing' },
      },
      { id: 'needs_you', slot: 'needs-you' },
      {
        id: 'work_in_flight',
        empty: false,
        total: 3,
        records: [
          line('FAI AeroHarness AH-100-G2 selon EN 9102', 'initiative_project', 'captured'),
        ],
      },
      {
        id: 'recent_record',
        empty: false,
        total: 170,
        records: [line('Plan de contrôle CP-AV3000 Rev F', 'artifact', 'draft')],
      },
      {
        id: 'people',
        empty: false,
        assignments: [
          {
            assignmentId: ROLE_ID,
            roleId: 'engineer',
            organizationWide: true,
            validTo: '2027-09-30T00:00:00.000Z',
            reaches: [['engineer', 'staff']],
          },
        ],
        presetGrants: 1,
        qualification: null,
      },
    ],
  },
  // A person granted almost nothing: their overview, work and recent panels are empty.
  narrow: {
    panels: [
      { id: 'start_here', empty: true, pages: [] },
      { id: 'overview', empty: true },
      { id: 'master_document', empty: false, claim: { status: 'missing' } },
      { id: 'needs_you', slot: 'needs-you' },
      { id: 'work_in_flight', empty: true, total: 0, records: [] },
      { id: 'recent_record', empty: true, total: 0, records: [] },
      {
        id: 'people',
        empty: false,
        assignments: [
          {
            assignmentId: ROLE_ID,
            roleId: 'performer',
            organizationWide: false,
            validTo: null,
            reaches: [],
          },
        ],
        presetGrants: 0,
        qualification: null,
      },
    ],
  },
};

// What waits on each reader (`GET /needs-you`, M2). Only the CEO has something: an agent's
// submission to verify. The others' slots stay empty and collapse.
const NEEDS_YOU_RECORD = {
  id: '01900000-0000-7000-8000-0000000000e5',
  objectType: 'observation',
  title: 'Agent capture: torque spec drift on AV-3000 bench 2',
  classification: 'internal',
  lifecycleState: 'captured',
  rowVersion: 1,
  agentClientId: 'claude-code',
  writtenFor: '01900000-0000-7000-8000-0000000000e6',
  writtenAt: '2026-10-07T07:30:00.000Z',
  verification: unverified,
};
const nothing = { items: [], total: 0 };
const NEEDS_YOU = {
  ceo: {
    toVerify: { items: [NEEDS_YOU_RECORD], total: 1 },
    awaitingOthers: nothing,
    proposals: nothing,
  },
  engineer: { toVerify: nothing, awaitingOthers: nothing, proposals: nothing },
  narrow: { toVerify: nothing, awaitingOthers: nothing, proposals: nothing },
};

function masterDocument(reader) {
  const panels = READERS[reader].panels;
  const overviewPanel = panels.find((panel) => panel.id === 'overview');
  const ov = overviewPanel.empty ? null : overviewPanel.overview;
  return {
    format: 'kf-master-document-v1',
    claim: panels.find((panel) => panel.id === 'master_document').claim,
    overview: ov,
    sections: [
      {
        objectType: 'artifact',
        title: 'Artifact',
        count: 2100,
        items: [
          line(
            'Rapport de conformité 2026 — une ligne de titre assez longue pour plier',
            'artifact',
            'draft',
          ),
        ],
        noLongerInScope: 1,
        next: id(),
      },
    ],
  };
}

function objectView() {
  const subject = {
    objectId: OBJECT_ID,
    objectType: 'decision_record',
    organizationId: ORGANIZATION_ID,
    classification: 'internal',
    contentDigest: 'd'.repeat(64),
    itemState: 'included',
    lifecycleState: 'proposed',
    title: 'Qualifier Aciéries de Savoie en second source des forgés TA6V',
    verification: unverified,
  };
  return {
    result: {
      format: 'kf-projection-result-v2',
      projectionDigest: 'e'.repeat(64),
      source: { corpusDigest: 'f'.repeat(64) },
      sections: [
        { id: 'subject', title: 'This record', members: [subject] },
        { id: 'relationships', title: 'Relationships', members: [] },
      ],
      edges: [],
    },
    facets: { history: { events: [] }, availableActions: [] },
  };
}

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

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function reservePort() {
  const server = createServer();
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForWeb(origin, child, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next exited with ${child.exitCode}\n${logs()}`);
    try {
      const response = await globalThis.fetch(`${origin}/status`, {
        signal: globalThis.AbortSignal.timeout(1_000),
      });
      if (response.status < 500) return;
    } catch {
      // still starting
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

test(
  'one dashboard for everyone, presentation-only density, and phone width (ADR 0040)',
  { timeout: 300_000 },
  async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const codes = new Map();
    let reader = 'ceo';
    const compiles = [];
    const searches = [];
    const ingests = [];
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
          const code = randomBytes(24).toString('base64url');
          codes.set(code, {
            challenge: url.searchParams.get('code_challenge'),
            nonce: url.searchParams.get('nonce'),
          });
          const callback = new URL('/auth/callback', webOrigin);
          callback.searchParams.set('code', code);
          callback.searchParams.set('state', url.searchParams.get('state') ?? '');
          return redirect(response, callback.toString());
        }
        if (url.pathname === '/realms/kf/protocol/openid-connect/token') {
          const form = new globalThis.URLSearchParams(await requestBody(request));
          const transaction = codes.get(form.get('code') ?? '');
          assert.ok(transaction);
          assert.equal(
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest('base64url'),
            transaction.challenge,
          );
          const idToken = await new SignJWT({ nonce: transaction.nonce, name: 'Elena Marchetti' })
            .setProtectedHeader({ alg: 'RS256', kid: 'experience-key' })
            .setIssuer(issuer)
            .setAudience(CLIENT_ID)
            .setSubject(SUBJECT)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);
          return json(response, 200, {
            access_token: 'experience-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
          });
        }
        if (url.pathname === '/realms/kf/protocol/openid-connect/certs') {
          return json(response, 200, {
            keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid: 'experience-key' }],
          });
        }
        if (!url.pathname.startsWith('/api/')) return json(response, 404, { error: 'not_found' });
        if (url.pathname === '/api/readiness') {
          const checks = [
            { id: 'fixture_runtime', scope: 'service', status: 'ok', detail: 'Fixture ready.' },
          ];
          const institutional = [
            { id: 'fixture_checkpoint', scope: 'institutional', status: 'failed', detail: 'None.' },
          ];
          return json(response, 200, {
            ready: true,
            checks,
            service: { ready: true, checks },
            institutional: { ready: false, checks: institutional },
          });
        }
        if (url.pathname === '/api/session/contexts') {
          return json(response, 200, {
            personId: '01900000-0000-7000-8000-0000000000e4',
            organizations: [
              {
                organizationId: ORGANIZATION_ID,
                legalName: 'Véracier Industries S.A.',
                clearance: 'internal',
                assignments: [{ assignmentId: ROLE_ID, roleId: 'performer', validTo: null }],
                refused: null,
              },
            ],
          });
        }
        if (
          request.headers.authorization !== 'Bearer experience-access-token' ||
          request.headers['x-kf-organization'] !== ORGANIZATION_ID ||
          request.headers['x-kf-acting-role'] !== ROLE_ID
        ) {
          return json(response, 401, { error: 'unidentified', message: 'context refused' });
        }
        if (url.pathname === '/api/documents') return json(response, 200, { documents: [] });
        if (url.pathname === '/api/dashboard') {
          return json(response, 200, {
            format: 'kf-dashboard-v1',
            layout: LAYOUT,
            panels: READERS[reader].panels,
          });
        }
        if (url.pathname === '/api/needs-you') return json(response, 200, NEEDS_YOU[reader]);
        if (url.pathname === '/api/master-document') {
          const document = masterDocument(reader);
          if (reader === 'narrow' && compiles.length > 0) {
            document.claim = READERS.ceo.panels.find((p) => p.id === 'master_document').claim;
          }
          return json(response, 200, document);
        }
        if (url.pathname === '/api/master-record/compile' && request.method === 'POST') {
          compiles.push(JSON.parse(await requestBody(request)));
          return json(response, 201, { reused: false });
        }
        if (url.pathname === '/api/search') {
          searches.push(url.searchParams.get('q'));
          const LEXICAL = 'kf.lexical.idf_coverage(floor=0.5)+phrase+partial_identifier.v2';
          const hit = {
            objectId: OBJECT_ID,
            objectType: 'observation',
            title: 'Torque drift on bench 2',
            lifecycleState: 'captured',
            classification: 'internal',
            rank: 0.9,
            matchedBy: 'full_text',
            verification: unverified,
            updatedAt: '2026-10-03T09:15:00.000Z',
            excerpt: 'The torque on bench 2 drifted by four percent after the spindle swap.',
          };
          return json(response, 200, {
            ranked: {
              ranking: `kf.fused.rrf.v2(k=60; ${LEXICAL})`,
              hits: [
                { ...hit, rank: 1, score: 1 / 61, lexical: { rank: 1, matchedBy: 'full_text' } },
              ],
            },
            lexical: { ranking: LEXICAL, exhaustive: true, total: 1, complete: true, hits: [hit] },
            withheld: [
              {
                reasonClass: 'semantic_ranking_unavailable',
                reason: 'no retrieval engine is configured',
              },
            ],
            withheldCount: 3,
            hits: [hit],
          });
        }
        if (url.pathname === '/api/ingest' && request.method === 'POST') {
          const body = JSON.parse(await requestBody(request));
          ingests.push(body);
          const text = Buffer.from(body.contentBase64, 'base64').toString('utf8');
          if (text.includes('PRIVATE KEY')) {
            return json(response, 422, {
              error: 'content_refused',
              message: `${body.title}: a private key (line 1)`,
              detail: { rule: 'private_key', line: 1 },
            });
          }
          return json(response, 201, {
            artifactId: '01900000-0000-7000-8000-0000000000f1',
            actionId: 'action-1',
            replayed: false,
          });
        }
        if (url.pathname === `/api/objects/${OBJECT_ID}`) return json(response, 200, objectView());
        return json(response, 404, { error: 'not_found', message: url.pathname });
      } catch (error) {
        return json(response, 500, { error: 'fixture_error', message: String(error) });
      }
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
    issuer = `${fixtureOrigin}/realms/kf`;
    webOrigin = `http://localhost:${await reservePort()}`;

    const runtime = mkdtempSync(join(tmpdir(), 'kf-web-experience-'));
    const declaration = join(WEB_ROOT, 'next-env.d.ts');
    const originalDeclaration = readFileSync(declaration);
    const secretPath = join(runtime, 'session-secret');
    writeFileSync(secretPath, `${Buffer.alloc(32, 9).toString('base64')}\n`, { mode: 0o600 });
    const distDir = `.next-e2e-${process.pid}`;
    const env = {
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
      KF_WEB_ORGANIZATION: ORGANIZATION_ID,
    };
    delete env.KF_WEB_SESSION_SECRET;
    let logs = '';
    const collect = (chunk) => {
      logs = `${logs}${chunk}`.slice(-64 * 1024);
    };
    let browser;
    let web;
    try {
      if (process.env.KF_E2E_REUSE_BUILD !== distDir) {
        const build = spawn(
          process.execPath,
          [`${WEB_ROOT}/node_modules/next/dist/bin/next`, 'build', '--webpack'],
          { cwd: WEB_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        build.stdout.on('data', collect);
        build.stderr.on('data', collect);
        const [code] = await once(build, 'exit');
        if (code !== 0) throw new Error(`Next build failed with ${code}\n${logs}`);
      }
      const port = new URL(webOrigin).port;
      web = spawn(
        process.execPath,
        [
          `${WEB_ROOT}/node_modules/next/dist/bin/next`,
          'start',
          '--hostname',
          'localhost',
          '--port',
          port,
        ],
        { cwd: WEB_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      web.stdout.on('data', collect);
      web.stderr.on('data', collect);
      await waitForWeb(webOrigin, web, () => logs);
      const playwright = await import(process.env.KF_PLAYWRIGHT_CORE_PATH ?? 'playwright-core');
      const launch = { headless: true };
      if (process.env.KF_BROWSER_EXECUTABLE)
        launch.executablePath = process.env.KF_BROWSER_EXECUTABLE;
      if (process.env.KF_BROWSER_CHANNEL) launch.channel = process.env.KF_BROWSER_CHANNEL;
      browser = await playwright.chromium.launch(launch);
      const context = await browser.newContext();
      const page = await context.newPage();

      // Signed out, Home says what this is and how to get in; the status report is at /status.
      await page.goto(`${webOrigin}/`);
      await page.getByRole('heading', { name: 'Knowledge Fabric', level: 1 }).waitFor();
      assert.equal(await page.getByText('Implemented capability gates').count(), 0);
      await page.goto(`${webOrigin}/status`);
      await page.getByRole('heading', { name: 'Implemented capability gates' }).waitFor();
      // The installable app: its manifest and icons reach a signed-out browser, with no
      // redirect to sign in (docs/workspace.md, "Use it on Windows").
      const manifestLink = await page.locator('link[rel="manifest"]').getAttribute('href');
      assert.match(manifestLink ?? '', /^\/manifest\.webmanifest/);
      const installable = await page.request.get(`${webOrigin}/manifest.webmanifest`, {
        maxRedirects: 0,
      });
      assert.equal(installable.status(), 200);
      const served = await installable.json();
      assert.equal(served.name, 'Knowledge Fabric');
      assert.equal(served.display, 'standalone');
      for (const icon of served.icons) {
        const fetched = await page.request.get(`${webOrigin}${icon.src}`, { maxRedirects: 0 });
        assert.equal(fetched.status(), 200, icon.src);
      }
      await page.goto(`${webOrigin}/`);
      // One live assignment: signing in lands on Home, with no picker in between.
      const visited = [];
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
      });
      await page.locator('.kf-landing').getByRole('link', { name: 'Sign in' }).click();
      await page.waitForURL(`${webOrigin}/`);
      await page.getByRole('heading', { name: 'Ask or search your records' }).waitFor();
      assert.equal(visited.includes('/session/select'), false, visited.join(' → '));
      // The header is words: name, role, organization, what they can see; no id in view.
      const identity = page.locator('[data-identity-line]');
      assert.match(
        await identity.innerText(),
        /Elena Marchetti · Performer · Véracier Industries S\.A\. · Sees up to Company/,
      );
      assert.doesNotMatch(
        await page.locator('header.kf-masthead').innerText(),
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|experience-subject/i,
      );

      // The ask-or-search box is the first thing in the page. With no model configured here it
      // offers Search alone and says so; the results keep every disclosure the API made.
      const first = page.locator('main > *:not(h1)').first();
      assert.equal(await first.getAttribute('class'), 'kf-askbox');
      assert.equal(await first.getByRole('button', { name: 'Ask', exact: true }).count(), 0);
      await first.getByText(/Written answers aren’t set up here yet/).waitFor();
      // The "Search by meaning" switch sits in the box, on by default.
      assert.equal(
        await first.getByRole('switch', { name: 'Search by meaning' }).isChecked(),
        true,
      );
      await first.getByLabel('Your question or search words').fill('torque drift');
      await first.getByRole('button', { name: 'Search', exact: true }).click();
      await page.waitForURL(/\/\?q=torque\+drift&mode=search/);
      assert.deepEqual(searches, ['torque drift']);
      const preview = page.locator('[data-list="preview"]');
      await preview.getByRole('link', { name: 'Torque drift on bench 2' }).waitFor();
      await preview.getByText('Updated 3 Oct 2026').waitFor();
      await preview.getByText(/drifted by four percent after the spindle swap/).waitFor();
      await preview.locator('[data-state="unverified"]').waitFor();
      await preview
        .getByText(/^3 more matching records exist that you don’t have access to/)
        .waitFor();
      await preview.locator('[data-withholding="semantic_ranking_unavailable"]').waitFor();
      await preview
        .getByText('Search by meaning isn’t available right now — showing exact-word matches.')
        .waitFor();
      // Asking where no model is configured says so plainly, and still shows the search.
      await page.goto(`${webOrigin}/?q=torque+drift&mode=ask`);
      await page.locator('[data-ask="no-model"]').waitFor();
      await preview.getByRole('link', { name: 'Torque drift on bench 2' }).waitFor();

      // Search: one box, filters folded, the ranking formula folded, the counts in view.
      await page.goto(`${webOrigin}/search?q=torque+drift`);
      assert.equal(await page.locator('details.kf-filters').getAttribute('open'), null);
      assert.equal(await page.getByLabel('Kind of record').isVisible(), false);
      assert.equal(await page.getByText(/kf\.fused\.rrf/).isVisible(), false);
      await page.locator('[data-withheld-count="3"]').waitFor();
      await page.getByText('How this was ranked').click();
      await page
        .getByText(/kf\.fused\.rrf/)
        .first()
        .waitFor();

      // The "Search by meaning" switch: on by default; flipped, it re-runs the search at once and
      // shows the word matches alone, with the same withheld count; flipped back, the fused list.
      // What the address says about the switch, on the search page: '' when it says nothing.
      const meaningIn = (url) =>
        url.pathname === '/search' && url.searchParams.get('q') === 'torque drift'
          ? url.searchParams.getAll('meaning').join(',')
          : undefined;
      const meaningSwitch = page.getByRole('switch', { name: 'Search by meaning' });
      assert.equal(await meaningSwitch.isChecked(), true);
      await page.getByText('Off: only exact words', { exact: false }).waitFor();
      await page
        .getByText('Search by meaning isn’t available right now — showing exact-word matches.')
        .waitFor();
      if (process.env.KF_E2E_SCREENSHOTS) {
        await page.screenshot({
          path: join(process.env.KF_E2E_SCREENSHOTS, 'search-meaning-on.png'),
          fullPage: true,
        });
      }
      // Once script has run the checkbox stops sending its own value (meaning-switch.tsx).
      await page.locator('input[role="switch"]:not([name])').waitFor({ state: 'attached' });
      const searchesBefore = searches.length;
      await meaningSwitch.click();
      await page.waitForURL((url) => meaningIn(url) === 'off');
      await page.locator('.kf-results[data-meaning="off"]').waitFor();
      assert.equal(await meaningSwitch.isChecked(), false);
      await page.getByRole('heading', { name: '1 result with your exact words' }).waitFor();
      await page.locator('[data-withheld-count="3"]').waitFor();
      assert.equal(
        await page.locator('[data-withholding]').count(),
        0,
        'exact words were asked for',
      );
      assert.equal(await page.locator('[data-list="ranked"]').count(), 0);
      assert.equal(searches.length, searchesBefore + 1, 'one flip, one search');
      if (process.env.KF_E2E_SCREENSHOTS) {
        await page.screenshot({
          path: join(process.env.KF_E2E_SCREENSHOTS, 'search-meaning-off.png'),
          fullPage: true,
        });
      }
      // Keyboard: the switch takes focus and Space flips it.
      await page.locator('input[role="switch"]:not([name])').waitFor({ state: 'attached' });
      await meaningSwitch.focus();
      await page.keyboard.press('Space');
      await page.waitForURL((url) => meaningIn(url) === '');
      await page.locator('.kf-results[data-meaning="on"]').waitFor();
      // From Home, with the switch off, the link to all results keeps it off.
      await page.goto(`${webOrigin}/?q=torque+drift&mode=search&meaning=off`);
      assert.equal(
        await page
          .locator('.kf-askbox')
          .getByRole('switch', { name: 'Search by meaning' })
          .isChecked(),
        false,
      );
      await page.locator('[data-list="preview"][data-meaning="off"]').waitFor();
      assert.equal(
        await page
          .locator('[data-list="preview"]')
          .getByRole('link', { name: 'Open in Search' })
          .getAttribute('href'),
        '/search?q=torque+drift&meaning=off',
      );
      // Without script the switch is a plain checkbox in the form, and still works.
      const noScript = await browser.newContext({ javaScriptEnabled: false });
      await noScript.addCookies(await context.cookies());
      const plain = await noScript.newPage();
      await plain.goto(`${webOrigin}/search?q=torque+drift`);
      await plain.getByRole('switch', { name: 'Search by meaning' }).uncheck();
      await plain.getByRole('button', { name: 'Search', exact: true }).click();
      await plain.waitForURL((url) => meaningIn(url) === 'off');
      await plain.locator('.kf-results[data-meaning="off"]').waitFor();
      await plain.getByRole('switch', { name: 'Search by meaning' }).check();
      await plain.getByRole('button', { name: 'Search', exact: true }).click();
      await plain.waitForURL((url) => meaningIn(url) === 'off,on');
      await plain.locator('.kf-results[data-meaning="on"]').waitFor();
      await noScript.close();

      // Add: any files, one act each; one accepted and one refused, each said in words.
      await page.goto(`${webOrigin}/add`);
      await page.getByRole('heading', { name: 'Add files' }).waitFor();
      assert.deepEqual(
        await page
          .getByLabel('Who can see these files')
          .locator('option')
          .evaluateAll((options) => options.map((o) => o.value)),
        ['public', 'internal'],
        'offered only up to what the person can see',
      );
      assert.equal(await page.getByLabel('Who can see these files').inputValue(), 'internal');
      await page.getByLabel('Choose files').setInputFiles([
        { name: 'bench-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('torque 4.2 Nm') },
        {
          name: 'deploy-key.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n'),
        },
      ]);
      await page.getByLabel('Note (optional)').fill('From the AV-3000 bench');
      await page.getByRole('button', { name: 'Add 2 files' }).click();
      await page.getByRole('heading', { name: '1 added, 1 not added' }).waitFor();
      const added = page.locator('[data-add-status="added"]');
      await added.getByRole('link', { name: 'Open it' }).waitFor();
      assert.equal(
        await added.getByRole('link', { name: 'Open it' }).getAttribute('href'),
        '/objects/01900000-0000-7000-8000-0000000000f1',
      );
      const refusedFile = page.locator('[data-add-status="refused"]');
      assert.equal(await refusedFile.getAttribute('data-refusal'), 'content_refused');
      assert.match(await refusedFile.innerText(), /deploy-key\.txt was not added\. It looks like/);
      assert.match(await refusedFile.innerText(), /\(content_refused\)/);
      assert.equal(ingests.length, 2, 'one ingest per file');
      for (const body of ingests) {
        assert.equal(body.classification, 'internal');
        assert.equal(body.reason, 'From the AV-3000 bench');
        assert.equal('documentNumber' in body || 'owningRole' in body, false);
      }
      assert.deepEqual(
        ingests.map((body) => body.title),
        ['bench-notes.txt', 'deploy-key.txt'],
      );

      // The master document compiles itself on a first visit, once, and then offers Refresh.
      reader = 'narrow';
      await page.goto(`${webOrigin}/master-document`);
      await page.waitForURL(/compiled=compiled/);
      await page.getByRole('button', { name: 'Refresh' }).waitFor();
      assert.equal(compiles.length, 1, 'one visit, one compile act');
      await page.goto(`${webOrigin}/master-document`);
      await page.getByRole('button', { name: 'Refresh' }).waitFor();
      assert.equal(compiles.length, 1, 'a compiled document is not compiled again by reading');
      reader = 'ceo';

      const panelSequence = () =>
        page
          .locator('main [data-panel]')
          .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-panel')));
      const texts = () =>
        page
          .locator('[data-record]')
          .evaluateAll((nodes) =>
            nodes.map((n) => `${n.getAttribute('data-record')}|${n.innerText}`),
          );

      // (b) the CEO and the engineer: one panel sequence, different contents.
      // KF_E2E_SCREENSHOTS=<dir> keeps a picture of each page, for a person to look at.
      const shoot = async (target, name) => {
        const dir = process.env.KF_E2E_SCREENSHOTS;
        if (dir) await target.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
      };
      reader = 'ceo';
      await page.goto(`${webOrigin}/`);
      await shoot(page, 'dashboard-ceo');
      const ceoPanels = await panelSequence();
      const ceoTexts = await texts();
      reader = 'engineer';
      await page.goto(`${webOrigin}/`);
      const engineerPanels = await panelSequence();
      const engineerTexts = await texts();
      // Start Here is first in the layout and collapses for a reader with no open qualification,
      // like any empty panel (tests/joining.test.mjs shows it present for one who has).
      assert.deepEqual(
        ceoPanels,
        LAYOUT.filter((id) => id !== 'start_here'),
        'every panel of a full dashboard, in layout order',
      );
      assert.deepEqual(engineerPanels, ceoPanels, 'one layout for everyone');
      // The in-app agent (M4) is Home's ask box, before the layout and not a panel of it.
      assert.equal(await page.locator('main > .kf-askbox').count(), 1);
      assert.equal(await page.locator('.kf-askbox[data-panel]').count(), 0);
      assert.notDeepEqual(engineerTexts, ceoTexts, 'different grants, different contents');
      assert.match(
        await page.locator('[data-withheld]').textContent(),
        /12 records you could be granted, and are not/,
      );
      // (e) Needs you is a separated slot in its place: third, a child of the dashboard itself.
      const slot = page.locator('main > .kf-dashboard > [data-slot="needs-you"]');
      assert.equal(await slot.count(), 1);
      assert.equal(await slot.getAttribute('data-panel'), 'needs_you');
      // ...and it holds M2's panel, filled from the reader's own Needs-you answer.
      reader = 'ceo';
      await page.goto(`${webOrigin}/`);
      await slot.getByRole('heading', { name: 'Needs you', level: 2 }).waitFor();
      assert.equal(
        await slot.locator(`[data-record="${NEEDS_YOU_RECORD.id}"]`).count(),
        1,
        "the CEO's agent submission waits in the dashboard's Needs-you slot",
      );
      assert.match(await slot.innerText(), /One item waits on you/);
      reader = 'engineer';
      await page.goto(`${webOrigin}/`);
      assert.equal(await slot.innerHTML(), '', 'nothing needs the engineer: the slot is empty');

      // (a) empty panels collapse, and what remains keeps the layout's order.
      reader = 'narrow';
      await page.goto(`${webOrigin}/`);
      const narrowPanels = await panelSequence();
      assert.deepEqual(narrowPanels, ['master_document', 'needs_you', 'people']);
      assert.equal(await page.locator('[data-panel="overview"]').count(), 0);
      assert.equal(await page.getByRole('heading', { name: 'Work in flight' }).count(), 0);
      const visiblePanels = await page
        .locator('main [data-panel]')
        .evaluateAll((nodes) =>
          nodes
            .filter((n) => getComputedStyle(n).display !== 'none')
            .map((n) => n.getAttribute('data-panel')),
        );
      assert.deepEqual(
        visiblePanels,
        ['master_document', 'people'],
        'the empty slot takes no space',
      );

      // (c) density: presentation changes, what the reader reads does not.
      reader = 'ceo';
      await page.goto(`${webOrigin}/`);
      assert.equal(await page.locator('html').getAttribute('data-density'), 'comfortable');
      const before = await texts();
      const comfortableSize = await page
        .locator('[data-record]')
        .first()
        .evaluate((n) => getComputedStyle(n).fontSize);
      await page.getByText('More', { exact: true }).click();
      await page.getByRole('button', { name: /Switch to compact/ }).click();
      await page.waitForFunction(() => document.documentElement.dataset.density === 'compact');
      const after = await texts();
      const compactSize = await page
        .locator('[data-record]')
        .first()
        .evaluate((n) => getComputedStyle(n).fontSize);
      assert.deepEqual(after, before, 'the density setting changes no data');
      assert.notEqual(compactSize, comfortableSize, 'and it does change presentation');
      // Compact stays usable: the master document, its compile button and its paging still work.
      await shoot(page, 'dashboard-ceo-compact');
      await page.goto(`${webOrigin}/master-document`);
      await shoot(page, 'master-document-compact');
      await page.getByRole('button', { name: 'Refresh' }).waitFor();
      await page.getByRole('link', { name: /Show more artifact/ }).waitFor();
      await page.getByText(/One record compiled here is no longer yours to read/).waitFor();

      // (d) phone width: read the dashboard and the master document, open a record, capture.
      for (const density of ['compact', 'comfortable']) {
        const phone = await context.newPage();
        await phone.setViewportSize({ width: 390, height: 844 });
        for (const path of [
          '/',
          '/?q=torque+drift&mode=search',
          '/search?q=torque+drift',
          '/search?q=torque+drift&meaning=off',
          '/add',
          '/master-document',
          `/objects/${OBJECT_ID}`,
          '/capture',
        ]) {
          await phone.goto(`${webOrigin}${path}`);
          await phone.locator('main').first().waitFor();
          await shoot(phone, `phone-${density}${path.replace(/[^a-z]/g, '-')}`);
          const overflow = await phone.evaluate(() => ({
            scroll: document.scrollingElement.scrollWidth,
            client: document.scrollingElement.clientWidth,
          }));
          assert.ok(
            overflow.scroll <= overflow.client,
            `${path} at 390px (${density}) scrolls sideways: ${overflow.scroll} > ${overflow.client}`,
          );
        }
        if (density === 'compact') {
          await phone.goto(`${webOrigin}/`);
          // The navigation's More menu, open, still fits the phone.
          await phone.getByText('More', { exact: true }).click();
          const menu = await phone.evaluate(() => ({
            scroll: document.scrollingElement.scrollWidth,
            client: document.scrollingElement.clientWidth,
          }));
          assert.ok(menu.scroll <= menu.client, `More menu at 390px scrolls sideways`);
          await phone.getByRole('button', { name: /Switch to comfortable/ }).click();
          await phone.waitForFunction(
            () => document.documentElement.dataset.density === 'comfortable',
          );
        }
        await phone.close();
      }
    } catch (error) {
      error.message = `${error.message}\n--- next logs ---\n${logs.slice(-4000)}`;
      throw error;
    } finally {
      await browser?.close();
      if (web !== undefined) await stopChild(web);
      fixture.close();
      writeFileSync(declaration, originalDeclaration);
      rmSync(join(WEB_ROOT, distDir), { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  },
);
