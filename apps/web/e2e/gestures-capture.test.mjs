// Qualification gestures and phone capture in a real browser (SAS §100.62, §100.60; ADR 0038;
// ADR 0040 decision 10; KF-SAS-RQ-254, RQ-273).
//
// A production build of the web application against a fixture OIDC provider and a fixture API
// that records every write it is sent. At desktop width and at phone width (390 × 844):
//
//   (a) a pack is drafted field by field: Check runs the pack validator and an incomplete form is
//       refused by it, naming each missing thing, with nothing sent; a complete one is drafted as
//       one `draft_qualification_pack` act carrying the closed `kf-qualification-pack-v1`
//       document the form spells;
//   (b) a qualification record shows withdraw and supersede where the API offers them, and
//       withdrawing dispatches `withdraw_qualification` with the reason; a record whose answer
//       offers nothing shows no gesture at all;
//   (c) a note is captured with a photo (the file input a phone camera fills) and a voice note
//       recorded in the page (the browser's fake microphone): each goes to `POST /ingest` as
//       evidence, and the observation names both;
//   (d) every one of those pages scrolls vertically only.
//
// The fixture API stands in for the Fabric's answers; what the API decides is
// tests/database/qualification-gestures.test.ts. Run with the other browser tests:
// `pnpm --filter @kf/web test:browser`.

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
const SUBJECT = 'gestures-subject';
const ROLE_ID = '01900000-0000-7000-8000-0000000000c1';
const ORGANIZATION_ID = '01900000-0000-7000-8000-0000000000c2';
const RECORD_OFFERED = '01900000-0000-7000-8000-0000000000c3';
const RECORD_NOT_OFFERED = '01900000-0000-7000-8000-0000000000c4';
const RECORD_NEWER = '01900000-0000-7000-8000-0000000000c5';
const PERSON_ID = '01900000-0000-7000-8000-0000000000c6';
const CONTACT_ID = '01900000-0000-7000-8000-0000000000c7';
const PACK_ID = '01900000-0000-7000-8000-0000000000c8';
const OBSERVATION_ID = '01900000-0000-7000-8000-0000000000c9';
const RESOURCE_ID = '01900000-0000-7000-8000-0000000000ca';
// The smallest JPEG a camera would never produce, and enough for a file input and a media type.
const JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda0008010100003f00d2cf20ffd9',
  'hex',
);

const writes = [];
let artifacts = 0;

function stages() {
  return [
    ['read_in', 'Read-In', 'What have I joined?'],
    ['role_read_in', 'Role Read-In', 'What is my place in it?'],
    ['references', 'References', 'Where does authoritative truth live?'],
    ['execution', 'Execution', 'How does work move here?'],
    ['first_contribution', 'First Contribution', 'What bounded, useful work do I do?'],
  ].map(([id, title, question]) => ({ id, title, question, items: [], done: 0, total: 0 }));
}

function startHere(recordId) {
  return {
    format: 'kf-start-here-v1',
    recordId,
    personId: PERSON_ID,
    contact: { personId: CONTACT_ID, name: 'Audrey Lescure' },
    scope: { objectId: null, title: null },
    pack: { title: 'Véracier — aero engineer', revision: 1 },
    state: 'assigned',
    currency: 'open',
    complete: false,
    missing: [],
    gaps: [],
    blocked: [],
    stages: stages(),
    digest: createHash('sha256').update(recordId).digest('hex'),
  };
}

function gestures(recordId, offered) {
  return {
    format: 'kf-qualification-record-gestures-v1',
    recordId,
    state: 'assigned',
    withdraw: { available: offered },
    supersede: offered
      ? {
          available: true,
          candidates: [
            {
              recordId: RECORD_NEWER,
              pack: { title: 'Véracier — aero lead', revision: 2 },
              state: 'assigned',
              assignedAt: '2026-10-10T09:00:00.000Z',
            },
          ],
        }
      : { available: false, candidates: [] },
  };
}

const DRAFTING = {
  format: 'kf-qualification-pack-drafting-v1',
  draft: { available: true },
  parts: [],
  roles: ['performer', 'quality_lead', 'technical_authority'],
};

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
  const deadline = Date.now() + 60_000;
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

const writesTo = (path) => writes.filter((w) => w.path === path);

/** KF_E2E_SCREENSHOTS=<dir> keeps a picture of each page, for a person to look at. */
async function shoot(page, name) {
  const dir = process.env.KF_E2E_SCREENSHOTS;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

async function noSidewaysScroll(page, what) {
  const overflow = await page.evaluate(() => ({
    scroll: document.scrollingElement.scrollWidth,
    client: document.scrollingElement.clientWidth,
  }));
  assert.ok(
    overflow.scroll <= overflow.client,
    `${what} scrolls sideways: ${overflow.scroll} > ${overflow.client}`,
  );
}

/** (a) Draft a pack, first refused by the validator, then drafted. */
async function draftPack(page, origin, width) {
  const before = writesTo('/api/actions/draft_qualification_pack').length;
  await page.goto(`${origin}/qualification/packs/new`);
  await page.getByRole('heading', { name: 'Draft a qualification pack' }).waitFor();
  await noSidewaysScroll(page, `/qualification/packs/new at ${width}`);
  // Incomplete: the validator names what is missing, and nothing is sent.
  await page.getByRole('button', { name: 'Check' }).click();
  const problems = page.locator('[data-problem]');
  await problems.first().waitFor();
  const codes = await problems.evaluateAll((nodes) => nodes.map((n) => n.dataset.problem));
  for (const code of ['missing_field', 'missing_owner', 'mandatory_without_consequence']) {
    assert.ok(codes.includes(code), `the validator names ${code}: ${codes.join(', ')}`);
  }
  assert.match(await page.locator('#kf-pack-outcome').innerText(), /Nothing was sent/);
  await shoot(page, `pack-problems-${width}`);
  await page.getByRole('button', { name: 'Draft pack' }).click();
  await page.locator('#kf-pack-outcome [data-problem]').first().waitFor();
  assert.equal(writesTo('/api/actions/draft_qualification_pack').length, before);

  // Complete: one acknowledgement and one demonstration, accepted by a role.
  const fields = page.locator('[data-pack-fields]');
  await fields.getByLabel('Key', { exact: true }).fill(`aero-engineer-${width}`);
  await fields.getByLabel('Title', { exact: true }).fill('Aero engineer');
  await fields.getByLabel('Maintained by (role)', { exact: true }).fill('quality_lead');
  const first = page.locator('[data-requirement="1"]');
  await first.getByLabel('What must be true').fill('Has read the group procedures index');
  await first.getByLabel('Key', { exact: true }).fill('read-procedures');
  await first.getByLabel('Because').fill('Work would not follow the procedures');
  await first.getByLabel('Resources').fill(`${RESOURCE_ID} 3 normative Group procedures index`);
  await page.getByRole('button', { name: 'Add a requirement' }).click();
  const second = page.locator('[data-requirement="2"]');
  await second.getByLabel('What must be true').fill('Raised one nonconformance that was accepted');
  await second.getByLabel('Key', { exact: true }).fill('first-ncr');
  await second.getByLabel('Stage').selectOption('first_contribution');
  await second.getByLabel('Evidence that counts').selectOption('demonstrate');
  await second.getByLabel('Accepted by', { exact: true }).selectOption('role');
  await second.getByLabel('Accepting role').fill('quality_lead');
  await second.getByLabel('Because').fill('Defects would go unrecorded');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByText('The validator finds nothing to refuse.').waitFor();
  await shoot(page, `pack-checked-${width}`);
  // Checking leaves the form as the person filled it: no select falls back to its first option.
  assert.equal(await second.getByLabel('Stage').inputValue(), 'first_contribution');
  assert.equal(await second.getByLabel('Evidence that counts').inputValue(), 'demonstrate');
  assert.equal(await second.getByLabel('Accepted by', { exact: true }).inputValue(), 'role');
  assert.equal(writesTo('/api/actions/draft_qualification_pack').length, before);
  await noSidewaysScroll(page, `/qualification/packs/new, filled, at ${width}`);

  await page.getByRole('button', { name: 'Draft pack' }).click();
  await page.locator(`#kf-pack-outcome[data-pack="${PACK_ID}"]`).waitFor();
  assert.match(await page.locator('#kf-pack-outcome').innerText(), /is a draft/);
  const sent = writesTo('/api/actions/draft_qualification_pack');
  assert.equal(sent.length, before + 1, 'one gesture, one act');
  const { body } = sent.at(-1);
  assert.deepEqual(body.targetIds, []);
  assert.match(body.idempotencyKey, /^web-draft-pack-/);
  const document_ = body.payload.document;
  assert.equal(document_.format, 'kf-qualification-pack-v1');
  assert.equal(document_.key, `aero-engineer-${width}`);
  assert.equal(document_.owner, 'role:quality_lead');
  assert.deepEqual(
    document_.requirements.map((r) => [r.key, r.evidence_mode, r.accepted_by, r.stage]),
    [
      ['read-procedures', 'acknowledge', 'self', 'read_in'],
      ['first-ncr', 'demonstrate', 'role:quality_lead', 'first_contribution'],
    ],
  );
  assert.deepEqual(document_.requirements[0].resources, [
    {
      id: RESOURCE_ID,
      revision: '3',
      authority_class: 'normative',
      label: 'Group procedures index',
    },
  ]);
}

/** (b) Withdraw where offered; nothing where not. */
async function recordGestures(page, origin, width) {
  await page.goto(`${origin}/qualification/${RECORD_NOT_OFFERED}`);
  await page.getByRole('heading', { name: 'Qualification', exact: true }).waitFor();
  assert.equal(await page.locator('[data-gesture]').count(), 0, 'no gesture the API withheld');
  assert.equal(await page.getByRole('button', { name: /Withdraw|Supersede/ }).count(), 0);

  await page.goto(`${origin}/qualification/${RECORD_OFFERED}`);
  const withdraw = page.locator('[data-gesture="withdraw"]');
  await withdraw.waitFor();
  assert.equal(await page.locator('[data-gesture="supersede"]').count(), 1);
  assert.match(
    await page.locator('[data-gesture="supersede"] select').innerText(),
    /aero lead, revision 2/,
  );
  await noSidewaysScroll(page, `/qualification/<id> at ${width}`);
  await shoot(page, `record-gestures-${width}`);
  const before = writesTo('/api/actions/withdraw_qualification').length;
  await withdraw.getByLabel('Why it is withdrawn').fill(`Assigned in error (${width})`);
  await withdraw.getByRole('button', { name: 'Withdraw this qualification' }).click();
  await page.getByText('Withdrawn. The reason is recorded with the act.').waitFor();
  const sent = writesTo('/api/actions/withdraw_qualification');
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1).body.targetIds, [RECORD_OFFERED]);
  assert.equal(sent.at(-1).body.reason, `Assigned in error (${width})`);
}

/** (c) A photo and a recorded voice note, attached as evidence to one observation. */
async function capture(page, origin, width) {
  const ingests = writesTo('/api/ingest').length;
  await page.goto(`${origin}/capture`);
  await page.getByRole('heading', { name: 'Quick note' }).waitFor();
  await noSidewaysScroll(page, `/capture at ${width}`);
  await page.getByLabel('Photo', { exact: true }).setInputFiles({
    name: 'IMG_0001.jpg',
    mimeType: 'image/jpeg',
    buffer: JPEG,
  });
  await page.getByRole('button', { name: 'Record a voice note' }).click();
  await page.getByRole('button', { name: 'Stop recording' }).waitFor();
  await page.getByText(/Recording 0:0[1-9]/).waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await page.locator('audio').waitFor();
  await noSidewaysScroll(page, `/capture with a voice note at ${width}`);
  await shoot(page, `capture-voice-${width}`);
  await page.getByRole('button', { name: 'Record observation' }).click();
  await page.locator(`[data-observation="${OBSERVATION_ID}"]`).waitFor();
  assert.equal(await page.locator('[data-attached="photo"]').count(), 1);
  assert.equal(await page.locator('[data-attached="voice"]').count(), 1);
  assert.match(await page.locator('[data-attached="voice"]').innerText(), /not transcribed/);
  await shoot(page, `capture-recorded-${width}`);

  const sent = writesTo('/api/ingest').slice(ingests);
  assert.equal(sent.length, 2, 'the photo and the voice note, each ingested once');
  const [photo, voice] = sent.map((w) => w.body);
  assert.equal(photo.mediaType, 'image/jpeg');
  assert.equal(photo.title, 'Photo: IMG_0001.jpg');
  assert.deepEqual(Buffer.from(photo.contentBase64, 'base64'), JPEG);
  assert.match(voice.mediaType, /^audio\/(webm|ogg|mp4)$/);
  assert.ok(Buffer.from(voice.contentBase64, 'base64').length > 0, 'the recording has bytes');
  for (const body of [photo, voice]) {
    assert.equal(body.artifactKind, 'other');
    assert.equal(body.classification, 'internal');
  }
  const observation = writesTo('/api/capture/observation').at(-1).body;
  assert.match(observation.body, /a photo and a voice note.*Not transcribed/);
  assert.deepEqual(
    observation.subjects,
    sent.map((w) => w.answer),
    'the observation names each piece of evidence',
  );
}

test(
  'pack drafting, record gestures and phone capture (SAS §100.62, §100.60)',
  { timeout: 600_000 },
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
            .setProtectedHeader({ alg: 'RS256', kid: 'gestures-key' })
            .setIssuer(issuer)
            .setAudience(CLIENT_ID)
            .setSubject(SUBJECT)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);
          return json(response, 200, {
            access_token: 'gestures-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken,
          });
        }
        if (url.pathname === '/realms/kf/protocol/openid-connect/certs') {
          return json(response, 200, {
            keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid: 'gestures-key' }],
          });
        }
        if (!url.pathname.startsWith('/api/')) return json(response, 404, { error: 'not_found' });
        if (url.pathname === '/api/readiness') {
          const checks = [{ id: 'fixture', scope: 'service', status: 'ok', detail: 'Ready.' }];
          return json(response, 200, {
            ready: true,
            checks,
            service: { ready: true, checks },
            institutional: { ready: true, checks: [] },
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
          request.headers.authorization !== 'Bearer gestures-access-token' ||
          request.headers['x-kf-organization'] !== ORGANIZATION_ID ||
          request.headers['x-kf-acting-role'] !== ROLE_ID
        ) {
          return json(response, 401, { error: 'unidentified', message: 'context refused' });
        }
        if (request.method === 'POST') {
          const body = JSON.parse(await requestBody(request));
          const write = { path: url.pathname, body, answer: undefined };
          writes.push(write);
          if (url.pathname === '/api/ingest') {
            artifacts += 1;
            write.answer = `01900000-0000-7000-8000-${String(0xd00 + artifacts).padStart(12, '0')}`;
            return json(response, 201, {
              artifactId: write.answer,
              actionId: 'ingest-action',
              auditDigest: 'a'.repeat(64),
              sha256: 'b'.repeat(64),
              sizeBytes: 1,
              classification: body.classification,
              replayed: false,
            });
          }
          if (url.pathname === '/api/capture/observation') {
            return json(response, 201, {
              observationId: OBSERVATION_ID,
              actionId: 'observation-action',
              replayed: false,
              gestureId: body.gesture_id,
              actingRoleId: ROLE_ID,
              lifecycleState: 'captured',
              verification: {
                verified: false,
                label: 'UNVERIFIED — nobody has checked this record',
              },
              auditDigest: 'c'.repeat(64),
            });
          }
          if (url.pathname.startsWith('/api/actions/')) {
            return json(response, 201, {
              actionId: 'act',
              replayed: false,
              objectIds: url.pathname.endsWith('draft_qualification_pack') ? [PACK_ID] : [],
              auditDigest: 'd'.repeat(64),
            });
          }
          return json(response, 404, { error: 'not_found', message: url.pathname });
        }
        // Sign-in confirms the chosen context by reading the document library.
        if (url.pathname === '/api/documents') return json(response, 200, { documents: [] });
        if (url.pathname === '/api/qualification/packs/drafting')
          return json(response, 200, DRAFTING);
        for (const [id, offered] of [
          [RECORD_OFFERED, true],
          [RECORD_NOT_OFFERED, false],
        ]) {
          if (url.pathname === `/api/qualification/records/${id}`) {
            return json(response, 200, startHere(id));
          }
          if (url.pathname === `/api/qualification/records/${id}/gestures`) {
            return json(response, 200, gestures(id, offered));
          }
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

    const runtime = mkdtempSync(join(tmpdir(), 'kf-web-gestures-'));
    const declaration = join(WEB_ROOT, 'next-env.d.ts');
    const originalDeclaration = readFileSync(declaration);
    const secretPath = join(runtime, 'session-secret');
    writeFileSync(secretPath, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
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
      // A fake microphone, allowed without a prompt: the recorder records a tone.
      const launch = {
        headless: true,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
      };
      if (process.env.KF_BROWSER_EXECUTABLE)
        launch.executablePath = process.env.KF_BROWSER_EXECUTABLE;
      if (process.env.KF_BROWSER_CHANNEL) launch.channel = process.env.KF_BROWSER_CHANNEL;
      browser = await playwright.chromium.launch(launch);
      const context = await browser.newContext();
      await context.grantPermissions(['microphone'], { origin: webOrigin });
      const page = await context.newPage();
      page.setDefaultTimeout(60_000);

      await page.goto(`${webOrigin}/`);
      // One live assignment: sign-in lands on Home with no picker in between.
      await page.locator('.kf-landing').getByRole('link', { name: 'Sign in' }).click();
      await page.waitForURL(`${webOrigin}/`);

      for (const [width, height] of [
        [1280, 900],
        [390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        await draftPack(page, webOrigin, width);
        await recordGestures(page, webOrigin, width);
        await capture(page, webOrigin, width);
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
