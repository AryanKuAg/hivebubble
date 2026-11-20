import type { WebSocket } from 'ws';
import { runClaude } from './agent.js';
import { Checkpoints } from './checkpoints.js';
import { runMock } from './mockAgent.js';
import { buildPrompt } from './prompt.js';
import { routeTask } from './router.js';
import type { AgentKind, ChatEntry, ClientMessage, ProjectSummary, ServerEvent } from './types.js';

export interface SessionOptions {
  cwd: string;
  project: ProjectSummary;
  agent: AgentKind;
  apiKey?: string;
  maxBudgetUsd: number;
  log: (line: string) => void;
}

const MAX_HISTORY = 200;

/**
 * One open project: the chat history, the running task, undo points and every
 * connected bubble (several tabs can be open; they all see the same chat).
 */
export class Session {
  private readonly clients = new Set<WebSocket>();
  private readonly history: ChatEntry[] = [];
  private readonly checkpoints: Checkpoints;
  private busy = false;
  private abort: AbortController | null = null;
  private lastFailed = false;
  private claudeSession: string | undefined;

  constructor(private readonly opts: SessionOptions) {
    this.checkpoints = new Checkpoints(opts.cwd);
  }

  attach(ws: WebSocket): void {
    this.clients.add(ws);
    this.send(ws, {
      type: 'hello',
      project: this.opts.project,
      agent: this.opts.agent,
      busy: this.busy,
      canUndo: this.checkpoints.canUndo(),
      history: this.history,
    });
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      void this.handle(msg);
    });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  async handle(msg: ClientMessage): Promise<void> {
    if (msg.type === 'stop') {
      this.abort?.abort();
      return;
    }
    if (msg.type === 'undo') {
      if (this.busy) {
        this.broadcast({ type: 'error', message: 'Wait for the current task to finish, or press Stop, before undoing.' });
        return;
      }
      const files = this.checkpoints.undo();
      this.claudeSession = undefined; // Claude's memory no longer matches the files.
      this.broadcast({ type: 'undone', files, canUndo: this.checkpoints.canUndo() });
      const text = files.length > 0 ? `Undid the last change (${files.length} file${files.length === 1 ? '' : 's'}).` : 'Nothing to undo.';
      this.remember({ role: 'system', text });
      this.opts.log(text);
      return;
    }
    if (msg.type === 'chat') await this.chat(msg);
  }

  private async chat(msg: Extract<ClientMessage, { type: 'chat' }>): Promise<void> {
    const text = String(msg.text ?? '').trim();
    if (!text) return;
    if (this.busy) {
      this.broadcast({ type: 'error', message: 'Still working on the last request. Press Stop to cancel it.' });
      return;
    }

    const route = routeTask({ text, hasElement: Boolean(msg.element), mode: msg.mode, previousFailed: this.lastFailed });
    this.remember({ role: 'user', text, route });
    this.broadcast({ type: 'user', text, route });
    this.opts.log(`Task (${route.label} · ${route.effort} effort): ${text}`);

    if (this.opts.agent === 'missing-key' || this.opts.agent === 'invalid-key') {
      const summary =
        this.opts.agent === 'invalid-key'
          ? "Anthropic rejected your API key, so Claude can't make changes. Paste a working key in Hivebubble's settings (or ANTHROPIC_API_KEY in .env.local) and restart."
          : "Add your Anthropic API key to start building: open Hivebubble's settings, or put ANTHROPIC_API_KEY in .env.local. Hivebubble can't use a Claude.ai subscription login.";
      this.say(summary);
      this.broadcast({ type: 'done', ok: false, summary, durationMs: 0, canUndo: this.checkpoints.canUndo() });
      return;
    }

    this.busy = true;
    this.abort = new AbortController();
    this.broadcast({ type: 'status', state: 'working' });
    const started = Date.now();
    this.checkpoints.begin();
    const ctx = {
      cwd: this.opts.cwd,
      emit: (e: ServerEvent) => {
        if (e.type === 'say') this.remember({ role: e.role, text: e.text });
        this.broadcast(e);
      },
      checkpoints: this.checkpoints,
      abort: this.abort,
    };

    const result =
      this.opts.agent === 'mock'
        ? await runMock(ctx, { text, element: msg.element })
        : await runClaude(ctx, {
            prompt: buildPrompt(text, msg.element),
            route,
            apiKey: this.opts.apiKey ?? '',
            resume: this.claudeSession,
            maxBudgetUsd: this.opts.maxBudgetUsd,
          });

    this.checkpoints.commit();
    if (result.sessionId) this.claudeSession = result.sessionId;
    // Only a real Claude attempt that failed on its own earns the next try more effort:
    // demo mode can't do most things, and pressing Stop isn't a failure.
    const stopped = this.abort?.signal.aborted ?? false;
    this.lastFailed = !result.ok && this.opts.agent === 'claude' && !stopped;
    this.busy = false;
    this.abort = null;
    const durationMs = Date.now() - started;
    if (!result.ok && !this.history.some((h, i) => i === this.history.length - 1 && h.text === result.summary)) {
      this.remember({ role: 'system', text: result.summary });
    }
    this.broadcast({ type: 'done', ok: result.ok, summary: result.summary, costUsd: result.costUsd, durationMs, canUndo: this.checkpoints.canUndo() });
    this.broadcast({ type: 'status', state: 'idle' });
    const cost = result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(3)}` : '';
    this.opts.log(`${result.ok ? 'Done' : 'Not done'} in ${(durationMs / 1000).toFixed(1)}s${cost}: ${result.summary}`);
  }

  private say(text: string): void {
    this.remember({ role: 'system', text });
    this.broadcast({ type: 'say', role: 'system', text });
  }

  private remember(entry: ChatEntry): void {
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  private send(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  }

  broadcast(event: ServerEvent): void {
    for (const ws of this.clients) this.send(ws, event);
  }

  stop(): void {
    this.abort?.abort();
    for (const ws of this.clients) ws.close();
  }
}
