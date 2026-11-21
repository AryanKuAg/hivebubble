import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import WebSocket from 'ws';
import { SpendLedger } from './cost.js';
import { clientLabel } from './harness.js';
import { findFreePort } from './processes.js';
import { startHivebubble, type Running } from './server.js';
import { Session } from './session.js';
import type { ServerEvent } from './types.js';

const PLUGIN = fileURLToPath(new URL('../../../claude-code/scripts/', import.meta.url));
before(() => {
  process.env.HIVEBUBBLE_HOME = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-harness-home-'));
});

/** Claude Code's side of the MCP connection: JSON-RPC over the plugin's own server script. */
class McpClient {
  readonly proc: ChildProcess;
  private buf = '';
  private nextId = 0;
  private readonly pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  constructor(projectDir: string) {
    this.proc = spawn(process.execPath, [path.join(PLUGIN, 'mcp.mjs')], { env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir }, stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
      }
    });
  }
  request(method: string, params: unknown = {}): Promise<{ result?: any; error?: any }> {
    const id = ++this.nextId;
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const r = await this.request('tools/call', { name, arguments: args });
    return { text: r.result.content[0].text as string, isError: Boolean(r.result.isError) };
  }
  close(): void {
    this.proc.stdin!.end();
  }
}

/** One Claude Code hook call: the plugin's hook script with the JSON Claude Code sends. */
function hook(input: Record<string, unknown>): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(PLUGIN, 'hook.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.on('close', () => resolve(out));
    proc.stdin.end(JSON.stringify(input));
  });
}

/** The bubble on the page: a local client of the engine's socket. */
function bubble(url: string) {
  const events: ServerEvent[] = [];
  const ws = new WebSocket(`${url.replace('http://localhost', 'ws://127.0.0.1')}/__hivebubble/ws`);
  ws.on('message', (d) => events.push(JSON.parse(String(d))));
  const ready = new Promise((r) => ws.once('open', r));
  const waitFor = async <T extends ServerEvent['type']>(type: T, test: (e: Extract<ServerEvent, { type: T }>) => boolean = () => true, ms = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = events.find((e): e is Extract<ServerEvent, { type: T }> => e.type === type && test(e as Extract<ServerEvent, { type: T }>));
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`no ${type} event`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { ws, events, ready, waitFor, send: (msg: unknown) => ws.send(JSON.stringify(msg)) };
}

const idOf = (text: string) => /request_id: (r[0-9a-f]+)/.exec(text)?.[1] ?? '';

describe('Claude Code does the work, through Hivebubble’s plugin (no API key)', () => {
  let site: http.Server;
  let sitePort = 0;
  let broken = false;
  let dir = '';
  let engine: Running;
  let mcp: McpClient;
  const file = () => path.join(dir, 'src', 'App.jsx');
  const ORIGINAL = 'export default function App() { return <h1>Welcome</h1>; }\n';

  before(async () => {
    site = http.createServer((_req, res) => (broken ? res.writeHead(500).end('Internal Server Error: Unexpected token') : res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Welcome</h1>')));
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    sitePort = (site.address() as net.AddressInfo).port;
    dir = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-harness-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bakery', scripts: { dev: 'echo not used' } }));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(file(), ORIGINAL);
    engine = await startHivebubble({ projectDir: dir, port: await findFreePort(4900), attach: `http://localhost:${sitePort}`, reporter: { status: () => undefined, log: () => undefined } });
    mcp = new McpClient(dir);
  });
  after(async () => {
    mcp?.close();
    await engine?.stop();
    site?.close();
  });

  it('tells the plugin where it is, in a file only this user can read', () => {
    const engineFile = path.join(dir, '.hivebubble', 'engine.json');
    const data = JSON.parse(readFileSync(engineFile, 'utf8')) as { url: string; token: string; agent: string };
    assert.match(data.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(data.token.length >= 32);
    assert.equal(data.agent, 'harness');
    if (process.platform !== 'win32') assert.equal(statSync(engineFile).mode & 0o777, 0o600);
  });

  it('speaks MCP to Claude Code', async () => {
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.329' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'hivebubble');
    const list = await mcp.request('tools/list');
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['next_request', 'say', 'finish', 'data_schema', 'data_query', 'data_change']);
    assert.ok((await mcp.request('nope')).error, 'unknown methods are errors');
  });

  it('hands a request from the bubble to Claude Code, follows its steps, keeps Undo, and checks the result', async () => {
    const b = bubble(engine.url);
    await b.ready;
    const hello = await b.waitFor('hello');
    assert.equal(hello.agent, 'harness');
    const waiting = mcp.call('next_request', { wait_seconds: 30 });
    await b.waitFor('harness', (e) => e.connected && e.client === 'Claude Code');
    b.send({ type: 'chat', text: 'Change the headline to "Fresh bread"' });
    const got = await waiting;
    assert.match(got.text, /The person asks.*\n\nChange the headline to "Fresh bread"/s);
    assert.match(got.text, /call finish with request_id/);
    const id = idOf(got.text);
    assert.ok(id);

    // Claude Code edits the file; its hooks tell Hivebubble before and after.
    const edit = { cwd: dir, tool_name: 'Edit', tool_use_id: 'toolu_1', tool_input: { file_path: file(), old_string: 'Welcome', new_string: 'Fresh bread' } };
    const pre = JSON.parse(await hook({ ...edit, hook_event_name: 'PreToolUse' }));
    assert.equal(pre.hookSpecificOutput.permissionDecision, 'allow', 'edits inside the project are approved during a bubble request');
    writeFileSync(file(), ORIGINAL.replace('Welcome', 'Fresh bread'));
    assert.equal(await hook({ ...edit, hook_event_name: 'PostToolUse', tool_response: { filePath: file() } }), '');
    await b.waitFor('tool', (e) => e.phase === 'start' && e.file === 'src/App.jsx' && e.action === 'edit');
    await b.waitFor('tool', (e) => e.phase === 'end' && e.file === 'src/App.jsx');

    const done = await mcp.call('finish', { request_id: id, summary: 'The headline now says “Fresh bread”.' });
    assert.match(done.text, /checks passed/);
    assert.equal((await b.waitFor('say', (e) => e.role === 'assistant')).text, 'The headline now says “Fresh bread”.');
    const finished = await b.waitFor('done');
    assert.deepEqual([finished.ok, finished.canUndo, finished.costUsd], [true, true, undefined]);

    b.send({ type: 'undo' });
    await b.waitFor('undone');
    assert.equal(readFileSync(file(), 'utf8'), ORIGINAL, 'Undo puts back the file Claude Code changed');
    b.ws.close();
  });

  it('sends a failed check back to Claude Code to fix, once', async () => {
    const b = bubble(engine.url);
    await b.ready;
    const waiting = mcp.call('next_request', { wait_seconds: 30 });
    await b.waitFor('hello');
    b.send({ type: 'chat', text: 'Add a pricing section below the menu' });
    const id = idOf((await waiting).text);
    const edit = { cwd: dir, tool_name: 'Write', tool_use_id: 'toolu_2', tool_input: { file_path: file(), content: 'broken' } };
    await hook({ ...edit, hook_event_name: 'PreToolUse' });
    writeFileSync(file(), 'export default function App() { return <h1>Prices</h2>; }\n');
    await hook({ ...edit, hook_event_name: 'PostToolUse' });
    broken = true;
    const first = await mcp.call('finish', { request_id: id, summary: 'Added a pricing section.' });
    assert.match(first.text, /check found a problem/);
    assert.match(first.text, /The page itself fails to load \(HTTP 500\)/);
    const fixId = idOf(first.text);
    assert.ok(fixId && fixId !== id, 'the fix is a new request, handed straight back');
    broken = false;
    writeFileSync(file(), 'export default function App() { return <h1>Prices</h1>; }\n');
    const second = await mcp.call('finish', { request_id: fixId, summary: 'Fixed a typo in the new section.' });
    assert.match(second.text, /checks passed/);
    const finished = await b.waitFor('done');
    assert.deepEqual([finished.ok, finished.attempts], [true, 2]);
    b.send({ type: 'undo' });
    await b.waitFor('undone');
    b.ws.close();
  });

  it('makes Stop in the bubble stop Claude Code at its next step', async () => {
    const b = bubble(engine.url);
    await b.ready;
    const waiting = mcp.call('next_request', { wait_seconds: 30 });
    await b.waitFor('hello');
    b.send({ type: 'chat', text: 'Make the whole site dark' });
    const id = idOf((await waiting).text);
    b.send({ type: 'stop' });
    await b.waitFor('done', (e) => !e.ok);
    const pre = JSON.parse(await hook({ cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_3', tool_input: { file_path: file() } }));
    assert.equal(pre.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(pre.hookSpecificOutput.permissionDecisionReason, /pressed Stop/);
    assert.match((await mcp.call('finish', { request_id: id, summary: 'Stopped.' })).text, /stopped this request/);
    assert.equal(readFileSync(file(), 'utf8'), ORIGINAL);
    b.ws.close();
  });

  it('does nothing in folders without Hivebubble, and keeps web pages out of the agent API', async () => {
    assert.equal(await hook({ cwd: os.tmpdir(), hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/tmp/x' } }), '');
    const { url, token } = JSON.parse(readFileSync(path.join(dir, '.hivebubble', 'engine.json'), 'utf8')) as { url: string; token: string };
    const post = (headers: Record<string, string>) => fetch(`${url}/__hivebubble/harness/next`, { method: 'POST', headers, body: '{"wait":0}' }).then((r) => r.status);
    assert.equal(await post({}), 401);
    assert.equal(await post({ authorization: 'Bearer wrong' }), 401);
    assert.equal(await post({ authorization: `Bearer ${token}`, origin: 'http://localhost:3000' }), 403, 'a page never gets in, even with the key');
    assert.equal(await post({ authorization: `Bearer ${token}` }), 200);
  });

  it('names the agent for people', () => {
    assert.equal(clientLabel('claude-code 2.1.329'), 'Claude Code');
    assert.equal(clientLabel('cursor 1.2'), 'cursor');
    assert.equal(clientLabel(undefined), 'your coding agent');
  });
});

describe('Users & Data questions go to Claude Code, and the rows stay in the bubble', () => {
  let db: PGlite;
  let server: PGLiteSocketServer;
  before(async () => {
    db = await PGlite.create();
    await db.exec(`CREATE TABLE public.users (id serial PRIMARY KEY, email text, created_at timestamptz DEFAULT now());
      INSERT INTO public.users (email) VALUES ('priya@example.com'), ('sam@example.com');`);
    server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 20 });
    await server.start();
  });
  after(async () => {
    await server?.stop();
    await db?.close();
  });

  it('answers with Hivebubble’s data tools', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-harness-data-'));
    const events: ServerEvent[] = [];
    const s = new Session({
      cwd: dir,
      project: { name: 'app', framework: 'Vite' },
      agent: 'harness',
      log: () => undefined,
      ledger: new SpendLedger(path.join(dir, 'spend.json')),
      data: { env: { HIVEBUBBLE_DATABASE_URL: `postgresql://postgres:postgres@${server.getServerConn()}/postgres` }, timeZone: 'UTC' },
    });
    s.attach({ readyState: 1, OPEN: 1, send: (d: string) => events.push(JSON.parse(d)), on: () => undefined, close: () => undefined } as never);
    const api = (name: string, body: Record<string, unknown> = {}) => s.harnessApi(name, body, 'claude-code', new AbortController().signal) as Promise<any>;
    const last = <T extends ServerEvent['type']>(type: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type).at(-1);

    await s.handle({ type: 'data-ask', question: 'Who signed up?' });
    assert.match(last('data-working')!.message, /Waiting for Claude Code/);
    const { request } = await api('next', { wait: 5 });
    assert.equal(request.kind, 'data');
    assert.match(request.instructions, /data_query/);
    assert.match((await api('data/schema')).text, /public\.users: id integer \(primary key\), email text/);
    const answer = (await api('data/query', { sql: 'SELECT email FROM public.users ORDER BY email', headline: '{count} people signed up' })).text as string;
    assert.match(answer, /Showed 2 rows to the person in the bubble \(columns: email\)/);
    assert.doesNotMatch(answer, /priya|sam@/, 'Claude Code gets counts and column names, not the rows');
    const shown = last('data-result')!;
    assert.deepEqual([shown.headline, shown.question, shown.table.rows], ['2 people signed up', 'Who signed up?', [['priya@example.com'], ['sam@example.com']]]);
    assert.match((await api('data/change', { table: 'public.users', action: 'delete', where: "email = 'sam@example.com'", summary: 'Remove Sam' })).text, /Showed the change to the person: 1 row/);
    assert.equal(last('data-proposal')!.proposal.summary, 'Remove Sam');
    await api('finish', { request_id: request.id, summary: 'Two people signed up: Priya and Sam.' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(last('data-reply')!.text, 'Two people signed up: Priya and Sam.');
    s.stop();
  });
});
