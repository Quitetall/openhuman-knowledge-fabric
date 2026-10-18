// The launcher's two pages: first-run setup, and "Starting Knowledge Fabric…". Plain words only;
// a failure shows what went wrong and what to do, never a stack trace. Every value the server
// sends is put on the page with textContent, never as HTML.

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
  if (response.status === 202) { show('progress'); poll(); return; }
  const body = await response.json().catch(() => ({ problems: ['Please try again.'] }));
  list($('problems'), body.problems ?? ['Please try again.']);
  $('go').disabled = false;
});

if (document.body.dataset.view === 'progress') { show('progress'); poll(); }
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
<script>${SCRIPT}</script>
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
