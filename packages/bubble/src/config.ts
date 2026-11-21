/** Where the bubble finds the Hivebubble engine. */
export interface EngineConfig {
  /** e.g. "http://localhost:4321", or null when the engine serves this page (the preview proxy). */
  origin: string | null;
  /** The pairing token the browser extension brings, for pages the engine doesn't serve. */
  token: string | null;
}

const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

/**
 * The preview proxy adds the bubble with a plain script tag, so the engine is
 * this page's own origin. The browser extension adds it to other localhost
 * pages with data-hivebubble-engine and data-hivebubble-token; the token is
 * taken off the page as soon as it's read.
 */
export function readConfig(script: Element | null): EngineConfig {
  if (!(script instanceof HTMLScriptElement)) return { origin: null, token: null };
  const engine = script.dataset.hivebubbleEngine ?? '';
  const token = script.dataset.hivebubbleToken ?? '';
  script.removeAttribute('data-hivebubble-token');
  if (!LOCAL_ORIGIN.test(engine)) return { origin: null, token: null };
  return { origin: engine, token: /^[\w-]{16,128}$/.test(token) ? token : null };
}

/**
 * A new pairing from the extension's content script (the hivebubble:paired
 * event): JSON text, since objects don't cross from the extension's world.
 */
export function readPairing(detail: unknown): EngineConfig | null {
  if (typeof detail !== 'string') return null;
  try {
    const { engine, token } = JSON.parse(detail) as { engine?: unknown; token?: unknown };
    if (typeof engine !== 'string' || !LOCAL_ORIGIN.test(engine)) return null;
    if (typeof token !== 'string' || !/^[\w-]{16,128}$/.test(token)) return null;
    return { origin: engine, token };
  } catch {
    return null;
  }
}

/** The engine's WebSocket address for this config. */
export function socketUrl(config: EngineConfig, page?: Pick<Location, 'protocol' | 'host'>): string {
  if (!config.origin) {
    const here = page ?? location;
    return `${here.protocol === 'https:' ? 'wss' : 'ws'}://${here.host}/__hivebubble/ws`;
  }
  const base = config.origin.replace(/^http/, 'ws');
  return `${base}/__hivebubble/ws${config.token ? `?token=${encodeURIComponent(config.token)}` : ''}`;
}
