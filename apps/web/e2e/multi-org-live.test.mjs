/**
 * The multi-organization fixture (fixtures/multi), walked through a real browser: for one
 * person of every organization, Keycloak's own login form, the context chosen the way the web
 * application offers it, and then the tenant boundary as the page shows it.
 *
 *   - the person finds their own organization's words (the probe can fail)
 *   - every other organization's words find nothing, and the page states no withheld count
 *   - another organization's object id opens exactly as an id that exists nowhere: "Not
 *     available", with nothing of the record on the page
 *
 * The web application's picker lists assignments in the ONE organization it is configured for
 * (KF_WEB_ORGANIZATION; the multi stack names Redwood Inference). A person of any other
 * organization chooses their context with the typed form beneath it, which the API validates the
 * same way.
 *
 * Opt-in only (`KF_MULTI_LIVE=1`): it needs the multi stack running with every corpus's --sample
 * loaded and the persona passwords on this machine. Passwords are typed into Keycloak's form and
 * never logged or put in an assertion message.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const LIVE = process.env.KF_MULTI_LIVE === '1';
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');
const STEP_TIMEOUT = 45_000;

async function signIn(browser, web, person, context) {
  const ctx = await browser.newContext();
  ctx.setDefaultTimeout(STEP_TIMEOUT);
  ctx.setDefaultNavigationTimeout(STEP_TIMEOUT);
  const p = await ctx.newPage();
  await p.goto(`${web}/search`);
  if (!p.url().startsWith(web)) {
    await p.locator('#username').fill(person.username);
    await p.locator('#password').fill(person.password);
    await p.locator('#kc-login').click();
  }
  await p.waitForURL((url) => url.href.startsWith(web) && !url.pathname.startsWith('/auth/'));
  if (new URL(p.url()).pathname === '/session/select') {
    const picker = p.locator('form[action="/auth/context"]:has(input[type="radio"])');
    const typed = p.locator(
      'form[action="/auth/context"]:has(input[name="organizationId"]:not([type="hidden"]))',
    );
    await typed.waitFor({ state: 'attached' });
    const radio = picker.locator(`input[type="radio"][value="${context.assignmentId}"]`);
    if ((await picker.count()) > 0 && (await radio.count()) > 0) {
      await radio.check();
      await picker.getByRole('button', { name: 'Validate with KF API', exact: true }).click();
    } else {
      // The typed form sits in "Enter ids manually", closed when a picker is offered.
      const manual = p.locator('details:has(form[action="/auth/context"])');
      if ((await manual.getAttribute('open')) === null) await manual.locator('summary').click();
      await typed.locator('input[name="actingRoleId"]').fill(context.assignmentId);
      await typed.locator('input[name="organizationId"]').fill(context.organizationId);
      await typed.locator('select[name="maxClassification"]').selectOption(person.clearance);
      await typed.getByRole('button', { name: 'Validate typed ids with KF API' }).click();
    }
    await p.waitForURL(`${web}/search**`);
  }
  return { ctx, page: p };
}

async function searchCounts(page, web, query) {
  await page.goto(`${web}/search?q=${encodeURIComponent(query)}`);
  const lexical = page.locator('section[data-list="lexical"]');
  await lexical.waitFor();
  const total = Number(await lexical.getAttribute('data-total'));
  assert.ok(Number.isSafeInteger(total), 'the lexical list states its total');
  const withheld = page.locator('[data-withheld-count]');
  return {
    total,
    withheld:
      (await withheld.count()) === 0
        ? 0
        : Number(await withheld.first().getAttribute('data-withheld-count')),
  };
}

/** What the object page shows, without the id itself (which the page may echo). */
async function objectPage(page, web, id) {
  await page.goto(`${web}/objects/${encodeURIComponent(id)}`);
  const heading = page.locator('main h1').first();
  await heading.waitFor();
  const text = (await page.locator('main').innerText()).replaceAll(id, '<id>');
  return { heading: await heading.innerText(), text };
}

test(
  'multi-organization: each person finds their own, and nothing of any other organization',
  {
    skip: LIVE
      ? false
      : 'live stack walk; set KF_MULTI_LIVE=1 with the multi stack (fixtures/multi) running and the samples loaded',
    timeout: 900_000,
  },
  async () => {
    const { stackSettings } = await import(path.join(FIXTURES, 'lib', 'stack.mjs'));
    const { readPasswords } = await import(path.join(FIXTURES, 'lib', 'loader.mjs'));
    const { personasFile } = await import(path.join(FIXTURES, 'lib', 'stack.mjs'));
    const { organizations, probeTable } = await import(
      path.join(FIXTURES, 'multi', 'organizations.mjs')
    );
    const settings = stackSettings();
    const web = (process.env.KF_MULTI_WEB ?? settings.web).replace(/\/$/, '');
    const orgs = await organizations(settings);
    const probes = await probeTable(orgs, { settings });
    assert.ok(orgs.length >= 5, `the multi stack holds every sample (found ${orgs.length})`);
    const walk = [];
    for (const org of orgs) {
      const ids = JSON.parse(
        await readFile(path.join(settings.state, `${org.id}-ids.json`), 'utf8'),
      );
      const passwords = await readPasswords(personasFile(org.personasCorpus));
      const person = org.people.find((p) => p.key === org.strong);
      const password = passwords.get(person.username);
      assert.ok(password !== undefined, `a password for ${org.id}'s persona`);
      const artifact = Object.values(ids.documents).find((d) => d.artifactId)?.artifactId;
      walk.push({
        org,
        ids,
        person: { ...person, password },
        artifact,
        probes: probes.get(org.id),
      });
    }

    const playwright = await import(process.env.KF_PLAYWRIGHT_CORE_PATH ?? 'playwright-core');
    const launchOptions = { headless: true };
    if (process.env.KF_BROWSER_EXECUTABLE)
      launchOptions.executablePath = process.env.KF_BROWSER_EXECUTABLE;
    const browser = await playwright.chromium.launch(launchOptions);
    try {
      for (const [index, a] of walk.entries()) {
        const b = walk[(index + 1) % walk.length];
        const { ctx, page } = await signIn(browser, web, a.person, {
          organizationId: a.ids.organizationId,
          assignmentId: a.ids.people[a.person.key].assignmentId,
        });
        const own = await searchCounts(page, web, a.probes[0]);
        assert.ok(own.total > 0, `${a.org.id} finds its own "${a.probes[0]}" on the page`);
        for (const other of walk) {
          if (other === a) continue;
          const counts = await searchCounts(page, web, other.probes.join(' or '));
          assert.deepEqual(
            counts,
            { total: 0, withheld: 0 },
            `${a.org.id} sees nothing of ${other.org.id}, and is told of nothing withheld`,
          );
        }
        const foreign = await objectPage(page, web, b.artifact);
        const nowhere = await objectPage(page, web, '01a0d6d3-0000-7000-8000-00000000abcd');
        assert.equal(
          foreign.heading,
          'Not available',
          `${a.org.id} opening ${b.org.id}'s artifact`,
        );
        assert.deepEqual(
          foreign,
          nowhere,
          `${b.org.id}'s artifact reads as an id that exists nowhere`,
        );
        for (const d of b.org.documents.slice(0, 20)) {
          if (d.title !== '') assert.ok(!foreign.text.includes(d.title), `no ${b.org.id} title`);
        }
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  },
);
