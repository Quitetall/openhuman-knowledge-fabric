/**
 * The in-app agent, walked through a real browser against a real stack (ADR 0040 decisions 7 to
 * 10; KF-SAS-RQ-266, RQ-271, RQ-272, RQ-273): Keycloak's login form, the token exchange for the
 * in-app agent's client, the API's context source over the Véracier sample, and the page at phone
 * width.
 *
 * Opt-in only (`KF_AGENT_LIVE=1`). It needs a fixture stack whose web application was started with
 *
 *   KF_AGENT_LAMU_URL=http://127.0.0.1:$KF_AGENT_LIVE_LAMU_PORT
 *   KF_AGENT_PROVIDER=anthropic
 *   KF_AGENT_PROVIDER_KEY_FILE=<an owner-only file; its value is never used>
 *   KF_AGENT_PROVIDER_BASE_URL=http://127.0.0.1:$KF_AGENT_LIVE_PROVIDER_PORT
 *   KF_WEB_AGENT_CLIENT_ID=knowledge-fabric-web-agent, KF_WEB_AGENT_CLIENT_SECRET_FILE=…
 *
 * and this test serves both models itself: an OpenAI-compatible stand-in for LAMU, and a RECORDER
 * that answers the Claude Messages API and keeps every request — so "no confidential record reached
 * the provider" is read from what the provider received, through the real SDK, not from what the
 * router said. Passwords are read from the personas file and typed into Keycloak's form only.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const LIVE = process.env.KF_AGENT_LIVE === '1';
const WEB = (process.env.KF_AGENT_LIVE_WEB ?? 'http://localhost:3400').replace(/\/$/, '');
const LAMU_PORT = Number(process.env.KF_AGENT_LIVE_LAMU_PORT ?? '8031');
const PROVIDER_PORT = Number(process.env.KF_AGENT_LIVE_PROVIDER_PORT ?? '8032');
const PERSONAS =
  process.env.KF_VERACIER_PERSONAS ?? join(homedir(), '.config/kf/veracier-personas.txt');
const QUESTIONS = (process.env.KF_AGENT_LIVE_QUESTIONS ?? 'qualite|fournisseur|maintenance|audit')
  .split('|')
  .filter((q) => q !== '');
const STEP_TIMEOUT = 60_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

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

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Both models. LAMU answers citing [1]; the provider records, then answers citing [1]. */
function startModels(received) {
  const reply = (response, status, value) => {
    const data = JSON.stringify(value);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(data);
  };
  const draftFor = (question) => {
    const id = UUID.exec(question)?.[0];
    return /promote/iu.test(question) && id !== undefined
      ? {
          act: 'promote_observation',
          targetIds: [id],
          fields: {},
          reason: 'confirmed by a second bench run',
        }
      : {
          act: 'record_observation',
          targetIds: [],
          fields: { body: question.replace(/^record that\s*/iu, '') },
          reason: null,
        };
  };
  const lamu = createServer(async (request, response) => {
    const value = await body(request);
    received.lamu.push(value);
    const system = value.messages[0]?.content ?? '';
    const question = value.messages.at(-1)?.content.split('Question: ').at(-1) ?? '';
    reply(response, 200, {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: system.includes('You fill in one form')
              ? JSON.stringify(draftFor(question))
              : 'Answered on the host from the first source [1].',
          },
          finish_reason: 'stop',
        },
      ],
    });
  });
  const provider = createServer(async (request, response) => {
    const value = await body(request);
    received.provider.push(JSON.stringify(value));
    reply(response, 200, {
      id: `msg_${received.provider.length}`,
      type: 'message',
      role: 'assistant',
      model: value.model,
      content: [{ type: 'text', text: 'Answered by the provider from the first source [1].' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  return Promise.all([
    new Promise((resolve) => lamu.listen(LAMU_PORT, '127.0.0.1', resolve)),
    new Promise((resolve) => provider.listen(PROVIDER_PORT, '127.0.0.1', resolve)),
  ]).then(() => ({ lamu, provider }));
}

async function signIn(browser, username, secret) {
  // A phone: every step below runs at this width (KF-SAS-RQ-273).
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.setDefaultTimeout(STEP_TIMEOUT);
  context.setDefaultNavigationTimeout(STEP_TIMEOUT);
  const page = await context.newPage();
  await page.goto(`${WEB}/agent`);
  if (!page.url().startsWith(WEB)) {
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(secret);
    await page.locator('#kc-login').click();
  }
  await page.waitForURL((url) => url.href.startsWith(WEB) && !url.pathname.startsWith('/auth/'));
  if (new URL(page.url()).pathname === '/session/select') {
    const picker = page.locator('form[action="/auth/context"]:has(input[type="radio"])');
    await picker.waitFor();
    const radios = picker.locator('input[type="radio"][name="actingRoleId"]');
    const checked = picker.locator('input[type="radio"][name="actingRoleId"]:checked');
    if ((await checked.count()) === 0) await radios.first().check();
    await picker.getByRole('button', { name: 'Validate with KF API', exact: true }).click();
    await page.waitForURL(`${WEB}/agent**`);
  }
  return { context, page };
}

const noOverflow = (page) =>
  page.evaluate(
    () => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth,
  );

/** Ask, and read the newest answer as the page shows it. */
async function ask(page, question) {
  const answers = page.locator('article.kf-agent-answer');
  const before = await answers.count();
  await page.getByLabel(/Ask, or say/).fill(question);
  await page.getByRole('button', { name: 'Ask' }).click();
  await answers.nth(before).waitFor();
  const answer = answers.nth(before);
  const backend = await answer.locator('[data-backend]').getAttribute('data-backend');
  const backendText = await answer.locator('[data-backend]').innerText();
  const withheld = await answer.locator('[data-testid="withheld"]').innerText();
  // Every record read for this answer, with its classification, from the sources and the list.
  const records = await answer.locator('a[href^="/objects/"]').evaluateAll((links) =>
    links.map((link) => ({
      href: link.getAttribute('href'),
      title: link.textContent.replace(/^\[\d+\]\s*/u, ''),
      classification: link.nextElementSibling?.getAttribute('data-classification') ?? null,
    })),
  );
  return { backend, backendText, withheld, records };
}

test(
  'the in-app agent at phone width: routed by classification, cited, counted, drafting for one click',
  {
    skip: LIVE ? false : 'live stack walk; set KF_AGENT_LIVE=1 with a stack configured as above',
    timeout: 600_000,
  },
  async () => {
    const all = passwords();
    const received = { lamu: [], provider: [] };
    const models = await startModels(received);
    const playwright = await import(process.env.KF_PLAYWRIGHT_CORE_PATH ?? 'playwright-core');
    const launchOptions = { headless: true };
    if (process.env.KF_BROWSER_EXECUTABLE) {
      launchOptions.executablePath = process.env.KF_BROWSER_EXECUTABLE;
    }
    const browser = await playwright.chromium.launch(launchOptions);
    const report = [];
    try {
      for (const username of ['helene.daubrac', 'youssef.amrani']) {
        const { context, page } = await signIn(browser, username, all.get(username));
        assert.equal(await noOverflow(page), true, `${username}: /agent fits a phone`);
        for (const question of QUESTIONS) {
          const providerBefore = received.provider.length;
          const answer = await ask(page, question);
          const controlled = answer.records.filter((r) =>
            ['confidential', 'restricted'].includes(r.classification),
          );
          report.push({
            username,
            question,
            backend: answer.backend,
            records: answer.records.length,
            controlled: controlled.length,
          });
          assert.match(answer.backendText, /Answered by:/);
          assert.match(
            answer.withheld,
            /^Withheld: \d+ matching records? your grants do not reach/,
          );
          const sent = received.provider.slice(providerBefore).join('\n');
          if (controlled.length > 0) {
            assert.notEqual(
              answer.backend,
              'provider',
              `${question}: a controlled record went out`,
            );
            for (const record of controlled) {
              assert.equal(
                sent.includes(record.title),
                false,
                `${record.href} (${record.classification}) reached the provider`,
              );
            }
          }
          assert.equal(await noOverflow(page), true, `${question}: the answer fits a phone`);
          // The count the answer shows is the one the search page shows for the same query.
          const shown = Number(/Withheld: (\d+)/u.exec(answer.withheld)?.[1]);
          const search = await page.context().newPage();
          await search.goto(`${WEB}/search?q=${encodeURIComponent(question)}`);
          await search.locator('section[data-list="lexical"]').waitFor({ state: 'attached' });
          const note = search.locator('[data-withheld-count]');
          const searched =
            (await note.count()) === 0
              ? 0
              : Number(await note.first().getAttribute('data-withheld-count'));
          await search.close();
          assert.equal(shown, searched, `${username} ${question}: withheld differs from search`);
          report.at(-1).withheld = shown;
        }

        if (username === 'youssef.amrani') {
          // Draft, then one click: the person's act with the agent's participation, unverified.
          await page.getByLabel(/Ask, or say/).fill('Record that bench 4 rail sagged to 3.29 V');
          await page.getByRole('button', { name: 'Ask' }).click();
          const draft = page.getByRole('form', { name: 'Draft: Record an observation' });
          await draft.waitFor();
          assert.equal(
            await draft.getByLabel(/What was observed/).inputValue(),
            'bench 4 rail sagged to 3.29 V',
          );
          await draft.getByRole('button', { name: 'Commit this record' }).click();
          await page.getByText(/Recorded as your act/).waitFor();
          const href = await page
            .getByRole('link', { name: 'Open the record' })
            .getAttribute('href');
          const observationId = decodeURIComponent(href.split('/').at(-1));

          // An institutional act from chat becomes a proposal in Needs you, performed by nobody.
          await page
            .getByLabel(/Ask, or say/)
            .fill(`Promote observation ${observationId}, the second run confirmed it`);
          await page.getByRole('button', { name: 'Ask' }).click();
          const proposal = page.getByRole('form', { name: /Draft: Promote an observation/ });
          await proposal.waitFor();
          await proposal.getByRole('button', { name: 'Propose — it waits in Needs you' }).click();
          await page.getByText(/proposed, not performed/).waitFor();

          await page.goto(`${WEB}/needs-you`);
          await page
            .getByText(/promote_observation/)
            .first()
            .waitFor();
          assert.equal(await noOverflow(page), true, 'Needs you fits a phone');
        }
        await context.close();
      }
      // What the run did, for the evidence (no titles, no content).
      process.stdout.write(
        `${JSON.stringify({ report, lamu: received.lamu.length, provider: received.provider.length })}\n`,
      );
      assert.ok(received.lamu.length > 0, 'the host’s model answered at least once');
    } finally {
      await browser.close();
      models.lamu.close();
      models.provider.close();
    }
  },
);
