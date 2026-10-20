// The launcher's pages: first-run setup, "Starting Knowledge Fabric…", and AI answers (who writes
// the answers to "Ask"; the setup page asks the same question). Plain words only; a failure shows
// what went wrong and what to do, never a stack trace. Every value the server sends is put on the
// page with textContent, never as HTML. A cloud model's API key is typed into a password field,
// sent once, and cleared; no page ever shows it, only whether one is saved.

const STYLE = `
:root { --bg: #f6f5f1; --card: #ffffff; --ink: #1d2321; --muted: #5b6662; --accent: #0f6b5c;
  --bad: #a3312a; --line: #d9dcd6; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #151917; --card: #1e2421; --ink: #e8ece9;
  --muted: #a3ada8; --accent: #49b39e; --bad: #f08a80; --line: #33403b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; margin: 6vh auto; padding: 0 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
p.lead { color: var(--muted); margin: 0 0 20px; }
label { display: block; font-weight: 600; margin: 14px 0 4px; }
label small { font-weight: 400; color: var(--muted); }
input { width: 100%; padding: 10px 12px; font: inherit; color: inherit; background: transparent;
  border: 1px solid var(--line); border-radius: 8px; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { margin-top: 22px; width: 100%; padding: 12px; font: inherit; font-weight: 600;
  color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
button:disabled { opacity: .6; cursor: default; }
.problems { color: var(--bad); margin: 16px 0 0; padding-left: 20px; }
ol.steps { list-style: none; padding: 0; margin: 20px 0 0; }
ol.steps li { padding: 6px 0 6px 28px; position: relative; color: var(--muted); }
ol.steps li.done { color: var(--ink); }
ol.steps li.done::before { content: "✓"; position: absolute; left: 4px; color: var(--accent); }
ol.steps li.now { color: var(--ink); font-weight: 600; }
ol.steps li.now::before { content: ""; position: absolute; left: 2px; top: 11px; width: 12px;
  height: 12px; border: 2px solid var(--accent); border-right-color: transparent; border-radius: 50%;
  animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.failure { border-left: 4px solid var(--bad); padding: 8px 14px; margin-top: 20px; }
.failure strong { display: block; }
[hidden] { display: none !important; }
fieldset { border: 1px solid var(--line); border-radius: 10px; padding: 6px 16px 16px; margin: 22px 0 0; }
legend { font-weight: 600; padding: 0 6px; }
label.choice { display: flex; gap: 10px; align-items: flex-start; font-weight: 400; margin: 10px 0 0; }
label.choice input { width: auto; margin-top: 5px; }
select { width: 100%; padding: 10px 12px; font: inherit; color: inherit; background: var(--card);
  border: 1px solid var(--line); border-radius: 8px; }
.note { color: var(--muted); font-size: .92rem; margin: 8px 0 0; }
.saved { color: var(--accent); margin: 16px 0 0; }
`;

// Who writes answers: the same fields on the setup page and the AI answers page.
const ANSWERS_FIELDS = `
<fieldset id="answers-set">
  <legend>Who writes answers to your questions</legend>
  <p class="note">Every answer lists the records it used. Records marked confidential or
  restricted are never sent to a cloud model, whatever you choose here.</p>
  <label class="choice"><input type="radio" name="answers" value="off" checked>
    <span>Off <small>— search only</small></span></label>
  <label class="choice"><input type="radio" name="answers" value="on_host">
    <span>On this computer <small>(private — nothing leaves this machine)</small></span></label>
  <label class="choice"><input type="radio" name="answers" value="cloud">
    <span>Cloud model <small>(needs an API key; only for records cleared to leave the company)</small></span></label>
  <label class="choice"><input type="radio" name="answers" value="both">
    <span>Both <small>— on this computer for sensitive records, the cloud model for the rest</small></span></label>
  <div id="local-box" hidden>
    <p class="note" id="local-status" aria-live="polite">Looking for a model on this computer…</p>
    <label for="localModel">Model on this computer</label>
    <select id="localModel" name="localModel"></select>
  </div>
  <div id="cloud-box" hidden>
    <label for="cloudProvider">Cloud provider</label>
    <select id="cloudProvider" name="cloudProvider">
      <option value="anthropic">Anthropic (Claude)</option>
      <option value="openai">OpenAI</option>
      <option value="gemini">Google Gemini</option>
      <option value="mistral">Mistral</option>
      <option value="openrouter">OpenRouter</option>
      <option value="other">Another provider (OpenAI-compatible)</option>
    </select>
    <div id="other-box" hidden>
      <label for="cloudName">Provider’s name</label>
      <input id="cloudName" name="cloudName" maxlength="60" placeholder="Acme AI">
      <label for="cloudBaseUrl">Provider’s address <small>— starts with https://</small></label>
      <input id="cloudBaseUrl" name="cloudBaseUrl" placeholder="https://api.example.com/v1">
    </div>
    <label for="cloudModel">Model <small id="model-hint"></small></label>
    <input id="cloudModel" name="cloudModel" maxlength="200" autocapitalize="none" autocomplete="off">
    <label for="cloudKey">API key <small id="key-hint">— kept only on this computer, readable only by you</small></label>
    <input id="cloudKey" name="cloudKey" type="password" autocomplete="off" maxlength="512">
  </div>
</fieldset>
`;

const ANSWERS_SCRIPT = `
const MODEL_HINTS = {
  anthropic: '— claude-opus-5-5 or claude-sonnet-5', openai: '— for example gpt-5',
  gemini: '— for example gemini-2.5-pro', mistral: '— for example mistral-large-latest',
  openrouter: '— for example openai/gpt-5', other: '— as the provider spells it',
};
function el(id) { return document.getElementById(id); }
function answersChoice() {
  const picked = document.querySelector('input[name="answers"]:checked');
  return picked ? picked.value : 'off';
}
function showAnswers() {
  const choice = answersChoice();
  el('local-box').hidden = !(choice === 'on_host' || choice === 'both');
  el('cloud-box').hidden = !(choice === 'cloud' || choice === 'both');
  const provider = el('cloudProvider').value;
  el('other-box').hidden = provider !== 'other';
  el('model-hint').textContent = MODEL_HINTS[provider] || '';
}
async function loadAnswers(prefill) {
  for (const input of document.querySelectorAll('input[name="answers"]')) {
    input.addEventListener('change', showAnswers);
  }
  el('cloudProvider').addEventListener('change', showAnswers);
  let state = null;
  try { state = await (await fetch('./ai/state', { cache: 'no-store' })).json(); } catch {}
  const local = state && state.onHost;
  const select = el('localModel');
  if (local && local.url) {
    select.replaceChildren(...local.models.map((name) => {
      const option = document.createElement('option');
      option.value = name; option.textContent = name; return option;
    }));
    el('local-status').textContent = 'Found a model server on this computer (' + local.url + ').';
    select.disabled = false;
  } else {
    el('local-status').textContent = ((local && local.reason) || 'No model is running on this computer') +
      '. To use this option, start one (for example Ollama or LM Studio, with a model downloaded), then reload this page.';
    select.replaceChildren();
    select.disabled = true;
  }
  if (prefill && state && state.saved) {
    const saved = state.saved;
    const radio = document.querySelector('input[name="answers"][value="' + saved.choice + '"]');
    if (radio) radio.checked = true;
    if (saved.localModel) select.value = saved.localModel;
    if (saved.cloud) {
      el('cloudProvider').value = saved.cloud.provider;
      el('cloudModel').value = saved.cloud.model || '';
      if (saved.cloud.provider === 'other') {
        el('cloudName').value = saved.cloud.name || '';
        el('cloudBaseUrl').value = saved.cloud.baseUrl || '';
      }
    }
    el('key-hint').textContent = saved.keyOnFile
      ? '— a key is saved; leave this empty to keep it'
      : '— kept only on this computer, readable only by you';
  }
  showAnswers();
  return state;
}
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const mode = document.body.dataset.mode;
let home = null;

function show(view) {
  $('setup').hidden = view !== 'setup';
  $('progress').hidden = view !== 'progress';
}

function list(target, items, cls) {
  target.replaceChildren(...items.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    return li;
  }));
}

async function poll() {
  let p;
  try {
    p = await (await fetch('./progress', { cache: 'no-store' })).json();
  } catch {
    setTimeout(poll, 2000);
    return;
  }
  home = p.home;
  const steps = p.steps.map((s) => s.label);
  const items = steps.map((label, i) => {
    const li = document.createElement('li');
    li.textContent = label;
    li.className = i < steps.length - 1 || p.state === 'ready' ? 'done' : (p.state === 'failed' ? '' : 'now');
    return li;
  });
  $('steps').replaceChildren(...items);
  if (p.state === 'ready') {
    $('title').textContent = 'Knowledge Fabric is ready';
    $('lead').textContent = 'Opening it now. Sign in with the username and password you chose.';
    let wait = 1500;
    if (p.imported) {
      const refused = p.imported.refused.length;
      $('summary').textContent = p.imported.ingested + p.imported.replayed + ' files added' +
        (refused ? '; ' + refused + ' could not be added (passwords, bank or tax numbers, hidden or ' +
        'empty files are never taken in).' : '.');
      if (refused) wait = 8000;
    }
    $('open').hidden = false;
    setTimeout(() => { location.href = home; }, wait);
    return;
  }
  if (p.state === 'failed') {
    $('title').textContent = 'Knowledge Fabric did not start';
    $('lead').textContent = '';
    $('failure').hidden = false;
    $('what').textContent = p.error.message;
    $('advice').textContent = p.error.advice;
    return;
  }
  setTimeout(poll, 1000);
}

$('again').addEventListener('click', async () => {
  if (mode === 'setup') { location.reload(); return; }
  $('failure').hidden = true;
  await fetch('./retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  $('title').textContent = 'Starting Knowledge Fabric…';
  poll();
});
$('open').addEventListener('click', () => { if (home) location.href = home; });

const form = $('form');
if (form) form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  $('go').disabled = true;
  list($('problems'), []);
  let response;
  try {
    response = await fetch('./setup', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  } catch {
    list($('problems'), ['Knowledge Fabric is not answering. Click its icon again.']);
    $('go').disabled = false;
    return;
  }
  form.reset();
  showAnswers();
  if (response.status === 202) { show('progress'); poll(); return; }
  const body = await response.json().catch(() => ({ problems: ['Please try again.'] }));
  list($('problems'), body.problems ?? ['Please try again.']);
  $('go').disabled = false;
});

if (form) loadAnswers(false);
if (document.body.dataset.view === 'progress') { show('progress'); poll(); }
`;

const AI_SCRIPT = `
const form = el('form');
loadAnswers(true);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  el('go').disabled = true;
  el('saved').textContent = '';
  el('problems').replaceChildren();
  let response;
  try {
    response = await fetch('./ai', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  } catch {
    el('problems').textContent = 'Knowledge Fabric is not answering. Click its icon again.';
    el('go').disabled = false;
    return;
  }
  el('cloudKey').value = '';
  const body = await response.json().catch(() => ({ problems: ['Please try again.'] }));
  if (response.ok) {
    el('saved').textContent = body.restarted
      ? 'Saved. Knowledge Fabric restarted its web page with it; reload Knowledge Fabric to use it.'
      : 'Saved. It is used the next time Knowledge Fabric starts.';
    await loadAnswers(true);
  } else {
    el('problems').replaceChildren(...(body.problems || ['Please try again.']).map((text) => {
      const li = document.createElement('li'); li.textContent = text; return li;
    }));
  }
  el('go').disabled = false;
});
`;

function page(view, mode) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Knowledge Fabric</title>
<style>${STYLE}</style>
</head>
<body data-view="${view}" data-mode="${mode}">
<main>
<section class="card" id="setup"${view === 'setup' ? '' : ' hidden'}>
  <h1>Set up Knowledge Fabric</h1>
  <p class="lead">Your organization's own place for its documents and records, on this computer.
  This takes a few minutes the first time.</p>
  <form id="form" autocomplete="off">
    <label for="organization">Organization name</label>
    <input id="organization" name="organization" required maxlength="200" placeholder="Acme Engineering">
    <label for="name">Your full name</label>
    <input id="name" name="name" required maxlength="120" autocomplete="name">
    <label for="username">Username <small>— what you will sign in with (lowercase letters, numbers, dots)</small></label>
    <input id="username" name="username" required maxlength="63" autocapitalize="none" autocomplete="username">
    <label for="password">Password <small>— at least 14 characters</small></label>
    <input id="password" name="password" type="password" required minlength="14" maxlength="128" autocomplete="new-password">
    <label for="confirm">Password again</label>
    <input id="confirm" name="confirm" type="password" required minlength="14" maxlength="128" autocomplete="new-password">
    <label for="folder">Add a folder of files now <small>— optional; the folder's full path</small></label>
    <input id="folder" name="folder" placeholder="/home/you/Documents/Engineering">
    ${ANSWERS_FIELDS}
    <ul class="problems" id="problems" aria-live="polite"></ul>
    <button id="go" type="submit">Set up Knowledge Fabric</button>
  </form>
</section>
<section class="card" id="progress"${view === 'progress' ? '' : ' hidden'}>
  <h1 id="title">Starting Knowledge Fabric…</h1>
  <p class="lead" id="lead">This page opens Knowledge Fabric by itself when it is ready.</p>
  <ol class="steps" id="steps" aria-live="polite"></ol>
  <p id="summary"></p>
  <div class="failure" id="failure" hidden>
    <strong id="what"></strong>
    <span id="advice"></span>
    <button id="again" type="button">Try again</button>
  </div>
  <button id="open" type="button" hidden>Open Knowledge Fabric</button>
</section>
</main>
<script>${ANSWERS_SCRIPT}${SCRIPT}</script>
</body>
</html>
`;
}

/** AI answers, on its own: change who writes answers after setup (launcher.mjs `ai`). */
export function aiPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI answers — Knowledge Fabric</title>
<style>${STYLE}</style>
</head>
<body data-view="ai">
<main>
<section class="card">
  <h1>AI answers</h1>
  <p class="lead">Choose who writes the answers when someone asks Knowledge Fabric a question.
  Saving restarts only Knowledge Fabric's web page; nothing else stops.</p>
  <form id="form" autocomplete="off">
    ${ANSWERS_FIELDS}
    <ul class="problems" id="problems" aria-live="polite"></ul>
    <p class="saved" id="saved" role="status"></p>
    <button id="go" type="submit">Save</button>
  </form>
  <p class="note">What your organization lets leave this computer is its own decision: Knowledge
  Fabric shows it under More → AI answers, with a button to change it.</p>
</section>
</main>
<script>${ANSWERS_SCRIPT}${AI_SCRIPT}</script>
</body>
</html>
`;
}

export function setupPage() {
  return page('setup', 'setup');
}

export function progressPage({ mode = 'start' } = {}) {
  return page('progress', mode);
}
