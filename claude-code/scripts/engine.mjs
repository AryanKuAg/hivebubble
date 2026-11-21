// Finds the Hivebubble engine running for a project folder, and calls its local
// API. The engine writes .hivebubble/engine.json (its address and a key that
// changes each time it starts) into the project; only programs on this computer
// that can read the project can use it.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ENGINE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

/** The project folder Claude Code is working in. */
export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** The engine for this folder or a folder above it, or null. */
export function findEngine(start = projectDir()) {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, '.hivebubble', 'engine.json');
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (ENGINE_URL.test(data.url) && typeof data.token === 'string') return { dir, url: data.url, token: data.token, project: data.project ?? path.basename(dir) };
      } catch {
        // Being rewritten right now: look again next time.
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** POST to the engine's coding-agent API. Throws with the engine's own words when it says no. */
export async function call(engine, name, body = {}, { signal, timeoutMs = 130_000, client } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${engine.url}/__hivebubble/harness/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json', ...(client ? { 'x-hivebubble-client': client } : {}) },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Hivebubble answered ${res.status}.`);
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
