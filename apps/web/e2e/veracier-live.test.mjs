/**
 * The Véracier fixture, walked through a real browser against a real stack: Keycloak's own login
 * form, the web's context picker, the API's access decisions and the corpus they cover.
 *
 * Opt-in only (`KF_VERACIER_LIVE=1`): it needs the fixture stack running and the persona
 * passwords on this machine, which neither CI nor a fresh checkout has. What it proves that the
 * fixture test cannot is that the API's decisions reach the page intact for two people with
 * different reach: the chief executive sees strictly more exact matches than a plant supervisor,
 * the supervisor is told how many matching records were withheld, the executive is told none were,
 * and an artifact the supervisor can read opens with its file and its extracted text.
 *
 * Passwords are read from the personas file and typed into Keycloak's form; they are never logged
 * or put in an assertion message.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const LIVE = process.env.KF_VERACIER_LIVE === '1';
const WEB = (process.env.KF_VERACIER_WEB ?? 'http://localhost:3100').replace(/\/$/, '');
const PERSONAS =
  process.env.KF_VERACIER_PERSONAS ?? join(homedir(), '.config/kf/veracier-personas.txt');
const QUERY = process.env.KF_VERACIER_QUERY ?? 'qualite';
const STEP_TIMEOUT = 30_000;

/** username → password, from the tab-separated personas file. */
function passwords() {
  const entries = readFileSync(PERSONAS, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => line.split('\t'))
    .filter((fields) => fields.length >= 2 && fields[0] !== '' && fields[1] !== '')
    .map((fields) => [fields[0], fields[1]]);
  return new Map(entries);
}

function password(all, username) {
  const value = all.get(username);
  if (value === undefined) throw new Error(`no password for ${username} in the personas file`);
  return value;
}

/**
 * Sign in as `username` in a fresh browser context and choose the context the picker offers:
 * the preselected (or first) assignment, at the ceiling it defaults to — the person's clearance.
 */
async function signIn(browser, username, secret) {
  const context = await browser.newContext();
  context.setDefaultTimeout(STEP_TIMEOUT);
  context.setDefaultNavigationTimeout(STEP_TIMEOUT);
  const page = await context.newPage();
  await page.goto(`${WEB}/search`);
  if (!page.url().startsWith(WEB)) {
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(secret);
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.href.startsWith(WEB) && !url.pathname.startsWith('/auth/'));
  if (new URL(page.url()).pathname === '/session/select') {
    const picker = page.locator('form[action="/auth/context"]:has(input[type="radio"])');
    const failure = page.locator('[data-assignments]');
    await Promise.race([picker.waitFor(), failure.waitFor()]);
    if ((await failure.count()) > 0) {
      throw new Error(
        `context picker did not list assignments for ${username}: ${await failure.innerText()}`,
      );
    }
    const radios = picker.locator('input[type="radio"][name="actingRoleId"]');
    assert.ok((await radios.count()) >= 1, `${username} must be offered at least one role`);
    const checked = picker.locator('input[type="radio"][name="actingRoleId"]:checked');
    if ((await checked.count()) === 0) await radios.first().check();
    await picker.getByRole('button', { name: 'Validate with KF API', exact: true }).click();
    await page.waitForURL(`${WEB}/search**`);
  }
  return { context, page };
}

/** The search page's own statement of the answer: exact-match total and withheld count. */
async function searchCounts(page) {
  await page.goto(`${WEB}/search?q=${encodeURIComponent(QUERY)}`);
  // The complete list of word matches is folded under the fused list: present, not shown.
  const lexical = page.locator('section[data-list="lexical"]');
  await lexical.waitFor({ state: 'attached' });
  const total = Number(await lexical.getAttribute('data-total'));
  assert.ok(Number.isSafeInteger(total), 'the lexical list states its total');
  const withheldNote = page.locator('[data-withheld-count]');
  const withheld =
    (await withheldNote.count()) === 0
      ? 0
      : Number(await withheldNote.first().getAttribute('data-withheld-count'));
  return { total, withheld, withheldText: withheld === 0 ? '' : await withheldNote.innerText() };
}

test(
  'Véracier: reach differs by person, withholding is stated, artifacts open with their text',
  {
    skip: LIVE
      ? false
      : 'live stack walk; set KF_VERACIER_LIVE=1 with the Véracier fixture stack running',
    timeout: 240_000,
  },
  async () => {
    const all = passwords();
    const playwright = await import(process.env.KF_PLAYWRIGHT_CORE_PATH ?? 'playwright-core');
    const launchOptions = { headless: true };
    if (process.env.KF_BROWSER_EXECUTABLE) {
      launchOptions.executablePath = process.env.KF_BROWSER_EXECUTABLE;
    }
    const browser = await playwright.chromium.launch(launchOptions);
    try {
      const supervisor = await signIn(browser, 'youssef.amrani', password(all, 'youssef.amrani'));
      const supervisorCounts = await searchCounts(supervisor.page);

      const executive = await signIn(browser, 'helene.daubrac', password(all, 'helene.daubrac'));
      const executiveCounts = await searchCounts(executive.page);
      await executive.context.close();

      assert.ok(
        executiveCounts.total > supervisorCounts.total,
        `CEO exact matches (${executiveCounts.total}) must exceed the supervisor's (${supervisorCounts.total})`,
      );
      assert.ok(supervisorCounts.withheld > 0, 'the supervisor is told matches were withheld');
      assert.match(
        supervisorCounts.withheldText,
        new RegExp(
          `^${supervisorCounts.withheld} more matching records? (is|are) within your clearance but not granted to you`,
        ),
      );
      assert.equal(executiveCounts.withheld, 0, 'nothing is withheld from the CEO for this query');

      // An artifact the supervisor can read: from a search hit to the original PDF's page.
      const { page } = supervisor;
      await page.goto(`${WEB}/search?q=${encodeURIComponent(QUERY)}`);
      const hit = page.locator('article[data-object-type="artifact"] a').first();
      await hit.waitFor();
      await hit.click();
      await page.waitForURL(`${WEB}/objects/**`);
      await page.locator('[data-artifact-panel]').waitFor();
      const extractedFrom = page.locator('[data-artifact-derivation="extracted-from"] a');
      if ((await extractedFrom.count()) > 0) {
        // Wait for the PDF's own address: the text artifact's page already matches /objects/**.
        const original = await extractedFrom.getAttribute('href');
        await extractedFrom.click();
        await page.waitForURL(`${WEB}${original}`);
        await page.locator('[data-artifact-panel]').waitFor();
      }
      const artifactId = decodeURIComponent(new URL(page.url()).pathname.split('/')[2] ?? '');
      const encoded = encodeURIComponent(artifactId);

      const open = page.locator('a[data-artifact-link="open"]');
      const download = page.locator('a[data-artifact-link="download"]');
      assert.equal(
        await open.getAttribute('href'),
        `/documents/${encoded}/source?disposition=inline`,
      );
      assert.equal(await open.getAttribute('target'), '_blank');
      assert.equal(await download.getAttribute('href'), `/documents/${encoded}/source`);
      const served = await page.evaluate(
        async ([openHref, downloadHref]) => {
          const read = async (href) => {
            const response = await globalThis.fetch(href);
            const bytes = new Uint8Array(await response.arrayBuffer());
            return {
              status: response.status,
              type: response.headers.get('content-type'),
              disposition: response.headers.get('content-disposition'),
              magic: String.fromCharCode(...bytes.slice(0, 5)),
            };
          };
          return { open: await read(openHref), download: await read(downloadHref) };
        },
        [await open.getAttribute('href'), await download.getAttribute('href')],
      );
      assert.equal(served.open.status, 200);
      assert.equal(served.download.status, 200);
      assert.match(served.open.disposition ?? '', /^inline/);
      assert.match(served.download.disposition ?? '', /^attachment/);
      assert.equal(served.open.type, 'application/pdf');
      assert.equal(served.open.magic, '%PDF-');

      const extractedText = page.locator('[data-artifact-derivation="extracted-text"] a');
      assert.equal(await extractedText.count(), 1, 'the PDF names its extracted text');
      const text = page.locator('[data-artifact-text="shown"] pre');
      await text.waitFor();
      assert.ok((await text.innerText()).trim().length > 0, 'the extracted text is rendered');
      await page.getByText('This text was extracted by machine').waitFor();

      await supervisor.context.close();
    } finally {
      await browser.close();
    }
  },
);
