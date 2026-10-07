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
          const idToken = await new SignJWT({ nonce: transaction.nonce })
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
          return json(response, 200, masterDocument(reader));
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

      // Signed out, the home page asks the person to sign in and still reports status.
      await page.goto(`${webOrigin}/`);
      await page.getByRole('heading', { name: 'Implemented capability gates' }).waitFor();
      await page.locator('.kf-signin').getByRole('link', { name: 'Sign in' }).click();
      await page.waitForURL(`${webOrigin}/session/select**`);
      await page.getByRole('button', { name: 'Validate with KF API', exact: true }).click();
      await page.waitForURL(`${webOrigin}/`);

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
      assert.notDeepEqual(engineerTexts, ceoTexts, 'different grants, different contents');
      assert.match(
        await page.locator('[data-withheld]').textContent(),
        /12 records you could be granted, and are not/,
      );
      // (e) Needs you is a separated slot in its place: third, a child of the dashboard itself.
      const slot = page.locator('main > [data-slot="needs-you"]');
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
      await page.getByRole('button', { name: 'Compile now' }).waitFor();
      await page.getByRole('link', { name: /Show more artifact/ }).waitFor();
      await page.getByText(/One record compiled here is no longer yours to read/).waitFor();

      // (d) phone width: read the dashboard and the master document, open a record, capture.
      for (const density of ['compact', 'comfortable']) {
        const phone = await context.newPage();
        await phone.setViewportSize({ width: 390, height: 844 });
        for (const path of ['/', '/master-document', `/objects/${OBJECT_ID}`, '/capture']) {
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
