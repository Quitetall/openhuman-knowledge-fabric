// Joining in a real browser (ADR 0040 decision 12; ADR 0038; KF-SAS-RQ-273, RQ-275; KF-WAR-0007
// OBL-005).
//
// A production build of the web application against a fixture OIDC provider and a fixture API
// that answers as the Fabric would for one invited person, whose record moves as they act:
//
//   (a) the invitation link leads, through sign-in, to Start Here — and only for that person;
//   (b) Start Here is the five stages, each item a requirement with its status by form, and a
//       blocker reads as the organization's, naming the contact;
//   (c) the person acknowledges a read-in and submits a first Warrant as evidence, each one
//       gesture, each answered on the page;
//   (d) the dashboard shows Start Here first while it is open;
//   (e) once their reviewers have credited it, they are qualified, and Start Here leaves the
//       dashboard;
//   (f) at phone width (390 × 844) Start Here, the invitation and the dashboard scroll vertically
//       only.
//
// The database half of this flow — the invitation, the records, the credits and the closing — is
// tests/database/joining.test.ts; this file holds what a person sees and does.
//
// Run with the other browser tests: `pnpm --filter @kf/web test:browser`.

/* global document */

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
const SUBJECT = 'joining-subject';
const ROLE_ID = '01900000-0000-7000-8000-0000000000f1';
const ORGANIZATION_ID = '01900000-0000-7000-8000-0000000000f2';
const RECORD_ID = '01900000-0000-7000-8000-0000000000f3';
const PERSON_ID = '01900000-0000-7000-8000-0000000000f4';
const CONTACT_ID = '01900000-0000-7000-8000-0000000000f5';
const OVERVIEW_ID = '01900000-0000-7000-8000-0000000000f6';
const PROCEDURES_ID = '01900000-0000-7000-8000-0000000000f7';
const WARRANT_ID = '01900000-0000-7000-8000-0000000000f8';
const TOKEN = randomBytes(32).toString('base64url');
const LAYOUT = [
  'start_here',
  'overview',
  'master_document',
  'needs_you',
  'work_in_flight',
  'recent_record',
  'people',
];

// The record, as the API would evaluate it. Each gesture below moves it.
const state = {
  readIn: 'open',
  references: 'blocked_on_organization',
  firstContribution: 'open',
  qualified: false,
  acts: [],
};

function item(key, outcome, mode, acceptedBy, status, extra = {}) {
  return {
    key,
    outcome,
    mode,
    mandatory: true,
    consequence: { kind: 'unreliable', statement: `Without ${key} the work is unreliable.` },
    acceptedBy,
    status,
    revision: 1,
    evidence:
      status === 'satisfied'
        ? {
            creditId: '01900000-0000-7000-8000-0000000000e9',
            revision: 1,
            evidenceObjectId: extra.evidence ?? null,
            priorCreditId: null,
            creditedBy: acceptedBy === 'self' ? PERSON_ID : CONTACT_ID,
            creditedAt: '2026-10-07T10:00:00.000Z',
          }
        : null,
    submitted:
      status === 'submitted'
        ? [{ id: '01900000-0000-7000-8000-0000000000ea', evidenceObjectId: WARRANT_ID }]
        : [],
    blockers:
      status === 'blocked_on_organization'
        ? [{ kind: 'resource_not_granted', resourceId: PROCEDURES_ID }]
        : [],
    resources: extra.resources ?? [],
    awaiting: [],
    gates: [],
  };
}

function startHere() {
  const items = {
    read_in: [
      item(
        'veracier.common.read-in',
        'Knows what Véracier is: its entities and programmes.',
        'acknowledge',
        'self',
        state.readIn,
        {
          evidence: OVERVIEW_ID,
          resources: [
            {
              id: OVERVIEW_ID,
              revision: '1',
              authorityClass: 'reference',
              label: 'Véracier at a glance',
              reach: 'readable',
            },
          ],
        },
      ),
    ],
    role_read_in: [],
    references: [
      item(
        'veracier.common.references',
        'Finds the normative procedure for the task at hand.',
        'locate',
        'contact',
        state.references,
        {
          resources: [
            {
              id: PROCEDURES_ID,
              revision: 'A',
              authorityClass: 'normative',
              label: 'Group procedures',
              reach: state.references === 'blocked_on_organization' ? 'not_granted' : 'readable',
            },
          ],
        },
      ),
    ],
    execution: [],
    first_contribution: [
      item(
        'veracier.common.first-contribution',
        'Has finished one bounded Warrant, accepted as is.',
        'demonstrate',
        'contact',
        state.firstContribution,
        {
          evidence: WARRANT_ID,
        },
      ),
    ],
  };
  const stages = [
    ['read_in', 'Read-In', 'What have I joined?'],
    ['role_read_in', 'Role Read-In', 'What is my place in it?'],
    ['references', 'References', 'Where does authoritative truth live?'],
    ['execution', 'Execution', 'How does work move here?'],
    [
      'first_contribution',
      'First Contribution',
      'What bounded, useful work do I do through the normal system?',
    ],
  ].map(([id, title, question]) => ({
    id,
    title,
    question,
    items: items[id],
    done: items[id].filter((i) => i.status === 'satisfied').length,
    total: items[id].length,
  }));
  const all = stages.flatMap((s) => s.items);
  const missing = all.filter((i) => i.status !== 'satisfied').map((i) => i.key);
  return {
    format: 'kf-start-here-v1',
    recordId: RECORD_ID,
    personId: PERSON_ID,
    contact: { personId: CONTACT_ID, name: 'Audrey Lescure' },
    scope: { objectId: null, title: 'AV-3000 programme' },
    pack: {
      id: '01900000-0000-7000-8000-0000000000eb',
      key: 'veracier.aero-engineer',
      title: 'Véracier — aero engineer, AV-3000',
      revision: 1,
    },
    state: state.qualified ? 'qualified' : 'assigned',
    currency: state.qualified ? 'qualified' : 'open',
    complete: missing.length === 0,
    missing,
    gaps: [],
    blocked: all.filter((i) => i.status === 'blocked_on_organization').map((i) => i.key),
    stages,
    digest: createHash('sha256').update(JSON.stringify(stages)).digest('hex'),
  };
}

function dashboard() {
  const page = startHere();
  return {
    format: 'kf-dashboard-v1',
    layout: LAYOUT,
    panels: [
      state.qualified
        ? { id: 'start_here', empty: true, pages: [] }
        : { id: 'start_here', empty: false, pages: [page] },
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
            organizationWide: true,
            validTo: '2027-10-07T00:00:00.000Z',
            reaches: [],
          },
        ],
        presetGrants: 0,
        qualification: {
          own: [
            {
              recordId: RECORD_ID,
              packTitle: page.pack.title,
              state: page.state,
              currency: page.currency,
              missing: page.missing.length,
              gaps: [],
              blocked: page.blocked.length,
            },
          ],
          reviewing: [],
        },
      },
    ],
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
  'an invited person reaches Start Here, works through it and is qualified, at desktop and phone width',
  { timeout: 300_000 },
  async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const codes = new Map();
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
            .setProtectedHeader({ alg: 'RS256', kid: 'joining-key' })
            .setIssuer(issuer)
            .setAudience(CLIENT_ID)
            .setSubject(SUBJECT)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);
          return json(response, 200, {
            access_token: 'joining-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
          });
        }
        if (url.pathname === '/realms/kf/protocol/openid-connect/certs') {
          return json(response, 200, {
            keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid: 'joining-key' }],
          });
        }
        if (!url.pathname.startsWith('/api/')) return json(response, 404, { error: 'not_found' });
        if (url.pathname === '/api/readiness') {
          const checks = [
            { id: 'fixture_runtime', scope: 'service', status: 'ok', detail: 'Ready.' },
          ];
          return json(response, 200, {
            ready: true,
            checks,
            service: { ready: true, checks },
            institutional: { ready: false, checks: [] },
          });
        }
        if (url.pathname === '/api/session/contexts') {
          return json(response, 200, {
            personId: PERSON_ID,
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
          request.headers.authorization !== 'Bearer joining-access-token' ||
          request.headers['x-kf-organization'] !== ORGANIZATION_ID ||
          request.headers['x-kf-acting-role'] !== ROLE_ID
        ) {
          return json(response, 401, { error: 'unidentified', message: 'context refused' });
        }
        if (url.pathname === '/api/documents') return json(response, 200, { documents: [] });
        if (url.pathname === `/api/invitations/${TOKEN}`) {
          return json(response, 200, {
            format: 'kf-invitation-v1',
            invitationId: '01900000-0000-7000-8000-0000000000ec',
            organizationId: ORGANIZATION_ID,
            recordId: RECORD_ID,
            expired: false,
            expiresAt: '2026-10-14T00:00:00.000Z',
            next: '/start-here',
          });
        }
        if (url.pathname.startsWith('/api/invitations/')) {
          return json(response, 404, { error: 'not_found' });
        }
        if (url.pathname === '/api/start-here') {
          return json(response, 200, { format: 'kf-start-here-list-v1', pages: [startHere()] });
        }
        if (url.pathname === '/api/dashboard') return json(response, 200, dashboard());
        if (url.pathname === '/api/needs-you') {
          const nothing = { items: [], total: 0 };
          return json(response, 200, {
            toVerify: nothing,
            awaitingOthers: nothing,
            proposals: nothing,
            toCredit: nothing,
          });
        }
        if (
          request.method === 'POST' &&
          url.pathname === `/api/qualification/records/${RECORD_ID}/credit`
        ) {
          const body = JSON.parse(await requestBody(request));
          assert.equal(body.credits[0].requirementKey, 'veracier.common.read-in');
          assert.equal(body.credits[0].evidenceObjectId, OVERVIEW_ID);
          state.readIn = 'satisfied';
          state.acts.push('credit_qualification_evidence');
          return json(response, 201, { actionType: 'credit_qualification_evidence' });
        }
        if (
          request.method === 'POST' &&
          url.pathname === `/api/qualification/records/${RECORD_ID}/submit`
        ) {
          const body = JSON.parse(await requestBody(request));
          assert.equal(body.requirementKey, 'veracier.common.first-contribution');
          assert.equal(body.evidenceObjectId, WARRANT_ID);
          state.firstContribution = 'submitted';
          state.acts.push('submit_qualification_evidence');
          return json(response, 201, { actionType: 'submit_qualification_evidence' });
        }
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

    const runtime = mkdtempSync(join(tmpdir(), 'kf-web-joining-'));
    const declaration = join(WEB_ROOT, 'next-env.d.ts');
    const originalDeclaration = readFileSync(declaration);
    const secretPath = join(runtime, 'session-secret');
    writeFileSync(secretPath, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
    // A process-scoped build directory (next.config.mjs refuses any other name).
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
      const build = spawn(
        process.execPath,
        [`${WEB_ROOT}/node_modules/next/dist/bin/next`, 'build', '--webpack'],
        { cwd: WEB_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      build.stdout.on('data', collect);
      build.stderr.on('data', collect);
      const [code] = await once(build, 'exit');
      if (code !== 0) throw new Error(`Next build failed with ${code}\n${logs}`);
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
      const shoot = async (target, name) => {
        const dir = process.env.KF_E2E_SCREENSHOTS;
        if (dir) await target.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
      };
      const sideways = async (target) =>
        target.evaluate(() => ({
          scroll: document.scrollingElement.scrollWidth,
          client: document.scrollingElement.clientWidth,
        }));

      // (a) The link, signed out: sign-in first, then back to the link, then Start Here.
      await page.goto(`${webOrigin}/join/${TOKEN}`);
      await page.waitForURL(`${webOrigin}/session/select**`);
      await page.getByRole('button', { name: 'Validate with KF API', exact: true }).click();
      await page.waitForURL(`${webOrigin}/start-here`);

      // (b) Five stages, items by status, the blocker the organization's.
      const stageTitles = await page
        .locator('[data-stage] h3')
        .evaluateAll((nodes) => nodes.map((n) => n.textContent.split(' — ')[0].trim()));
      assert.deepEqual(stageTitles, [
        'Read-In',
        'Role Read-In',
        'References',
        'Execution',
        'First Contribution',
      ]);
      const status = (key) =>
        page.locator(`[data-requirement="${key}"]`).getAttribute('data-status');
      assert.equal(await status('veracier.common.read-in'), 'open');
      const blocker = page.locator(
        '[data-requirement="veracier.common.references"] [data-blocker]',
      );
      assert.match(
        await blocker.innerText(),
        /Blocked on the organization.*not yours.*Audrey Lescure/s,
      );
      assert.match(await page.locator('[data-digest]').innerText(), /never edited/);
      await shoot(page, 'start-here-open');

      // (c) Acknowledge the read-in, then submit the first Warrant: one gesture each.
      await page.getByRole('button', { name: 'I have received and reviewed it' }).click();
      await page.getByRole('status').filter({ hasText: 'Acknowledged' }).waitFor();
      assert.equal(await status('veracier.common.read-in'), 'satisfied');
      const first = page.locator('[data-requirement="veracier.common.first-contribution"]');
      await first.getByLabel('The record that shows it (its id)').fill(WARRANT_ID);
      await first.getByRole('button', { name: 'Submit as evidence' }).click();
      await page.getByRole('status').filter({ hasText: 'Submitted' }).waitFor();
      assert.equal(await status('veracier.common.first-contribution'), 'submitted');
      assert.deepEqual(state.acts, [
        'credit_qualification_evidence',
        'submit_qualification_evidence',
      ]);

      // (d) The dashboard: Start Here first while it is open.
      await page.goto(`${webOrigin}/`);
      const panels = await page
        .locator('main [data-panel]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-panel')));
      assert.equal(panels[0], 'start_here');
      await shoot(page, 'dashboard-joining');

      // (f) Phone width, while it is open.
      const phone = await context.newPage();
      await phone.setViewportSize({ width: 390, height: 844 });
      for (const path of ['/start-here', '/', `/join/${'z'.repeat(43)}`]) {
        await phone.goto(`${webOrigin}${path}`);
        await phone.locator('main').first().waitFor();
        await shoot(phone, `phone-joining${path.replace(/[^a-z]/g, '-')}`);
        const overflow = await sideways(phone);
        assert.ok(
          overflow.scroll <= overflow.client,
          `${path} at 390px scrolls sideways: ${overflow.scroll} > ${overflow.client}`,
        );
      }
      // Another token is no invitation for this account, and says only that.
      await phone.goto(`${webOrigin}/join/${'z'.repeat(43)}`);
      await phone.getByText(/not an invitation for the account you are signed in with/).waitFor();

      // (e) The reviewers credit the rest from their Needs you (tests/database/joining.test.ts);
      // the record they leave is what the person now sees.
      state.references = 'satisfied';
      state.firstContribution = 'satisfied';
      state.qualified = true;
      await page.goto(`${webOrigin}/start-here`);
      assert.equal(
        await page.locator('[data-currency]').getAttribute('data-currency'),
        'qualified',
      );
      await page.getByText('Qualified.').waitFor();
      await page.goto(`${webOrigin}/`);
      assert.equal(await page.locator('[data-panel="start_here"]').count(), 0);
      assert.match(
        await page.locator('[data-panel="people"] [data-qualification]').innerText(),
        /qualified/,
      );
      await phone.goto(`${webOrigin}/start-here`);
      const qualifiedOverflow = await sideways(phone);
      assert.ok(qualifiedOverflow.scroll <= qualifiedOverflow.client);
      await phone.close();
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
