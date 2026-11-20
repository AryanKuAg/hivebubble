// Hivebubble extension, background: finds the Hivebubble engines running on this
// computer, pairs with them, and tells the content script on a localhost page
// whether to add the bubble there, and which engine it talks to.
//
// Only this extension can pair: the engine gives its token to requests whose
// Origin is this extension's ID, which a web page can't fake.

const PORTS = Array.from({ length: 10 }, (_, i) => 4321 + i);
const CACHE_MS = 3000;
let cache = { at: 0, engines: [] };

const portOf = (url) => {
  const u = new URL(url);
  return u.port || (u.protocol === 'https:' ? '443' : '80');
};
const isLocal = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost'));
  } catch {
    return false;
  }
};

async function probe(port) {
  const base = `http://127.0.0.1:${port}`;
  try {
    // POST: Chrome adds this extension's Origin to it, which is how the engine knows it's Hivebubble.
    const res = await fetch(`${base}/__hivebubble/pair`, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(900) });
    if (!res.ok) return null;
    const info = await res.json();
    return info && info.ok && typeof info.token === 'string' ? { ...info, base } : null;
  } catch {
    return null;
  }
}

async function engines(fresh = false) {
  if (!fresh && Date.now() - cache.at < CACHE_MS) return cache.engines;
  const found = (await Promise.all(PORTS.map(probe))).filter(Boolean);
  cache = { at: Date.now(), engines: found };
  return found;
}

async function sites() {
  const { sites = {} } = await chrome.storage.local.get('sites');
  return sites;
}

/**
 * What to do on this page: nothing (not local, or it's an engine's own preview,
 * which already has the bubble), add the bubble automatically (the project's own
 * dev server), or add it because the person turned it on for this site.
 */
async function decide(url, fresh = false) {
  if (!url || !isLocal(url)) return { local: false };
  const list = await engines(fresh);
  const port = portOf(url);
  const origin = new URL(url).origin;
  const preview = list.find((e) => portOf(e.base) === port);
  if (preview) return { local: true, origin, preview: true, engine: preview };
  const own = list.find((e) => e.site && portOf(e.site) === port);
  if (own) return { local: true, origin, auto: true, engine: own };
  const chosen = (await sites())[origin];
  if (chosen) {
    // The same engine if it's still there; after a restart (new port), the same project.
    const engine = list.find((e) => e.base === chosen.base) ?? list.find((e) => e.project === chosen.project) ?? list[0] ?? null;
    return { local: true, origin, enabled: true, project: chosen.project, engine };
  }
  return { local: true, origin, engine: null, choices: list };
}

const publicInfo = (e) => e && { project: e.project, framework: e.framework, base: e.base, site: e.site ?? null, agent: e.agent };

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  // The popup (an extension page) versus the content script on a localhost page.
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  (async () => {
    if (msg?.type === 'page' && sender.tab && sender.url && !fromExtensionPage) {
      // From the content script: the page's address comes from Chrome, not from the page.
      const d = await decide(sender.url);
      const engine = !d.preview && (d.auto || d.enabled) ? d.engine : null;
      return engine ? { engine: engine.base, token: engine.token, project: engine.project } : null;
    }
    if (!fromExtensionPage) return null; // Everything below is for the popup only.
    if (msg?.type === 'status') {
      const d = await decide(msg.url, true);
      const list = await engines();
      return { ...d, engine: publicInfo(d.engine), choices: undefined, engines: list.map(publicInfo) };
    }
    if (msg?.type === 'toggle' && typeof msg.origin === 'string' && isLocal(msg.origin)) {
      const all = await sites();
      if (msg.on) all[new URL(msg.origin).origin] = { project: String(msg.project ?? ''), base: String(msg.base ?? '') };
      else delete all[new URL(msg.origin).origin];
      await chrome.storage.local.set({ sites: all });
      return { ok: true };
    }
    return null;
  })().then(reply, () => reply(null));
  return true;
});
