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
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

/** Where secrets live on this computer, in words: long for sentences, short for labels. */
const VAULTS = {
  macos: ['your Mac’s Keychain', 'Keychain'],
  windows: ['Windows Credential Manager', 'Credential Manager'],
  linux: ['your system keyring', 'keyring'],
};
let vault = VAULTS.macos;

async function refresh() {
  const s = await invoke('get_settings');
  vault = VAULTS[s.os] || VAULTS.macos;
  for (const span of document.querySelectorAll('[data-vault]')) span.textContent = vault[0];
  $('key-status').textContent = s.has_key ? `Key saved in ${vault[1]}` : 'No key yet';
  $('key-status').classList.toggle('ok', s.has_key);
  $('clear-key').hidden = !s.has_key;
  $('node-status').textContent = s.node ? `Node.js: ${s.node}` : 'Node.js: not found. Install it from nodejs.org.';
  if (!s.core_found) $('node-status').textContent += ' · Engine not built: run pnpm build.';
  $('example').hidden = !s.example;
  $('example').dataset.path = s.example || '';
  renderHosts(s.hosts || {});

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

// ---- hosting accounts for the deploy wizard (Keychain) ----
const HOST_NAMES = { vercel: 'Vercel', netlify: 'Netlify', cloudflare: 'Cloudflare' };

function renderHosts(hosts) {
  const list = $('hosts');
  list.replaceChildren();
  for (const [id, name] of Object.entries(HOST_NAMES)) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = name;
    li.append(label);
    if (hosts[id]) {
      const ok = document.createElement('span');
      ok.className = 'ok';
      ok.textContent = '✓ Connected';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        await invoke('clear_host_token', { host: id });
        $('host-msg').textContent = `${name} token removed.`;
        void refresh();
      });
      const right = document.createElement('span');
      right.append(ok, ' ', remove);
      li.append(right);
    } else {
      const off = document.createElement('span');
      off.className = 'muted small';
      off.textContent = 'Not connected';
      li.append(off);
    }
    list.append(li);
  }
}

$('host-which').addEventListener('change', () => {
  $('host-account').hidden = $('host-which').value !== 'cloudflare';
});

$('host-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = $('host-which').value;
  try {
    await invoke('save_host_token', { host, token: $('host-token').value, accountId: $('host-account').value || null });
    $('host-token').value = '';
    $('host-account').value = '';
    $('host-msg').textContent = `${HOST_NAMES[host]} connected. Restart a running project to use it.`;
  } catch (err) {
    $('host-msg').textContent = String(err);
  }
  void refresh();
});

// ---- spending: the engine's ledger, added up with the local calendar ----
const money = (usd) => `$${usd > 0 && usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`;

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function refreshSpending() {
  let data;
  try {
    data = await invoke('get_spending');
  } catch {
    return;
  }
  const cap = Number(data.settings?.dailyCapUsd) > 0 ? Number(data.settings.dailyCapUsd) : 5;
  const today = data.days?.[dayKey()] ?? { usd: 0, tasks: 0 };
  const month = dayKey().slice(0, 7);
  let monthUsd = 0;
  let monthTasks = 0;
  for (const [key, day] of Object.entries(data.days ?? {})) {
    if (!key.startsWith(month)) continue;
    monthUsd += Number(day.usd) || 0;
    monthTasks += Number(day.tasks) || 0;
  }
  $('spend-today').textContent = `Today: ${money(today.usd)} of ${money(cap)} (${today.tasks} task${today.tasks === 1 ? '' : 's'})`;
  $('spend-today').classList.toggle('over', today.usd >= cap);
  $('spend-month').textContent = `This month: ${money(monthUsd)} across ${monthTasks} task${monthTasks === 1 ? '' : 's'}`;
  if (document.activeElement !== $('cap')) $('cap').value = String(cap);
}

$('cap-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const usd = Number($('cap').value);
  try {
    await invoke('set_daily_cap', { usd });
    $('cap-msg').textContent = 'Saved. It applies from the next task.';
  } catch (err) {
    $('cap-msg').textContent = String(err);
  }
  void refreshSpending();
});

// The engine writes the ledger after each task; keep the numbers fresh.
setInterval(() => {
  if (!document.hidden) void refreshSpending();
}, 10000);

function showHome(error) {
  $('home').hidden = false;
  $('running').hidden = true;
  $('home-error').hidden = !error;
  $('home-error').textContent = error || '';
  void refresh();
}

// ---- skills: the engine's `skills` command does the work (README §8) ----
let currentProject = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const badge = (text, kind = '') => el('span', { class: `badge ${kind}` }, text);

async function skillsCli(...args) {
  return JSON.parse(await invoke('run_cli', { args: ['skills', ...args] }));
}

/** A button that asks once more before doing something hard to undo. */
function twoStep(label, sure, action) {
  let armed = false;
  const btn = el('button', { type: 'button', class: 'link' }, label);
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = sure;
      setTimeout(() => {
        armed = false;
        btn.textContent = label;
      }, 4000);
      return;
    }
    void action();
  });
  return btn;
}

async function refreshSkills() {
  if (!currentProject) return;
  let data;
  try {
    data = await skillsCli('list', currentProject);
  } catch (err) {
    $('skills-msg').textContent = String(err);
    return;
  }
  const installed = $('skills-installed');
  installed.replaceChildren();
  for (const s of data.installed) {
    const link = s.url ? el('button', { type: 'button', class: 'link', onclick: () => invoke('open_link', { url: s.url }) }, 'Files') : null;
    installed.append(
      el(
        'li',
        {},
        el('div', { class: 'head' }, el('strong', {}, s.title), s.verified ? badge('Reviewed', 'ok') : badge(s.byHand ? 'Added by hand' : 'Not reviewed'), s.scripts ? badge('Has scripts', 'warn') : null, s.modified ? badge('Changed since added', 'warn') : null, s.update ? badge(`Update: ${s.update.version}`, 'new') : null),
        el('p', { class: 'small muted' }, s.description || ''),
        el('p', { class: 'small' }, `Why: ${s.reason}`, s.version ? ` · Version ${s.version} · ${s.license}` : ''),
        el(
          'div',
          { class: 'row' },
          link,
          s.update ? el('button', { type: 'button', class: 'link', onclick: () => showDiff(s.name) }, 'See the update…') : null,
          twoStep('Remove', 'Remove it? Click again', async () => {
            await skillAction(['remove', currentProject, s.name], `Removed ${s.title}.`);
          }),
        ),
      ),
    );
  }
  if (data.installed.length === 0) installed.append(el('li', { class: 'muted small' }, 'No skills yet. Claude still has Hivebubble’s own house style and checks.'));
  const available = $('skills-available');
  available.replaceChildren();
  for (const a of data.available) {
    available.append(
      el(
        'li',
        {},
        el('div', { class: 'head' }, el('strong', {}, a.title), a.verified ? badge('Reviewed', 'ok') : badge('Not reviewed', 'warn'), a.scripts ? badge('Has scripts', 'warn') : null),
        el('p', { class: 'small muted' }, `${a.description} By ${a.author}, ${a.license}.`),
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', class: 'link', onclick: () => invoke('open_link', { url: a.url }) }, 'Files'),
          el('button', { type: 'button', class: 'secondary small-btn', onclick: () => skillAction(['add', currentProject, a.id], `Added ${a.title}.`) }, 'Add'),
        ),
      ),
    );
  }
  $('skills-available-wrap').hidden = data.available.length === 0;
}

async function skillAction(args, done) {
  $('skills-msg').textContent = 'Working…';
  try {
    await skillsCli(...args);
    $('skills-msg').textContent = done;
  } catch (err) {
    $('skills-msg').textContent = String(err);
  }
  $('skill-diff').hidden = true;
  void refreshSkills();
}

async function showDiff(name) {
  $('skills-msg').textContent = 'Fetching the update…';
  try {
    const { diff } = await skillsCli('diff', currentProject, name);
    if (!diff) {
      $('skills-msg').textContent = 'Already up to date.';
      return;
    }
    const lines = [`${name}: ${diff.from} → ${diff.to} (reviewed ${diff.reviewed})`];
    if (diff.added.length) lines.push(`New files: ${diff.added.join(', ')}`);
    if (diff.removed.length) lines.push(`Removed files: ${diff.removed.join(', ')}`);
    if (diff.changed.length) lines.push(`Changed files: ${diff.changed.join(', ')}`);
    if (diff.scripts) lines.push('This version includes scripts.');
    lines.push('', diff.skillMd || '(SKILL.md is unchanged)');
    $('skill-diff').querySelector('pre').textContent = lines.join('\n');
    $('skill-diff').hidden = false;
    $('diff-apply').onclick = () => skillAction(['update', currentProject, name], `Updated ${name} to ${diff.to}.`);
    $('skills-msg').textContent = '';
  } catch (err) {
    $('skills-msg').textContent = String(err);
  }
}

$('diff-cancel').addEventListener('click', () => {
  $('skill-diff').hidden = true;
});

// ---- start something new: a starter, a new folder, the request in the bubble ----
$('new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const what = $('new-what').value.trim();
  if (!what) {
    $('new-msg').textContent = 'Say what you want to build first, like “a booking app for my salon”.';
    return;
  }
  const parent = await invoke('pick_folder', { title: 'Choose where to create it' });
  if (!parent) return;
  $('new-msg').textContent = 'Creating it…';
  try {
    const created = JSON.parse(await invoke('create_project', { parent, what }));
    $('new-msg').textContent = `Created from the ${created.starter.title} starter.`;
    $('new-what').value = '';
    void start(created.dir, what);
  } catch (err) {
    $('new-msg').textContent = String(err);
  }
});

function showRunning(project) {
  currentProject = project;
  $('home').hidden = true;
  $('running').hidden = false;
  $('skill-diff').hidden = true;
  $('skills-msg').textContent = '';
  void refreshSkills();
  $('db-msg').textContent = '';
  void refreshDb();
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

// ---- Users & Data: the project's database connection, kept in the Keychain ----
/** Resolved when the engine's process ends (see the core-exit listener). */
const exitWaiters = [];

async function refreshDb() {
  if (!currentProject) return;
  const saved = await invoke('has_db_url', { project: currentProject }).catch(() => false);
  $('db-status').textContent = saved
    ? '✓ A connection string is saved for this project.'
    : 'Nothing saved yet. Hivebubble also uses DATABASE_URL from the project’s .env.local.';
  $('db-status').classList.toggle('ok', Boolean(saved));
  $('db-clear').hidden = !saved;
}

/** Restart the engine so it picks up a new connection. Waits for the old one to exit first. */
async function restartProject(note) {
  const project = currentProject;
  stopping = true;
  const exited = new Promise((resolve) => exitWaiters.push(resolve));
  await invoke('stop_project');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
  await start(project);
  $('db-msg').textContent = note;
}

$('db-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await invoke('save_db_url', { project: currentProject, url: $('db-url').value });
    $('db-url').value = '';
    await restartProject('Saved. The project restarted with the database connected: open Users & Data in the bubble.');
  } catch (err) {
    $('db-msg').textContent = String(err);
  }
});

$('db-clear').addEventListener('click', async () => {
  try {
    await invoke('clear_db_url', { project: currentProject });
    await restartProject('Removed. The project restarted without it.');
  } catch (err) {
    $('db-msg').textContent = String(err);
  }
});

async function start(project, prompt) {
  showRunning(project);
  try {
    await invoke('start_project', { project, demo: $('demo').checked || selftest, prompt: prompt || null });
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
  for (const done of exitWaiters.splice(0)) done();
  if (stopping || $('running').hidden) return;
  $('stop').textContent = 'Back';
  if (!$('status').classList.contains('error')) $('status').textContent = 'Hivebubble stopped.';
});

$('choose').addEventListener('click', async () => {
  const folder = await invoke('pick_folder', { title: 'Choose your project folder' });
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
  $('key-msg').textContent = `Key removed from ${vault[1]}.`;
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
  void refreshSpending();
  const settings = await refresh();
  selftest = await invoke('selftest_enabled');
  if (settings.running) showRunning(settings.running);
  if (selftest) await runSelftest(settings);
})();
