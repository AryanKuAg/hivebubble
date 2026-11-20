// End-to-end smoke test against a running Hivebubble in demo mode.
//
//   pnpm demo                      # terminal 1 (examples/vite-react, --mock-agent)
//   node packages/core/scripts/smoke.mjs http://localhost:4321 examples/vite-react
//
// Checks: the bubble is injected, the bubble script is served, a chat message
// edits the right file through the bubble's WebSocket, and Undo restores it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:4321';
const project = path.resolve(process.argv[3] ?? 'examples/vite-react');
const file = path.join(project, 'src/App.jsx');
const OLD = 'Small-batch bread, baked every morning with local honey.';
const NEW = 'Fresh bread, baked at sunrise with local honey.';

const step = (msg) => console.log(`✔ ${msg}`);

const page = await fetch(base).then((r) => r.text());
assert.match(page, /data-hivebubble/, 'bubble script tag injected into the page');
step('bubble script tag is injected into the page');

const js = await fetch(`${base}/__hivebubble/bubble.js`);
assert.equal(js.status, 200);
assert.ok((await js.text()).length > 1000);
step('bubble script is served');

const original = readFileSync(file, 'utf8');
assert.ok(original.includes(OLD), `expected the example to contain: ${OLD}`);

const ws = new WebSocket(`${base.replace('http', 'ws')}/__hivebubble/ws`);
const events = [];
const waitFor = (pred, ms = 15000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for an event')), ms);
    const check = () => {
      const hit = events.find(pred);
      if (hit) {
        clearTimeout(timer);
        resolve(hit);
      } else setTimeout(check, 50);
    };
    check();
  });
ws.on('message', (data) => events.push(JSON.parse(String(data))));
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

const hello = await waitFor((e) => e.type === 'hello');
assert.equal(hello.agent, 'mock', 'run Hivebubble with --mock-agent for this test');
step(`connected to the bubble socket (${hello.project.name}, ${hello.project.framework})`);

ws.send(
  JSON.stringify({
    type: 'chat',
    text: `change the text to "${NEW}"`,
    element: { tag: 'p', selector: 'p.lede', text: OLD, html: `<p class="lede">${OLD}</p>` },
  }),
);
const user = await waitFor((e) => e.type === 'user');
assert.equal(user.route.effort, 'low');
step(`router picked ${user.route.label} (${user.route.effort} effort)`);

const done = await waitFor((e) => e.type === 'done');
assert.equal(done.ok, true, done.summary);
const edits = events.filter((e) => e.type === 'tool' && e.action === 'edit' && e.phase === 'start');
assert.deepEqual(edits.map((e) => e.file), ['src/App.jsx']);
assert.ok(readFileSync(file, 'utf8').includes(NEW));
step(`edited src/App.jsx in ${(done.durationMs / 1000).toFixed(1)}s with ${events.filter((e) => e.type === 'tool' && e.phase === 'start').length} tool steps`);

ws.send(JSON.stringify({ type: 'undo' }));
const undone = await waitFor((e) => e.type === 'undone');
assert.deepEqual(undone.files, ['src/App.jsx']);
assert.equal(readFileSync(file, 'utf8'), original);
step('undo restored the original file');

ws.close();
console.log('\nSmoke test passed.');
