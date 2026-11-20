import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { allowBubbleSocket, createProxy, isLocalHost } from './proxy.js';

let upstream: http.Server;
let proxy: http.Server;
let port = 0;

before(async () => {
  upstream = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(`dev server saw ${req.headers.host}`));
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const devPort = (upstream.address() as net.AddressInfo).port;
  proxy = createProxy({ target: () => devPort, bubbleJs: () => '/* bubble */', onClient: (ws) => ws.send('hello'), health: () => ({ ok: true }) });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  port = (proxy.address() as net.AddressInfo).port;
});
after(() => {
  proxy.close();
  upstream.close();
});

/** Opens the bubble's socket with these handshake headers: 'open', or the refusal's status. */
function bubbleSocket(headers: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__hivebubble/ws`, { headers });
    ws.on('message', () => {
      resolve('open');
      ws.close();
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
}

function get(host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c)).on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

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

  it('knows the loopback names', () => {
    for (const h of ['localhost:4321', 'LOCALHOST', 'app.localhost:4321', '127.0.0.1:4321', '[::1]:4321']) assert.ok(isLocalHost(h), h);
    for (const h of [undefined, '', 'localhost.evil.example', '127.0.0.1.nip.io', 'evil.example', '192.168.1.5:4321']) assert.ok(!isLocalHost(h), String(h));
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage;
    assert.ok(allowBubbleSocket(req({ host: 'localhost:4321', origin: 'http://localhost:4321' })));
    assert.ok(!allowBubbleSocket(req({ host: 'localhost:4321', origin: 'http://localhost:4321.evil.example' })));
  });
});
