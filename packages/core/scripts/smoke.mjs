// End-to-end smoke test against a running Hivebubble in demo mode.
//
//   pnpm demo                      # terminal 1 (examples/vite-react, --mock-agent)
//   node packages/core/scripts/smoke.mjs http://localhost:4321 examples/vite-react
//
// Checks: the bubble is injected, the bubble script is served, the dev server
// stamps source tags on page elements, a chat message about a picked element
// goes straight to its file and line (no search), the bee events carry the
// lines being changed, and Undo restores the file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:4321';
const project = path.resolve(process.argv[3] ?? 'examples/vite-react');
const rel = 'src/components/Hero.jsx';
const file = path.join(project, rel);
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
const lines = original.split('\n');
const line = lines.findIndex((l) => l.includes('className="lede"')) + 1;
const tag = `${rel}:${line}:${lines[line - 1].indexOf('<p') + 1}`;

const health = await fetch(`${base}/__hivebubble/health`).then((r) => r.json());
assert.equal(health.sourceTags, true, 'source tags should be on for the Vite example');
const module = await fetch(`${base}/${rel}`).then((r) => r.text());
assert.ok(module.includes(`"data-hivebubble-src": "${tag}"`), `the served module should tag the lede paragraph as ${tag}`);
step(`dev server stamps source tags (the lede paragraph is ${tag})`);

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
assert.equal(hello.sourceTags, true);
step(`connected to the bubble socket (${hello.project.name}, ${hello.project.framework}, source tags on)`);

ws.send(
  JSON.stringify({
    type: 'chat',
    text: `change the text to "${NEW}"`,
    element: { tag: 'p', selector: 'p.lede', text: OLD, html: `<p class="lede">${OLD}</p>`, src: tag },
  }),
);
const user = await waitFor((e) => e.type === 'user');
assert.equal(user.route.effort, 'low');
step(`router picked ${user.route.label} (${user.route.effort} effort)`);

const done = await waitFor((e) => e.type === 'done');
assert.equal(done.ok, true, done.summary);
const tools = events.filter((e) => e.type === 'tool');
const starts = tools.filter((e) => e.phase === 'start');
assert.deepEqual(starts.map((e) => e.tool), ['Read', 'Edit'], 'with a source tag the agent goes straight to the file');
const edits = tools.filter((e) => e.tool === 'Edit');
assert.deepEqual(edits.map((e) => e.file), [rel, rel]);
assert.deepEqual(edits.map((e) => e.lines), [[line, line], [line, line]], 'edit events carry the lines being changed');
assert.ok(readFileSync(file, 'utf8').includes(NEW));
step(`edited ${rel} line ${line} in ${(done.durationMs / 1000).toFixed(1)}s with ${starts.length} tool steps, no search`);

ws.send(JSON.stringify({ type: 'undo' }));
const undone = await waitFor((e) => e.type === 'undone');
assert.deepEqual(undone.files, [rel]);
assert.equal(readFileSync(file, 'utf8'), original);
step('undo restored the original file');

ws.close();
console.log('\nSmoke test passed.');
