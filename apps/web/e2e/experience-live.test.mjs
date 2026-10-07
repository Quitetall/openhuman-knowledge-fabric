/* global document */
/**
 * The experience against a live Véracier fixture stack (ADR 0040; KF-SAS-RQ-262, RQ-273, RQ-276).
 *
 * Opt-in only (`KF_EXPERIENCE_LIVE=1`): it needs the fixture stack running, loaded with the role
 * presets of fixtures/veracier/roles.mjs, and the persona passwords file. It signs in through the
 * real realm as the CEO and as the AV-3000 aero engineer and checks, in a real browser, what the
 * mocked e2e (experience.test.mjs) checks against fixtures:
 *
 *   - one layout: both dashboards list the same panels in the same order, and the contents differ
 *     (the CEO reaches records the engineer does not);
 *   - phone width: at 390x844 the dashboard and the master document scroll no sideways;
 *   - density: switching to compact changes no record text on the dashboard.
 *
 * Passwords are read from the personas file and never printed or put in an assertion message.
 *
 *   KF_EXPERIENCE_LIVE=1 KF_VERACIER_WEB=http://localhost:3400 \
 *     KF_VERACIER_PERSONAS=<file> node --test e2e/experience-live.test.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const LIVE = process.env.KF_EXPERIENCE_LIVE === '1';
const WEB = (process.env.KF_VERACIER_WEB ?? 'http://localhost:3100').replace(/\/$/, '');
const PERSONAS =
  process.env.KF_VERACIER_PERSONAS ?? join(homedir(), '.config/kf/veracier-personas.txt');
const STEP_TIMEOUT = 30_000;
const CEO = process.env.KF_EXPERIENCE_CEO ?? 'helene.daubrac';
const ENGINEER = process.env.KF_EXPERIENCE_ENGINEER ?? 'mathieu.roux';

function passwords() {
  return new Map(
    readFileSync(PERSONAS, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))
      .map((line) => line.split('\t'))
      .filter((fields) => fields.length >= 2 && fields[0] !== '' && fields[1] !== '')
      .map((fields) => [fields[0], fields[1]]),
  );
}

/** Sign in and take the context the picker preselects (or the first), at the person's clearance. */
async function signIn(browser, username, secret, viewport) {
  const context = await browser.newContext(viewport === undefined ? {} : { viewport });
  context.setDefaultTimeout(STEP_TIMEOUT);
  context.setDefaultNavigationTimeout(STEP_TIMEOUT);
  const page = await context.newPage();
  await page.goto(`${WEB}/`);
  if (!page.url().startsWith(WEB)) {
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(secret);
    await page.locator('#kc-login').click();
  } else if ((await page.locator('[data-layout]').count()) === 0) {
    await page.goto(`${WEB}/search`);
    if (!page.url().startsWith(WEB)) {
      await page.locator('#username').fill(username);
      await page.locator('#password').fill(secret);
      await page.locator('#kc-login').click();
    }
  }
  await page.waitForURL((url) => url.href.startsWith(WEB) && !url.pathname.startsWith('/auth/'));
  if (new URL(page.url()).pathname === '/session/select') {
    const picker = page.locator('form[action="/auth/context"]:has(input[type="radio"])');
    await picker.waitFor();
    const radios = picker.locator('input[type="radio"][name="actingRoleId"]');
    const checked = picker.locator('input[type="radio"][name="actingRoleId"]:checked');
    if ((await checked.count()) === 0) await radios.first().check();
    await picker.getByRole('button', { name: 'Validate with KF API', exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/session/'));
  }
  await page.goto(`${WEB}/`);
  await page.locator('[data-layout]').waitFor();
  return { context, page };
}

async function panels(page) {
  return page.locator('[data-panel]').evaluateAll((nodes) => nodes.map((n) => n.dataset.panel));
}

async function records(page) {
  return page
    .locator('[data-record]')
    .evaluateAll((nodes) => nodes.map((n) => n.innerText.replace(/\s+/g, ' ').trim()));
}

async function scrollsSideways(page) {
  return page.evaluate(
    () => document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
  );
}

test(
  'Véracier: one layout for the CEO and the engineer, usable at phone width and compact',
  {
    skip: LIVE ? false : 'live stack walk; set KF_EXPERIENCE_LIVE=1 with the fixture stack running',
    timeout: 240_000,
  },
  async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch();
    const all = passwords();
    try {
      const ceo = await signIn(browser, CEO, all.get(CEO));
      const engineer = await signIn(browser, ENGINEER, all.get(ENGINEER));
      const ceoPanels = await panels(ceo.page);
      const engineerPanels = await panels(engineer.page);
      // Same layout: every panel either shows has the layout's order, and Needs you is its slot.
      const layout = (await ceo.page.locator('[data-layout]').getAttribute('data-layout')).split(
        ' ',
      );
      const inOrder = (ids) =>
        ids.every((id, i) => i === 0 || layout.indexOf(ids[i - 1]) < layout.indexOf(id));
      assert.ok(inOrder(ceoPanels) && inOrder(engineerPanels), 'panels follow the one layout');
      assert.equal(
        await engineer.page.locator('[data-layout]').getAttribute('data-layout'),
        layout.join(' '),
        'the engineer is given the same layout',
      );
      const ceoRecords = new Set(await records(ceo.page));
      const engineerRecords = await records(engineer.page);
      assert.ok(ceoRecords.size > 0 && engineerRecords.length > 0, 'both read something');
      assert.notDeepEqual([...ceoRecords].sort(), [...engineerRecords].sort(), 'contents differ');

      // Density: compact changes no record text.
      const before = await records(engineer.page);
      await engineer.page.locator('[data-density-switch="compact"]').click();
      await engineer.page.waitForFunction(
        () => document.documentElement.dataset.density === 'compact',
      );
      assert.deepEqual(await records(engineer.page), before, 'compact shows the same records');

      // Phone width.
      const phone = await signIn(browser, ENGINEER, all.get(ENGINEER), {
        width: 390,
        height: 844,
      });
      for (const route of ['/', '/master-document', '/capture']) {
        await phone.page.goto(`${WEB}${route}`);
        await phone.page.waitForLoadState('networkidle');
        assert.equal(
          await scrollsSideways(phone.page),
          false,
          `${route} scrolls sideways at 390px`,
        );
      }
      for (const session of [ceo, engineer, phone]) await session.context.close();
    } finally {
      await browser.close();
    }
  },
);
