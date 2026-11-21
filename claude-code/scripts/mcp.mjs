// Hivebubble's MCP server for Claude Code (stdio: one JSON-RPC message per line).
// Requests the person types in Hivebubble's chat bubble come through
// next_request; the coding agent works with its own tools, then calls finish.
// All the work happens in the Hivebubble engine running for this project.
import { createInterface } from 'node:readline';
import { call, findEngine, projectDir } from './engine.mjs';

const VERSION = '0.1.0';
const LATEST_PROTOCOL = '2025-06-18';
let client = 'claude-code';

const TOOLS = [
  {
    name: 'next_request',
    description:
      'Wait for the next thing the person asks for in Hivebubble’s chat bubble on their running site, and return it with everything needed to do it. Call it to start, and again after each finish. If it comes back without a request, call it again.',
    inputSchema: {
      type: 'object',
      properties: { wait_seconds: { type: 'number', description: 'How long to wait for the person, in seconds. Default 600.' } },
    },
  },
  {
    name: 'say',
    description: 'Tell the person, in the bubble, what you are doing or found: one or two short plain sentences. Use it rarely.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'finish',
    description:
      'Finish a request from next_request. summary: one or two short sentences for the person, in plain words (what changed on the page, or one question if it was unclear). For a code change, Hivebubble then checks the page and returns either done or a problem to fix.',
    inputSchema: {
      type: 'object',
      properties: { request_id: { type: 'string' }, summary: { type: 'string' } },
      required: ['request_id', 'summary'],
    },
  },
  {
    name: 'data_schema',
    description: 'The tables and columns of the app’s database (names and types only), for questions in Users & Data.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'data_query',
    description:
      'Run one read-only SELECT and show the rows to the person in the bubble. You get the number of rows and the column names, never the rows. headline: a short answer using {count} (number of rows) or {value} (a single value).',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string' }, headline: { type: 'string' }, explanation: { type: 'string', description: 'One plain sentence: what you looked at.' } },
      required: ['sql', 'headline'],
    },
  },
  {
    name: 'data_change',
    description:
      'Propose a change to the data. The person sees exactly which rows change, before and after, and confirms or cancels it in the bubble. Hivebubble backs the rows up first and can undo it.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'schema.table, e.g. public.profiles' },
        action: { type: 'string', enum: ['update', 'delete', 'insert'] },
        where: { type: 'string', description: 'For update and delete: an SQL condition matching exactly the rows meant.' },
        set: {
          type: 'array',
          description: 'For update: the new values; for insert: the new row. Values are SQL expressions.',
          items: { type: 'object', properties: { column: { type: 'string' }, value: { type: 'string' } }, required: ['column', 'value'] },
        },
        summary: { type: 'string', description: 'The change in plain words, e.g. "Give Priya the pro plan".' },
        explanation: { type: 'string' },
      },
      required: ['table', 'action', 'summary'],
    },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const notRunning = () =>
  `Hivebubble isn't running for ${projectDir()}. Start it for this folder (the Hivebubble app, or pnpm start <folder> in Hivebubble's repo), then call next_request again.`;

function engineOrThrow() {
  const engine = findEngine();
  if (!engine) throw new Error(notRunning());
  return engine;
}

const formatRequest = (req) => `${req.instructions}\n\n(request_id: ${req.id})`;

async function nextRequest(args, signal, progress) {
  const seconds = Math.max(5, Math.min(1500, Number(args.wait_seconds) || 600));
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !signal.aborted) {
    progress();
    const engine = findEngine();
    if (!engine) {
      // Hivebubble may start in a moment: keep looking until the wait is over.
      await sleep(2000, signal);
      continue;
    }
    try {
      const wait = Math.max(1, Math.min(50, Math.ceil((deadline - Date.now()) / 1000)));
      const data = await call(engine, 'next', { wait }, { signal, client });
      if (data.request) return formatRequest(data.request);
      if (data.message) return data.message;
    } catch {
      if (signal.aborted) break;
      await sleep(2000, signal); // It stopped or restarted: look again shortly.
    }
  }
  return findEngine() ? 'Nothing yet: the person hasn’t asked for anything. Call next_request again to keep waiting.' : notRunning();
}

async function runTool(name, args, signal, progress) {
  switch (name) {
    case 'next_request':
      return nextRequest(args, signal, progress);
    case 'say':
      return (await call(engineOrThrow(), 'say', { text: args.text }, { signal, client })).message;
    case 'finish': {
      const data = await call(engineOrThrow(), 'finish', { request_id: args.request_id, summary: args.summary }, { signal, client });
      if (data.outcome === 'fix') return `Hivebubble’s check found a problem with that change.\n\n${formatRequest(data.request)}`;
      return data.message;
    }
    case 'data_schema':
      return (await call(engineOrThrow(), 'data/schema', {}, { signal, client })).text;
    case 'data_query':
      return (await call(engineOrThrow(), 'data/query', args, { signal, client })).text;
    case 'data_change':
      return (await call(engineOrThrow(), 'data/change', args, { signal, client })).text;
    default:
      throw new Error(`No tool named ${name}.`);
  }
}

const inflight = new Map();

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const info = params?.clientInfo;
    if (info?.name) client = `${info.name}${info.version ? ` ${info.version}` : ''}`;
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : LATEST_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'hivebubble', version: VERSION },
        instructions:
          'Hivebubble puts a chat bubble on the person’s running website. What they ask for there comes through next_request; do it with your own tools, then call finish. The /hivebubble:work command starts that loop.',
      },
    });
    return;
  }
  if (method === 'notifications/cancelled') {
    inflight.get(params?.requestId)?.abort();
    return;
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const ac = new AbortController();
    inflight.set(id, ac);
    // Long waits report progress, so the client knows this call is alive.
    const token = params?._meta?.progressToken;
    let ticks = 0;
    let last = Date.now();
    const progress = () => {
      if (token === undefined || Date.now() - last < 20_000) return;
      last = Date.now();
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, message: 'Waiting for the person to ask for something in the bubble' } });
    };
    try {
      const text = await runTool(params?.name, params?.arguments ?? {}, ac.signal, progress);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text ?? '') }] } });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } });
    } finally {
      inflight.delete(id);
    }
    return;
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

const rl = createInterface({ input: process.stdin });
// Claude Code closed: stop now, even in the middle of a wait.
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  void handle(msg);
});
