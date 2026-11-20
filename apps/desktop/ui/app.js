// Hivebubble window UI. Talks to the Rust side with Tauri's invoke/listen.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const STEPS = ['detecting', 'installing', 'starting', 'ready'];
const MAX_LOG = 500;

let logLines = [];
let liveUrl = null;
let openedOnce = false;
let installed = false;
let stopping = false;
let selftest = false;
let onStatus = null;

function basename(p) {
  return p.split('/').filter(Boolean).pop() || p;
}

async function refresh() {
  const s = await invoke('get_settings');
  $('key-status').textContent = s.has_key ? 'Key saved in Keychain' : 'No key yet';
  $('key-status').classList.toggle('ok', s.has_key);
  $('clear-key').hidden = !s.has_key;
  $('node-status').textContent = s.node ? `Node.js: ${s.node}` : 'Node.js: not found. Install it from nodejs.org.';
  if (!s.core_found) $('node-status').textContent += ' · Engine not built: run pnpm build.';
  $('example').hidden = !s.example;
  $('example').dataset.path = s.example || '';

  const list = $('recent');
  list.replaceChildren();
  for (const path of s.recent) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = basename(path);
    const where = document.createElement('span');
    where.className = 'path';
    where.textContent = path;
    btn.append(name, where);
    btn.addEventListener('click', () => start(path));
    li.append(btn);
    list.append(li);
  }
  $('recent-wrap').hidden = s.recent.length === 0;
  return s;
}

function showHome(error) {
  $('home').hidden = false;
  $('running').hidden = true;
  $('home-error').hidden = !error;
  $('home-error').textContent = error || '';
  void refresh();
}

function showRunning(project) {
  $('home').hidden = true;
  $('running').hidden = false;
  $('project-name').textContent = basename(project);
  $('project-path').textContent = project;
  $('live').hidden = true;
  $('status').textContent = 'Starting…';
  $('status').classList.remove('error');
  $('stop').textContent = 'Stop';
  logLines = [];
  $('log').textContent = '';
  liveUrl = null;
  openedOnce = false;
  installed = false;
  stopping = false;
  setStep('detecting');
}

function setStep(state) {
  if (state === 'installing') installed = true;
  const index = STEPS.indexOf(state);
  if (index === -1) return;
  document.querySelectorAll('.steps li').forEach((li) => {
    const i = STEPS.indexOf(li.dataset.step);
    li.classList.toggle('active', i === index && state !== 'ready');
    li.classList.toggle('done', i < index || (state === 'ready' && i === index));
    li.classList.toggle('skipped', li.dataset.step === 'installing' && index > 1 && !installed);
  });
}

function appendLog(line) {
  logLines.push(line);
  if (logLines.length > MAX_LOG) logLines = logLines.slice(-MAX_LOG);
  const pre = $('log');
  pre.textContent = logLines.join('\n');
  pre.scrollTop = pre.scrollHeight;
}

async function start(project) {
  showRunning(project);
  try {
    await invoke('start_project', { project, demo: $('demo').checked || selftest });
  } catch (err) {
    showHome(String(err));
  }
}

listen('core-event', (event) => {
  let msg;
  try {
    msg = JSON.parse(event.payload);
  } catch {
    appendLog(String(event.payload));
    return;
  }
  if (msg.event === 'log') {
    appendLog(msg.source === 'hivebubble' ? msg.line : `[${msg.source}] ${msg.line}`);
    return;
  }
  if (msg.event !== 'status') return;
  $('status').textContent = msg.message;
  $('status').classList.toggle('error', msg.state === 'error');
  setStep(msg.state);
  if (msg.state === 'ready' && msg.url) {
    liveUrl = msg.url;
    $('url').textContent = msg.url;
    $('live').hidden = false;
    if (!openedOnce && !selftest) {
      openedOnce = true;
      invoke('open_url', { url: msg.url }).catch((err) => appendLog(String(err)));
    }
  }
  if (msg.state === 'error') $('stop').textContent = 'Back';
  onStatus?.(msg);
});

listen('core-exit', () => {
  if (stopping || $('running').hidden) return;
  $('stop').textContent = 'Back';
  if (!$('status').classList.contains('error')) $('status').textContent = 'Hivebubble stopped.';
});

$('choose').addEventListener('click', async () => {
  const folder = await invoke('pick_folder');
  if (folder) start(folder);
});
$('example').addEventListener('click', () => start($('example').dataset.path));
$('stop').addEventListener('click', async () => {
  stopping = true;
  $('status').textContent = 'Stopping…';
  await invoke('stop_project');
  showHome();
});
$('open').addEventListener('click', () => {
  if (liveUrl) invoke('open_url', { url: liveUrl });
});
$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('key').value.trim();
  if (!key) return;
  try {
    await invoke('save_api_key', { key });
    $('key').value = '';
    $('key-msg').textContent = 'Saved. Restart a running project to use the new key.';
  } catch (err) {
    $('key-msg').textContent = String(err);
  }
  void refresh();
});
$('clear-key').addEventListener('click', async () => {
  await invoke('clear_api_key');
  $('key-msg').textContent = 'Key removed from Keychain.';
  void refresh();
});

// Development self-test: HIVEBUBBLE_SELFTEST=1 starts the example in demo mode
// and reports whether it went live.
async function runSelftest(settings) {
  const steps = [];
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, why: 'timed out' }), 120000);
    onStatus = (msg) => {
      steps.push(msg.state);
      if (msg.state === 'ready') {
        clearTimeout(timer);
        resolve({ ok: true, url: msg.url });
      } else if (msg.state === 'error') {
        clearTimeout(timer);
        resolve({ ok: false, why: msg.message });
      }
    };
    start(settings.example);
  });
  const uiShowsLive = !$('live').hidden && $('url').textContent === result.url;
  const report = { ...result, steps, uiShowsLive, node: settings.node, coreFound: settings.core_found };
  await invoke('selftest_done', { ok: result.ok && uiShowsLive, report: JSON.stringify(report) });
}

(async () => {
  const settings = await refresh();
  selftest = await invoke('selftest_enabled');
  if (settings.running) showRunning(settings.running);
  if (selftest) await runSelftest(settings);
})();
