import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { EXTENSION_ID, allowBubbleSocket, createProxy, extensionIds, isLocalHost, isLocalOrigin } from './proxy.js';
import { parseAttachUrl } from './server.js';

const TOKEN = 'Zk3pV0q8xW1yR6tN2mB5cA7dE9fG4hJ0';
let upstream: http.Server;
let proxy: http.Server;
let port = 0;

before(async () => {
  upstream = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(`dev server saw ${req.headers.host}`));
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const devPort = (upstream.address() as net.AddressInfo).port;
  proxy = createProxy({
    target: () => devPort,
    bubbleJs: () => '/* bubble */',
    onClient: (ws) => ws.send('hello'),
    health: () => ({ ok: true, project: 'bakery' }),
    pairing: { token: TOKEN, extensionIds: [EXTENSION_ID] },
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  port = (proxy.address() as net.AddressInfo).port;
});
after(() => {
  proxy.close();
  upstream.close();
});

/** Opens the bubble's socket with these handshake headers: 'open', or the refusal's status. */
function bubbleSocket(headers: Record<string, string>, query = ''): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__hivebubble/ws${query}`, { headers });
    ws.on('message', () => {
      resolve('open');
      ws.close();
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
}

function get(host: string, pathname = '/', extra: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .request({ host: '127.0.0.1', port, path: pathname, method, headers: { host, ...extra } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      })
      .on('error', reject)
      .end();
  });
}
const pair = (host: string, origin?: string, method = 'POST') => get(host, '/__hivebubble/pair', origin ? { origin } : {}, method);

describe('the proxy only serves this machine', () => {
  it('lets the page it serves open the bubble socket', async () => {
    assert.equal(await bubbleSocket({ host: `localhost:${port}`, origin: `http://localhost:${port}` }), 'open');
    assert.equal(await bubbleSocket({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }), 'open');
  });

  it('refuses the bubble socket to other sites (cross-site WebSocket hijacking)', async () => {
    assert.equal(await bubbleSocket({ host: `localhost:${port}`, origin: 'https://evil.example' }), 403);
    assert.equal(await bubbleSocket({ host: `localhost:${port}`, origin: `http://localhost:${port + 1}` }), 403);
    assert.equal(await bubbleSocket({ host: `localhost:${port}`, origin: 'null' }), 403);
  });

  it('refuses requests that arrive under another name (DNS rebinding)', async () => {
    assert.equal(await bubbleSocket({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` }), 403);
    const page = await get(`evil.example:${port}`);
    assert.equal(page.status, 403);
    assert.doesNotMatch(page.body, /dev server/);
  });

  it('still proxies pages on localhost', async () => {
    const page = await get(`localhost:${port}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /^dev server saw localhost:\d+$/);
  });

  it('allows local programs that send no Origin', async () => {
    assert.equal(await bubbleSocket({ host: `localhost:${port}` }), 'open');
  });

  it('gives the pairing token to the Hivebubble extension only', async () => {
    const ext = `chrome-extension://${EXTENSION_ID}`;
    const ok = await pair(`localhost:${port}`, ext);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], ext);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, project: 'bakery', token: TOKEN });
    for (const origin of [undefined, `http://localhost:${port}`, 'http://localhost:3000', `chrome-extension://${'a'.repeat(32)}`, 'https://evil.example']) {
      const res = await pair(`localhost:${port}`, origin);
      assert.equal(res.status, 403, String(origin));
      assert.doesNotMatch(res.body, new RegExp(TOKEN));
    }
    assert.equal((await pair(`localhost:${port}`, ext, 'GET')).status, 403, 'POST only: Chrome leaves Origin off GETs');
    assert.equal((await pair(`evil.example:${port}`, ext)).status, 403, 'not through DNS rebinding either');
  });

  it('lets a bubble on another localhost page in with the token, and nothing else', async () => {
    const page = { host: `localhost:${port}`, origin: 'http://localhost:3000' };
    assert.equal(await bubbleSocket(page), 403, 'no token');
    assert.equal(await bubbleSocket(page, '?token=wrong'), 403);
    assert.equal(await bubbleSocket(page, `?token=${TOKEN}x`), 403);
    assert.equal(await bubbleSocket(page, `?token=${TOKEN}`), 'open');
    assert.equal(await bubbleSocket({ host: `localhost:${port}`, origin: 'http://127.0.0.1:5173' }, `?token=${TOKEN}`), 'open');
    assert.equal(await bubbleSocket({ host: `localhost:${port}`, origin: 'https://evil.example' }, `?token=${TOKEN}`), 403, 'a leaked token still only works from this machine');
  });

  it('attaches only to a dev server on this machine', () => {
    assert.equal(parseAttachUrl('localhost:3000').origin, 'http://localhost:3000');
    assert.equal(parseAttachUrl('http://127.0.0.1:8080/app').origin, 'http://127.0.0.1:8080');
    for (const bad of ['http://example.com:3000', 'http://localhost', 'https://localhost:3000', 'nope nope']) assert.throws(() => parseAttachUrl(bad), /this computer|isn’t an address|isn't an address/, bad);
    assert.deepEqual(extensionIds({ HIVEBUBBLE_EXTENSION_IDS: `${'b'.repeat(32)}, not-an-id` }), [EXTENSION_ID, 'b'.repeat(32)]);
    assert.ok(isLocalOrigin('http://localhost:3000') && isLocalOrigin('https://app.localhost') && !isLocalOrigin('http://localhost.evil.example') && !isLocalOrigin('null'));
  });

  it('knows the loopback names', () => {
    for (const h of ['localhost:4321', 'LOCALHOST', 'app.localhost:4321', '127.0.0.1:4321', '[::1]:4321']) assert.ok(isLocalHost(h), h);
    for (const h of [undefined, '', 'localhost.evil.example', '127.0.0.1.nip.io', 'evil.example', '192.168.1.5:4321']) assert.ok(!isLocalHost(h), String(h));
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;
    assert.ok(allowBubbleSocket(req({ host: 'localhost:4321', origin: 'http://localhost:4321' })));
    assert.ok(!allowBubbleSocket(req({ host: 'localhost:4321', origin: 'http://localhost:4321.evil.example' })));
  });
});
