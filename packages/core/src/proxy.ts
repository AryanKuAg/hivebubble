import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { BUBBLE_PATH, STRIPPED_HTML_HEADERS, WS_PATH, injectBubble } from './inject.js';

export const PAIR_PATH = '/__hivebubble/pair';

/**
 * The Hivebubble browser extension's ID. Its manifest carries the public key
 * this ID comes from, so every unpacked copy has it. A build published under
 * another ID is added with HIVEBUBBLE_EXTENSION_IDS (comma separated).
 */
export const EXTENSION_ID = 'eooocceknjjdpfdbcgakcdmofbnmbdmb';

export function extensionIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.HIVEBUBBLE_EXTENSION_IDS ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-p]{32}$/.test(s));
  return [EXTENSION_ID, ...extra];
}

export interface Pairing {
  /** A secret made when the engine starts; the extension hands it to the bubbles it adds. */
  token: string;
  extensionIds: string[];
}

export interface ProxyOptions {
  /** The dev server port, or null while it is still starting. */
  target: () => number | null;
  bubbleJs: () => string;
  onClient: (ws: WebSocket) => void;
  health: () => Record<string, unknown>;
  /** Lets the browser extension add bubbles to other localhost pages. */
  pairing?: Pairing;
}

const STARTING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="1.5">
<title>Starting your site…</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#fffaf0;color:#2b2118;display:grid;place-items:center;height:100vh;margin:0}p{opacity:.7}</style></head>
<body><main><h1>🐝 Starting your site…</h1><p>Hivebubble is waking up your dev server. This page refreshes by itself.</p></main></body></html>`;

/**
 * True for the loopback names a browser uses to reach this machine. The proxy
 * listens on 127.0.0.1 only, so any other Host means a page got here through
 * DNS rebinding (a site whose name now points at 127.0.0.1) and is refused.
 */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '127.0.0.1' || name === '[::1]';
}

/** A page on this machine: http(s)://localhost, 127.0.0.1, [::1] or *.localhost, any port. */
export function isLocalOrigin(origin: string | undefined): boolean {
  const m = /^https?:\/\/([^/]+)$/.exec(origin ?? '');
  return Boolean(m && isLocalHost(m[1]));
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The bubble's socket can change the project and read its data, so only the
 * page Hivebubble serves may open it. Browsers always send Origin on a
 * WebSocket handshake, so another site's page is refused. Local programs
 * that send no Origin are allowed: they can read the files anyway. A bubble
 * the browser extension added to another localhost page brings the pairing
 * token, which only the extension can get.
 */
export function allowBubbleSocket(req: http.IncomingMessage, token?: string): boolean {
  const host = req.headers.host;
  if (!isLocalHost(host)) return false;
  const origin = req.headers.origin;
  if (origin === undefined || origin === `http://${host}`) return true;
  if (!token || !isLocalOrigin(origin)) return false;
  const given = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
  return given !== null && sameSecret(given, token);
}

/** The extension that may fetch the pairing token, from the request's Origin; null for anything else. */
export function extensionOrigin(req: http.IncomingMessage, ids: string[]): string | null {
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(req.headers.origin ?? '');
  return m && ids.includes(m[1]) ? m[0] : null;
}

function refuse(socket: { write: (s: string) => unknown; destroy: () => unknown }): void {
  socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

/**
 * The preview proxy. It forwards every request to the dev server untouched,
 * except HTML pages, which get the bubble script added. It also serves the
 * bubble script and the bubble's WebSocket, and passes the dev server's own
 * hot-reload WebSocket straight through.
 */
export function createProxy(opts: ProxyOptions): http.Server {
  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (!isLocalHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Hivebubble only answers on localhost.');
      return;
    }
    if (url === BUBBLE_PATH || url.startsWith(`${BUBBLE_PATH}?`)) {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(opts.bubbleJs());
      return;
    }
    if (url === '/__hivebubble/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(opts.health()));
      return;
    }
    if (url === PAIR_PATH) {
      // Only the Hivebubble extension gets the token: a web page can't send another Origin.
      // POST, because Chrome leaves Origin off an extension's GET requests.
      const ext = opts.pairing && req.method === 'POST' ? extensionOrigin(req, opts.pairing.extensionIds) : null;
      if (!ext || !opts.pairing) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Only the Hivebubble browser extension can pair.');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': ext, vary: 'Origin' });
      res.end(JSON.stringify({ ...opts.health(), token: opts.pairing.token }));
      return;
    }

    const port = opts.target();
    if (port === null) {
      sendStarting(res);
      return;
    }
    const proxyOrigin = `http://${req.headers.host ?? ''}`;
    const devOrigin = `http://localhost:${port}`;
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `localhost:${port}`, 'accept-encoding': 'identity' };
    rewriteOriginHeaders(headers, proxyOrigin, devOrigin);

    const upstream = http.request(
      { host: 'localhost', port, method: req.method, path: url, headers },
      (up) => {
        const outHeaders = { ...up.headers };
        if (typeof outHeaders.location === 'string' && outHeaders.location.startsWith(devOrigin)) {
          outHeaders.location = proxyOrigin + outHeaders.location.slice(devOrigin.length);
        }
        const type = String(up.headers['content-type'] ?? '');
        const status = up.statusCode ?? 502;
        const hasBody = req.method !== 'HEAD' && status !== 204 && status !== 304;
        if (!type.includes('text/html') || !hasBody) {
          res.writeHead(status, outHeaders);
          up.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        up.on('data', (c: Buffer) => chunks.push(c));
        up.on('end', () => {
          const body = Buffer.from(injectBubble(Buffer.concat(chunks).toString('utf8')));
          for (const h of STRIPPED_HTML_HEADERS) delete outHeaders[h];
          outHeaders['content-length'] = String(body.length);
          outHeaders['cache-control'] = 'no-store';
          res.writeHead(status, outHeaders);
          res.end(body);
        });
        up.on('error', () => res.destroy());
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) sendStarting(res);
      else res.destroy();
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/';
    if (url === WS_PATH || url.startsWith(`${WS_PATH}?`)) {
      if (!allowBubbleSocket(req, opts.pairing?.token)) return refuse(socket);
      wss.handleUpgrade(req, socket, head, (ws) => opts.onClient(ws));
      return;
    }
    if (!isLocalHost(req.headers.host)) return refuse(socket);
    const port = opts.target();
    if (port === null) {
      socket.destroy();
      return;
    }
    // Pass the dev server's hot-reload socket through byte for byte.
    const proxyOrigin = `http://${req.headers.host ?? ''}`;
    const devOrigin = `http://localhost:${port}`;
    const upstream = net.connect({ host: 'localhost', port, autoSelectFamily: true });
    upstream.once('connect', () => {
      const lines = [`${req.method} ${url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        let value = req.rawHeaders[i + 1];
        const lower = name.toLowerCase();
        if (lower === 'host') value = `localhost:${port}`;
        if ((lower === 'origin' || lower === 'referer') && value.startsWith(proxyOrigin)) {
          value = devOrigin + value.slice(proxyOrigin.length);
        }
        lines.push(`${name}: ${value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', close);
    socket.on('close', close);
  });

  return server;
}

function rewriteOriginHeaders(headers: http.OutgoingHttpHeaders, from: string, to: string): void {
  for (const key of ['origin', 'referer']) {
    const value = headers[key];
    if (typeof value === 'string' && value.startsWith(from)) headers[key] = to + value.slice(from.length);
  }
}

function sendStarting(res: http.ServerResponse): void {
  res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(injectBubble(STARTING_PAGE));
}
