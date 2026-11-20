import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findFreePort, platformSpawn } from './processes.js';
import { startHivebubble, type StartState } from './server.js';

before(() => {
  process.env.HIVEBUBBLE_HOME = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-m7-home-'));
});

describe('starting commands on every platform', () => {
  it('runs .cmd tools through cmd.exe on Windows, with paths quoted', () => {
    const run = platformSpawn('npm', ['run', 'dev', '--', '--config', 'C:\\Users\\Ana Ruiz\\salon\\.hivebubble\\vite.config.mjs', '--port', '5173'], 'win32');
    assert.deepEqual(run, { file: 'npm run dev -- --config "C:\\Users\\Ana Ruiz\\salon\\.hivebubble\\vite.config.mjs" --port 5173', args: [], shell: true });
    assert.equal(platformSpawn('C:\\proj\\node_modules\\.bin\\vite.cmd', ['build', '--outDir', 'C:\\Temp\\out dir'], 'win32').file, 'C:\\proj\\node_modules\\.bin\\vite.cmd build --outDir "C:\\Temp\\out dir"');
    assert.equal(platformSpawn('npx', ['--yes', 'wrangler@4.158.0', 'deploy', '--config', ''], 'win32').file, 'npx --yes wrangler@4.158.0 deploy --config ""');
  });

  it('runs commands directly elsewhere, with arguments untouched', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      assert.deepEqual(platformSpawn('npm', ['run', 'dev', '--', '--config', '/Users/ana ruiz/x.mjs'], platform), { file: 'npm', args: ['run', 'dev', '--', '--config', '/Users/ana ruiz/x.mjs'], shell: false });
    }
  });
});

describe('attaching to a dev server the person already runs', () => {
  let site: http.Server;
  let sitePort = 0;
  before(async () => {
    site = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body><h1>My salon</h1></body></html>'));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    sitePort = (site.address() as net.AddressInfo).port;
  });
  after(() => site.close());

  it('installs and starts nothing, previews the site with the bubble, and tells the extension where it is', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-m7-attach-'));
    // If Hivebubble ran this dev script or installed packages, the test would see it.
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'my-salon', scripts: { dev: 'node -e "process.exit(3)"' }, dependencies: { 'left-pad': '1.3.0' } }));
    const states: StartState[] = [];
    const logs: string[] = [];
    const running = await startHivebubble({
      projectDir: dir,
      port: await findFreePort(4800),
      agent: 'mock',
      attach: `http://localhost:${sitePort}`,
      reporter: { status: (s) => states.push(s), log: (_source, line) => logs.push(line) },
    });
    try {
      assert.deepEqual(states, ['detecting', 'ready']);
      assert.ok(logs.some((l) => l.includes(`Attached to your dev server at http://localhost:${sitePort}`)));
      const page = await (await fetch(running.url)).text();
      assert.match(page, /<h1>My salon<\/h1>/);
      assert.match(page, /data-hivebubble/);
      const health = (await (await fetch(`${running.url}/__hivebubble/health`)).json()) as { site: string; devPort: number; sourceTags: boolean; preview: string };
      assert.deepEqual([health.site, health.devPort, health.sourceTags, health.preview], [`http://localhost:${sitePort}`, sitePort, false, running.url]);
    } finally {
      await running.stop();
    }
  });

  it('refuses an address that isn’t on this computer', async () => {
    await assert.rejects(
      startHivebubble({ projectDir: os.tmpdir(), agent: 'mock', attach: 'http://example.com:3000', reporter: { status: () => undefined, log: () => undefined } }),
      /on this computer/,
    );
  });
});
