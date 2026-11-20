import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// Never touch the real ~/Library/Application Support/Hivebubble from tests.
process.env.HIVEBUBBLE_HOME = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-home-'));

const { CostMeter, SpendLedger, dayKey, estimateCost, usageCost } = await import('./cost.js');
const { readSettings, writeJson } = await import('./home.js');
const { Checkpoints } = await import('./checkpoints.js');
const { RouterLog } = await import('./routerLog.js');
const { Checker, parseTscErrors, typecheckConfigs, viteErrorMessage } = await import('./checks.js');
const { Session } = await import('./session.js');
type AgentRequest = import('./agent.js').AgentRequest;
type ServerEvent = import('./types.js').ServerEvent;

function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-m3-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('cost', () => {
  it('prices Claude Opus 5.5 tokens', () => {
    assert.equal(usageCost('claude-opus-5-5', { input_tokens: 1_000_000 }), 4);
    assert.equal(usageCost('claude-opus-5-5', { output_tokens: 1_000_000 }), 20);
    assert.equal(usageCost('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 }), 0.2);
    assert.equal(usageCost('claude-opus-5-5', { cache_creation_input_tokens: 1_000_000 }), 5);
    assert.equal(usageCost('claude-opus-5-5', { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }), 8);
  });
  it('counts each streamed response once, with its largest numbers', () => {
    const meter = new CostMeter();
    meter.add({ id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 10 } });
    meter.add({ id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 500 } });
    meter.add({ id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 5000 } });
    assert.deepEqual(meter.tokens(), { input: 3000, output: 600, cacheRead: 5000, cacheWrite: 0 });
    assert.equal(meter.total.toFixed(6), ((3000 * 4 + 600 * 20 + 5000 * 0.2) / 1e6).toFixed(6));
  });
  it('keeps a daily ledger and a monthly summary', () => {
    const ledger = new SpendLedger(path.join(tempDir(), 'spend.json'));
    const day = new Date(2026, 10, 20, 15);
    ledger.add(0.5, day);
    ledger.add(0.25, day);
    ledger.add(1, new Date(2026, 10, 3));
    ledger.add(9, new Date(2026, 9, 31));
    assert.deepEqual(ledger.summary(5, day), { todayUsd: 0.75, todayTasks: 2, monthUsd: 1.75, monthTasks: 3, dailyCapUsd: 5, remainingUsd: 4.25 });
    assert.equal(dayKey(day), '2026-11-20');
  });
  it('estimates from history once there is some, else gives a rough range', () => {
    assert.deepEqual(estimateCost('xhigh', []), { lowUsd: 0.4, highUsd: 2.5, basis: 'typical' });
    const e = estimateCost('xhigh', [0.6, 0.8, 1, 1.2, 3]);
    assert.equal(e.basis, 'history');
    assert.ok(e.lowUsd >= 0.6 && e.highUsd <= 3 && e.lowUsd < e.highUsd);
  });
  it('reads settings, with environment variables winning', () => {
    writeJson(path.join(process.env.HIVEBUBBLE_HOME!, 'settings.json'), { dailyCapUsd: 12 });
    assert.deepEqual(readSettings({}), { dailyCapUsd: 12, taskCapUsd: 2 });
    assert.deepEqual(readSettings({ HIVEBUBBLE_DAILY_CAP: '3', HIVEBUBBLE_TASK_CAP: 'nope' }), { dailyCapUsd: 3, taskCapUsd: 2 });
    writeJson(path.join(process.env.HIVEBUBBLE_HOME!, 'settings.json'), {});
  });
});

describe('undo points', () => {
  it('survive a restart', () => {
    const dir = tempDir({ 'a.txt': 'one' });
    const cp = new Checkpoints(dir);
    cp.begin('make it two', 'task1');
    cp.snapshot(path.join(dir, 'a.txt'));
    writeFileSync(path.join(dir, 'a.txt'), 'two');
    assert.deepEqual(cp.touched(), ['a.txt']);
    assert.equal(cp.commit(), true);
    const again = new Checkpoints(dir);
    assert.deepEqual(again.history().map((h) => [h.id, h.prompt, h.files]), [['task1', 'make it two', ['a.txt']]]);
    assert.deepEqual(again.undo(), { files: ['a.txt'], conflicts: [] });
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one');
    assert.equal(new Checkpoints(dir).canUndo(), false);
  });
  it('do not overwrite changes made after the task unless asked', () => {
    const dir = tempDir({ 'a.txt': 'one' });
    const cp = new Checkpoints(dir);
    cp.begin();
    cp.snapshot(path.join(dir, 'a.txt'));
    writeFileSync(path.join(dir, 'a.txt'), 'two');
    cp.commit();
    writeFileSync(path.join(dir, 'a.txt'), 'two, edited by hand');
    assert.deepEqual(cp.undo(), { files: [], conflicts: ['a.txt'] });
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two, edited by hand');
    assert.deepEqual(cp.undo(true), { files: ['a.txt'], conflicts: ['a.txt'] });
    assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one');
  });
  it('keep only the newest few', () => {
    const dir = tempDir({ 'a.txt': '0' });
    const cp = new Checkpoints(dir, { maxDepth: 2 });
    for (let i = 1; i <= 3; i++) {
      cp.begin(`step ${i}`);
      cp.snapshot(path.join(dir, 'a.txt'));
      writeFileSync(path.join(dir, 'a.txt'), String(i));
      cp.commit();
    }
    assert.deepEqual(new Checkpoints(dir).history().map((h) => h.prompt), ['step 3', 'step 2']);
  });
});

describe('router log', () => {
  it('records tasks and leaves undone ones out of estimates', () => {
    const root = tempDir();
    const log = new RouterLog(root);
    const task = (id: string, costUsd: number) => ({
      id, at: '', text: 'x', kind: 'new-app' as const, effort: 'xhigh' as const, signals: [], checks: [], attempts: [],
      outcome: 'done' as const, filesChanged: 1, costUsd, durationMs: 1,
    });
    log.record(task('a', 1));
    log.record(task('b', 2));
    log.record({ ...task('c', 3), outcome: 'failed' });
    log.markUndone('b');
    assert.deepEqual(log.costs('xhigh'), [1]);
    assert.deepEqual(log.costs('low'), []);
    // Any project gets a .hivebubble folder that keeps itself out of git.
    assert.equal(readFileSync(path.join(root, '.hivebubble/.gitignore'), 'utf8').trim().split('\n').pop(), '*');
  });
});

describe('checks', () => {
  it('reads the compile error from a Vite error page', () => {
    const page = '<script type="module">const error = {"message":"Transform failed:\\n[PARSE_ERROR] Expected \\"</h1>\\"","stack":""}</script>';
    assert.equal(viteErrorMessage(page), 'Transform failed:\n[PARSE_ERROR] Expected "</h1>"');
    assert.equal(viteErrorMessage('<p>fine</p>'), null);
  });
  it('reads TypeScript errors and the configs to check', () => {
    assert.deepEqual(parseTscErrors("src/App.tsx(12,5): error TS2322: Type 'number' is not assignable to type 'string'.\nnoise"), [
      { file: 'src/App.tsx', line: 12, code: 'TS2322', message: "Type 'number' is not assignable to type 'string'." },
    ]);
    const dir = tempDir({
      'tsconfig.json': '{\n  // Vite template style\n  "files": [],\n  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" },],\n}',
      'tsconfig.app.json': '{}',
      'tsconfig.node.json': '{}',
    });
    assert.deepEqual(typecheckConfigs(dir).map((f) => path.basename(f)), ['tsconfig.app.json', 'tsconfig.node.json']);
  });
});

// ---- the session: route → checks → one retry → log, ledger, confirmation, pause, undo ----

describe('session (with a fake dev server and a fake Claude)', () => {
  let server: http.Server;
  let port = 0;
  const dir = tempDir({ 'package.json': '{}', 'src/Hero.jsx': 'export const Hero = () => "Hello";\n' });

  before(async () => {
    // Like Vite: a module that doesn't compile answers 500 with the error in the page.
    server = http.createServer((req, res) => {
      const file = path.join(dir, decodeURIComponent((req.url ?? '/').slice(1)));
      if (req.url !== '/' && existsSync(file) && readFileSync(file, 'utf8').includes('BROKEN')) {
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end('<script>const error = {"message":"Unexpected token BROKEN (1:28)"}</script>');
        return;
      }
      res.writeHead(200, { 'content-type': req.url === '/' ? 'text/html' : 'text/javascript' });
      res.end(req.url === '/' ? '<html></html>' : 'export {}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => server.close());

  function setup(script: (call: number, req: AgentRequest) => string, opts: { spentToday?: number } = {}) {
    const ledger = new SpendLedger(path.join(tempDir(), 'spend.json'));
    if (opts.spentToday) ledger.add(opts.spentToday);
    const calls: AgentRequest[] = [];
    const info = { dir, name: 't', framework: 'vite' as const, packageManager: 'npm' as const, devScript: 'dev', devScriptCommand: 'vite', needsInstall: false };
    const session = new Session({
      cwd: dir,
      project: { name: 't', framework: 'Vite' },
      agent: 'claude',
      apiKey: 'sk-ant-test',
      log: () => undefined,
      checker: new Checker(info, () => port, () => undefined),
      ledger,
      runClaude: async (ctx, req) => {
        calls.push(req);
        const file = path.join(dir, 'src/Hero.jsx');
        ctx.checkpoints.snapshot(file);
        writeFileSync(file, script(calls.length, req));
        ctx.emit({ type: 'cost', usd: 0.01 });
        return { ok: true, summary: `attempt ${calls.length}`, costUsd: 0.02, sessionId: 's1' };
      },
    });
    const events: ServerEvent[] = [];
    session.attach({ readyState: 1, OPEN: 1, send: (d: string) => events.push(JSON.parse(d)), on: () => undefined } as never);
    return { session, events, calls, ledger };
  }
  const waitFor = async (events: ServerEvent[], type: ServerEvent['type']) => {
    for (let i = 0; i < 200; i++) {
      const hit = events.find((e) => e.type === type);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no ${type} event`);
  };

  it('retries once, one level deeper, when a check fails, and logs and bills both attempts', async () => {
    const { session, events, calls, ledger } = setup((n) => (n === 1 ? 'export const Hero = () => BROKEN;\n' : 'export const Hero = () => "Fresh";\n'));
    await session.handle({ type: 'chat', text: 'change the headline to "Fresh"' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.route.effort), ['low', 'medium']);
    assert.match(calls[1].prompt, /Unexpected token BROKEN/);
    const retry = events.find((e): e is Extract<ServerEvent, { type: 'retry' }> => e.type === 'retry');
    assert.match(retry?.reason ?? '', /page check failed/);
    const checkEnds = events.filter((e): e is Extract<ServerEvent, { type: 'check' }> => e.type === 'check' && e.phase === 'end');
    assert.deepEqual(checkEnds.map((e) => e.result?.ok), [false, true]);
    assert.deepEqual(events.filter((e) => e.type === 'cost').map((e) => (e as { usd: number }).usd), [0.01, 0.03]);
    const done = events.find((e): e is Extract<ServerEvent, { type: 'done' }> => e.type === 'done')!;
    assert.deepEqual([done.ok, done.attempts, done.costUsd], [true, 2, 0.04]);
    assert.equal(ledger.summary(5).todayUsd, 0.04);
    const log = readFileSync(path.join(dir, '.hivebubble/router-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([log.at(-1).outcome, log.at(-1).attempts.length, log.at(-1).kind], ['done', 2, 'copy']);
  });

  it('says so plainly when the retry fails too', async () => {
    const { session, events, calls } = setup(() => 'export const Hero = () => BROKEN;\n');
    await session.handle({ type: 'chat', text: 'change the headline to "Oops"' });
    assert.equal(calls.length, 2);
    const done = events.find((e): e is Extract<ServerEvent, { type: 'done' }> => e.type === 'done')!;
    assert.equal(done.ok, false);
    assert.match(done.summary, /page check still fails[\s\S]*Undo/);
    assert.equal(done.canUndo, true);
    await session.handle({ type: 'undo' });
  });

  it('pauses once the daily limit is reached', async () => {
    const { session, events, calls } = setup(() => 'x', { spentToday: 5 });
    await session.handle({ type: 'chat', text: 'change the headline to "Hi"' });
    assert.equal(calls.length, 0);
    const paused = events.find((e): e is Extract<ServerEvent, { type: 'paused' }> => e.type === 'paused');
    assert.equal(paused?.spend.remainingUsd, 0);
    assert.match((events.find((e) => e.type === 'done') as { summary: string }).summary, /daily limit of \$5\.00/);
  });

  it('asks before a big task, with an estimate', async () => {
    const { session, events, calls } = setup(() => 'export const Hero = () => "Booking";\n');
    const declined = session.handle({ type: 'chat', text: 'make me a booking app for my salon' });
    const ask = (await waitFor(events, 'confirm')) as Extract<ServerEvent, { type: 'confirm' }>;
    assert.equal(ask.route.effort, 'xhigh');
    assert.equal(ask.estimate.basis, 'typical');
    await session.handle({ type: 'confirm', id: ask.id, ok: false });
    await declined;
    assert.equal(calls.length, 0);
    events.length = 0;
    const accepted = session.handle({ type: 'chat', text: 'make me a booking app for my salon' });
    const ask2 = (await waitFor(events, 'confirm')) as Extract<ServerEvent, { type: 'confirm' }>;
    await session.handle({ type: 'confirm', id: ask2.id, ok: true });
    await accepted;
    assert.deepEqual(calls.map((c) => c.route.effort), ['xhigh']);
    await session.handle({ type: 'undo' });
  });

  it('protects later edits on undo, then routes the next task one level deeper', async () => {
    const { session, events } = setup(() => 'export const Hero = () => "Changed";\n');
    const beforeTask = readFileSync(path.join(dir, 'src/Hero.jsx'), 'utf8');
    await session.handle({ type: 'chat', text: 'change the headline to "Changed"' });
    writeFileSync(path.join(dir, 'src/Hero.jsx'), 'export const Hero = () => "Changed by hand";\n');
    await session.handle({ type: 'undo' });
    assert.deepEqual((events.find((e) => e.type === 'undo-conflict') as { files: string[] }).files, ['src/Hero.jsx']);
    await session.handle({ type: 'undo', force: true });
    assert.equal(readFileSync(path.join(dir, 'src/Hero.jsx'), 'utf8'), beforeTask);
    events.length = 0;
    await session.handle({ type: 'chat', text: 'make it bigger' });
    const user = events.find((e): e is Extract<ServerEvent, { type: 'user' }> => e.type === 'user')!;
    assert.ok(user.route.signals.includes('after-undo'));
    await session.handle({ type: 'undo' });
  });
});
