// Hivebubble extension, popup: is Hivebubble running, and does this localhost page
// have the bubble? Turning it on for a site is remembered for that site.

const main = document.getElementById('main');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

const box = (...children) => el('div', { class: 'box' }, ...children);

async function currentTab() {
  // ?url= shows the popup for a given address (used when checking the popup in a test browser).
  const forced = new URLSearchParams(location.search).get('url');
  if (forced) return { id: undefined, url: forced };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? { id: undefined, url: '' };
}

async function toggle(tab, origin, engine, on) {
  await chrome.runtime.sendMessage({ type: 'toggle', origin, project: engine?.project, base: engine?.base, on });
  if (tab.id !== undefined) await chrome.tabs.reload(tab.id);
  await render();
}

async function render() {
  const tab = await currentTab();
  const s = await chrome.runtime.sendMessage({ type: 'status', url: tab.url ?? '' });
  main.replaceChildren();
  if (!s || !s.engines || s.engines.length === 0) {
    main.append(
      el('p', {}, 'Hivebubble isn’t running.'),
      el('p', { class: 'muted' }, 'Open a project in the Hivebubble app, or run ', el('code', {}, 'pnpm start path/to/project'), '. Already running your own dev server? Add ', el('code', {}, '--attach http://localhost:3000'), '.'),
    );
    return;
  }
  // Two engines can run the same project (one attached): tell them apart by port.
  const names = s.engines.map((e) => e.project);
  const label = (e) => (names.filter((n) => n === e.project).length > 1 ? `${e.project} (port ${new URL(e.base).port})` : e.project);
  main.append(el('p', { class: 'muted' }, `Running: ${s.engines.map(label).join(', ')}`));
  if (!s.local) {
    main.append(el('p', {}, 'Open your site on localhost, and the bubble can join it there.'));
    return;
  }
  const where = new URL(tab.url).host;
  if (s.preview) {
    main.append(box(el('strong', {}, 'This is Hivebubble’s own preview.'), el('span', { class: 'muted' }, 'The bubble is already here.')));
    return;
  }
  if (s.auto) {
    main.append(box(el('strong', { class: 'ok' }, `✓ The bubble is on ${where}`), el('span', { class: 'muted' }, `This is ${s.engine.project}’s dev server.`)));
    return;
  }
  if (s.enabled) {
    main.append(
      box(el('strong', { class: 'ok' }, `✓ On for ${where}`), el('span', { class: 'muted' }, s.engine ? `Changes go to ${s.engine.project}.` : `For ${s.project}, which isn’t running now.`)),
      el('button', { class: 'link', type: 'button', onclick: () => toggle(tab, s.origin, null, false) }, 'Turn it off for this site'),
    );
    return;
  }
  const several = s.engines.length > 1;
  const select = several ? el('select', { 'aria-label': 'Project' }, ...s.engines.map((e) => el('option', { value: e.base }, label(e)))) : null;
  const chosen = () => (select ? s.engines.find((e) => e.base === select.value) : s.engines[0]);
  main.append(box(el('strong', {}, `Add the bubble to ${where}?`), el('span', { class: 'muted' }, 'For a dev server you started yourself. What you ask for is changed in the project’s files.')));
  if (select) main.append(select);
  main.append(el('button', { class: 'primary', type: 'button', onclick: () => toggle(tab, s.origin, chosen(), true) }, several ? 'Add it' : `Add it for ${s.engines[0].project}`));
}

void render();
