import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { runClaude, type AgentContext, type AgentRequest, type AgentResult } from './agent.js';
import { CHECK_LABELS, type Checker } from './checks.js';
import { Checkpoints } from './checkpoints.js';
import { SpendLedger, estimateCost } from './cost.js';
import { readSettings } from './home.js';
import { runMock } from './mockAgent.js';
import { buildPrompt, retryPrompt } from './prompt.js';
import { EFFORT_LABELS, routeTask, shiftEffort } from './router.js';
import { RouterLog, type Attempt } from './routerLog.js';
import type {
  AgentKind,
  ChatEntry,
  CheckResult,
  ClientMessage,
  CostEstimate,
  ProjectSummary,
  Route,
  ServerEvent,
  SpendSummary,
} from './types.js';

export interface SessionOptions {
  cwd: string;
  project: ProjectSummary;
  agent: AgentKind;
  apiKey?: string;
  /** The most one task may cost; overrides the saved setting (the --max-budget flag). */
  maxBudgetUsd?: number;
  log: (line: string) => void;
  /** Runs the checks after each task. Without one (tests), tasks end without checks. */
  checker?: Checker | null;
  /** True when the project has no source files of its own yet. */
  isEmpty?: () => boolean;
  ledger?: SpendLedger;
  /** Runs Claude for one attempt; replaced in tests and benchmarks. */
  runClaude?: (ctx: AgentContext, req: AgentRequest) => Promise<AgentResult>;
}

const MAX_HISTORY = 200;
/** How long to let hot reload reach the open page (and its errors come back) before the checks. */
const SETTLE_MS = 800;
const CONFIRM_TIMEOUT_MS = 10 * 60_000;
const CHECK_NAMES: Record<CheckResult['check'], string> = { page: 'page', typecheck: 'type', build: 'build' };

const money = (usd: number) => `$${usd > 0 && usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One open project: the chat history, the running task, undo points, the
 * router's log and every connected bubble (several tabs can be open; they all
 * see the same chat).
 */
export class Session {
  private readonly clients = new Set<WebSocket>();
  private readonly history: ChatEntry[] = [];
  private readonly checkpoints: Checkpoints;
  private readonly routerLog: RouterLog;
  private readonly ledger: SpendLedger;
  private busy = false;
  private abort: AbortController | null = null;
  private lastFailed = false;
  private lastUndone = false;
  private claudeSession: string | undefined;
  private pageErrors: string[] = [];
  private pendingConfirm: { event: Extract<ServerEvent, { type: 'confirm' }>; answer: (ok: boolean) => void } | null = null;
  /** Whether the dev server stamps data-hivebubble-src on elements (set once it has started). */
  sourceTags = false;

  constructor(private readonly opts: SessionOptions) {
    this.checkpoints = new Checkpoints(opts.cwd);
    this.routerLog = new RouterLog(opts.cwd);
    this.ledger = opts.ledger ?? new SpendLedger();
  }

  spend(): SpendSummary {
    return this.ledger.summary(readSettings().dailyCapUsd);
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
      sourceTags: this.sourceTags,
      spend: this.spend(),
    });
    // A reloaded page still gets the open question.
    if (this.pendingConfirm) this.send(ws, this.pendingConfirm.event);
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
    switch (msg.type) {
      case 'stop':
        this.abort?.abort();
        this.pendingConfirm?.answer(false);
        return;
      case 'confirm':
        if (this.pendingConfirm?.event.id === msg.id) this.pendingConfirm.answer(Boolean(msg.ok));
        return;
      case 'page-error':
        if (this.busy && typeof msg.message === 'string') {
          this.pageErrors.push(`${msg.message}${msg.source ? `\n${msg.source}` : ''}`.slice(0, 2000));
          if (this.pageErrors.length > 30) this.pageErrors.shift();
        }
        return;
      case 'undo':
        return this.undo(Boolean(msg.force));
      case 'chat':
        return this.chat(msg);
    }
  }

  private undo(force: boolean): void {
    if (this.busy || this.pendingConfirm) {
      this.broadcast({ type: 'error', message: 'Wait for the current task to finish, or press Stop, before undoing.' });
      return;
    }
    const id = this.checkpoints.history()[0]?.id;
    const { files, conflicts } = this.checkpoints.undo(force);
    if (conflicts.length > 0 && !force) {
      this.broadcast({ type: 'undo-conflict', files: conflicts });
      return;
    }
    if (files.length > 0) {
      this.claudeSession = undefined; // Claude's memory no longer matches the files.
      this.lastUndone = true; // The next request goes one level deeper (README §6).
      if (id) this.routerLog.markUndone(id);
    }
    this.broadcast({ type: 'undone', files, canUndo: this.checkpoints.canUndo() });
    const text = files.length > 0 ? `Undid the last change (${files.length} file${files.length === 1 ? '' : 's'}).` : 'Nothing to undo.';
    this.remember({ role: 'system', text });
    this.opts.log(text);
  }

  private askToConfirm(route: Route, estimate: CostEstimate, spend: SpendSummary): Promise<boolean> {
    return new Promise((resolve) => {
      const event = { type: 'confirm' as const, id: randomUUID(), route, estimate, spend };
      const timer = setTimeout(() => answer(false), CONFIRM_TIMEOUT_MS);
      const answer = (ok: boolean) => {
        clearTimeout(timer);
        if (this.pendingConfirm?.event === event) this.pendingConfirm = null;
        resolve(ok);
      };
      this.pendingConfirm = { event, answer };
      this.broadcast(event);
    });
  }

  private finishEarly(summary: string, ok = false): void {
    this.say(summary);
    this.broadcast({ type: 'done', ok, summary, durationMs: 0, canUndo: this.checkpoints.canUndo() });
  }

  private async chat(msg: Extract<ClientMessage, { type: 'chat' }>): Promise<void> {
    const text = String(msg.text ?? '').trim();
    if (!text) return;
    if (this.busy || this.pendingConfirm) {
      this.broadcast({ type: 'error', message: 'Still working on the last request. Press Stop to cancel it.' });
      return;
    }

    const route = routeTask({
      text,
      hasElement: Boolean(msg.element),
      elementSrc: msg.element?.src,
      mode: msg.mode,
      thinkHarder: Boolean(msg.thinkHarder),
      previousFailed: this.lastFailed,
      previousUndone: this.lastUndone,
      emptyProject: this.opts.isEmpty?.() ?? false,
    });
    this.lastUndone = false;
    this.remember({ role: 'user', text, route });
    this.broadcast({ type: 'user', text, route });
    this.opts.log(`Task (${route.label} · ${route.effort} effort · ${route.signals.join(', ') || 'no signals'}): ${text}`);

    const { agent } = this.opts;
    if (agent === 'missing-key' || agent === 'invalid-key') {
      return this.finishEarly(
        agent === 'invalid-key'
          ? "Anthropic rejected your API key, so Claude can't make changes. Paste a working key in Hivebubble's settings (or ANTHROPIC_API_KEY in .env.local) and restart."
          : "Add your Anthropic API key to start building: open Hivebubble's settings, or put ANTHROPIC_API_KEY in .env.local. Hivebubble can't use a Claude.ai subscription login.",
      );
    }

    const claude = agent === 'claude';
    const settings = readSettings();
    const spend = this.ledger.summary(settings.dailyCapUsd);
    if (claude && spend.remainingUsd < 0.01) {
      this.broadcast({ type: 'paused', spend });
      return this.finishEarly(
        `Paused for today: Claude has cost ${money(spend.todayUsd)} today, which reaches your daily limit of ${money(spend.dailyCapUsd)}. Raise the limit in the Hivebubble app, or come back tomorrow.`,
      );
    }
    if (claude && (route.effort === 'xhigh' || route.effort === 'max')) {
      const estimate = estimateCost(route.effort, this.routerLog.costs(route.effort));
      if (!(await this.askToConfirm(route, estimate, spend))) return this.finishEarly('Okay, the hive stays home. Nothing was changed.');
    }

    const taskCap = this.opts.maxBudgetUsd ?? settings.taskCapUsd;
    this.busy = true;
    this.abort = new AbortController();
    const abort = this.abort;
    this.pageErrors = [];
    this.broadcast({ type: 'status', state: 'working' });
    const started = Date.now();
    const taskId = `${started.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.checkpoints.begin(text, taskId);

    let effort = route.effort;
    let prompt = buildPrompt(text, msg.element);
    let spent = 0;
    let result: AgentResult = { ok: false, summary: 'Stopped.' };
    let checkResults: CheckResult[] | undefined;
    const attempts: Attempt[] = [];

    for (let attempt = 1; ; attempt++) {
      const attemptStarted = Date.now();
      const before = spent;
      const ctx: AgentContext = {
        cwd: this.opts.cwd,
        emit: (e) => {
          if (e.type === 'say') this.remember({ role: e.role, text: e.text });
          // The meter shows the whole task, earlier attempts included.
          this.broadcast(e.type === 'cost' ? { type: 'cost', usd: before + e.usd } : e);
        },
        checkpoints: this.checkpoints,
        abort,
      };
      result =
        agent === 'mock'
          ? await runMock(ctx, { text, element: msg.element })
          : await (this.opts.runClaude ?? runClaude)(ctx, {
              prompt,
              route: { ...route, effort },
              apiKey: this.opts.apiKey ?? '',
              resume: this.claudeSession,
              // Never more than the task's cap, or than what's left of today's limit.
              maxBudgetUsd: Math.max(0.05, Math.min(taskCap - spent, spend.remainingUsd - spent)),
            });
      if (result.sessionId) this.claudeSession = result.sessionId;
      spent += result.costUsd ?? 0;
      attempts.push({ effort, ok: result.ok, costUsd: result.costUsd ?? 0, durationMs: Date.now() - attemptStarted, tokens: result.tokens });
      if (!result.ok || abort.signal.aborted) break;

      const changed = this.checkpoints.touched();
      if (changed.length === 0 || route.checks.length === 0 || !this.opts.checker) {
        checkResults = undefined;
        break;
      }
      await sleep(SETTLE_MS);
      checkResults = await this.opts.checker.run(
        route.checks,
        { changed, pageErrors: [...this.pageErrors], signal: abort.signal },
        {
          onStart: (check) => this.broadcast({ type: 'check', phase: 'start', check, label: CHECK_LABELS[check] }),
          onEnd: (r) => this.broadcast({ type: 'check', phase: 'end', check: r.check, label: CHECK_LABELS[r.check], result: r }),
        },
      );
      const failed = checkResults.filter((r) => !r.ok && !r.skipped);
      if (failed.length === 0 || abort.signal.aborted) break;
      const which = failed.map((f) => CHECK_NAMES[f.check]).join(' and ');
      if (attempt >= 2 || !claude) {
        result = {
          ...result,
          ok: false,
          summary: `Not quite done: the ${which} check still fails. The changes are still there. Press Undo to go back, or tell the hive what to fix.\n\n${failed[0].detail ?? ''}`.trim(),
        };
        break;
      }
      // One retry, one effort level up (README §6).
      effort = shiftEffort(effort, 1);
      const reason = `The ${which} check failed, so the hive tries once more at ${EFFORT_LABELS[effort]} effort.`;
      this.remember({ role: 'system', text: reason });
      this.broadcast({ type: 'retry', route: { ...route, effort, label: EFFORT_LABELS[effort], reason }, reason });
      this.opts.log(reason);
      prompt = retryPrompt(failed);
      this.pageErrors = [];
    }

    const filesChanged = this.checkpoints.touched().length;
    const committed = this.checkpoints.commit();
    const stopped = abort.signal.aborted;
    const ok = result.ok && !stopped;
    // Only a real Claude attempt that failed on its own earns the next try more effort:
    // demo mode can't do most things, and pressing Stop isn't a failure.
    this.lastFailed = !ok && claude && !stopped;
    this.busy = false;
    this.abort = null;
    const durationMs = Date.now() - started;
    if (claude && spent > 0) this.ledger.add(spent);
    this.routerLog.record({
      id: taskId,
      at: new Date(started).toISOString(),
      text,
      kind: route.kind,
      effort: route.effort,
      mode: msg.mode,
      signals: route.signals,
      checks: route.checks,
      attempts,
      checkResults,
      outcome: stopped ? 'stopped' : ok ? 'done' : 'failed',
      filesChanged: committed ? filesChanged : 0,
      costUsd: spent,
      durationMs,
    });
    if (!ok && !this.history.some((h, i) => i === this.history.length - 1 && h.text === result.summary)) {
      this.remember({ role: 'system', text: result.summary });
    }
    this.broadcast({
      type: 'done',
      ok,
      summary: result.summary,
      costUsd: claude ? spent : undefined,
      durationMs,
      canUndo: this.checkpoints.canUndo(),
      checks: checkResults,
      attempts: attempts.length,
    });
    this.broadcast({ type: 'status', state: 'idle' });
    if (claude) this.broadcast({ type: 'spend', spend: this.spend() });
    const cost = claude ? ` · ${money(spent)}` : '';
    const checked = checkResults?.length ? ` · checks: ${checkResults.map((r) => `${r.check} ${r.skipped ? 'skipped' : r.ok ? 'ok' : 'failed'}`).join(', ')}` : '';
    this.opts.log(`${ok ? 'Done' : 'Not done'} in ${(durationMs / 1000).toFixed(1)}s${cost}${checked}: ${result.summary.split('\n')[0]}`);
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
    this.pendingConfirm?.answer(false);
    for (const ws of this.clients) ws.close();
  }
}
