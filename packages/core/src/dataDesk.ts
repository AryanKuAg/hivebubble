import Anthropic from '@anthropic-ai/sdk';
import { claudeAsker, demoAsker, fillHeadline, type Asker } from './dataAsk.js';
import { applyChange, backupsDir, listChanges, prepareChange, proposalView, undoChange, type Proposal } from './dataChanges.js';
import { DataError, describeDatabase, findDatabase, friendlyDbError, loadSchema, localTimeZone, runReadOnly, schemaText, type Schema } from './db.js';
import { readSettings } from './home.js';
import { authActivity, groupErrors, type ErrorLog } from './logs.js';
import type { SpendLedger } from './cost.js';
import type { AgentKind, ClientMessage, ServerEvent } from './types.js';

export interface DataDeskOptions {
  projectDir: string;
  agent: AgentKind;
  apiKey?: string;
  ledger: SpendLedger;
  errorLog: ErrorLog;
  emit: (e: ServerEvent) => void;
  log: (line: string) => void;
  /** Where HIVEBUBBLE_DATABASE_URL and HIVEBUBBLE_APP come from (tests pass their own). */
  env?: NodeJS.ProcessEnv;
  /** Replaces Claude (tests). */
  asker?: Asker;
  timeZone?: string;
}

type DataMessage = Extract<ClientMessage, { type: `data-${string}` }>;

const PROPOSAL_TTL_MS = 15 * 60_000;
const SCHEMA_TTL_MS = 60_000;
const money = (usd: number) => `$${usd > 0 && usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`;

/**
 * Users & Data for one project (README §10): questions, previewed changes
 * with backups and Undo, and the logs summary. One request at a time.
 */
export class DataDesk {
  private schema: { url: string; at: number; schema: Schema } | null = null;
  private readonly proposals = new Map<string, Proposal>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: DataDeskOptions) {}

  private get env(): NodeJS.ProcessEnv {
    return this.o.env ?? process.env;
  }

  private get timeZone(): string {
    return this.o.timeZone ?? localTimeZone();
  }

  handle(msg: DataMessage): Promise<void> {
    const run = async () => {
      try {
        switch (msg.type) {
          case 'data-info':
            return await this.info();
          case 'data-ask':
            return await this.ask(String(msg.question ?? ''));
          case 'data-run':
            return await this.run(String(msg.sql ?? ''));
          case 'data-apply':
            return await this.apply(String(msg.id ?? ''), msg.word);
          case 'data-cancel':
            this.proposals.delete(String(msg.id ?? ''));
            return;
          case 'data-changes':
            return this.changes();
          case 'data-undo':
            return await this.undo(String(msg.id ?? ''), Boolean(msg.force));
          case 'data-logs':
            return await this.logs();
        }
      } catch (err) {
        this.o.emit({ type: 'data-error', message: this.explain(err) });
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private explain(err: unknown): string {
    if (err instanceof DataError) return err.message;
    if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected your API key. Fix it in Hivebubble’s settings, then restart.';
    if (err instanceof Anthropic.RateLimitError) return 'Claude is busy right now (rate limit). Try again in a minute.';
    if (err instanceof Anthropic.APIConnectionError) return 'Couldn’t reach Claude. Check your internet connection.';
    if (err instanceof Anthropic.APIError) return `Claude couldn’t answer: ${err.message}`;
    return friendlyDbError(err).message;
  }

  private source() {
    return findDatabase(this.o.projectDir, this.env);
  }

  private needSource() {
    const src = this.source();
    if (!src) throw new DataError('Connect a database first.');
    return src;
  }

  private async getSchema(url: string, fresh = false): Promise<Schema> {
    if (!fresh && this.schema && this.schema.url === url && Date.now() - this.schema.at < SCHEMA_TTL_MS) return this.schema.schema;
    const schema = await loadSchema(url);
    this.schema = { url, at: Date.now(), schema };
    return schema;
  }

  private async info(): Promise<void> {
    const base = {
      canAsk: this.o.agent === 'claude' || this.o.agent === 'mock' || Boolean(this.o.asker),
      demo: this.o.agent === 'mock',
      app: this.env.HIVEBUBBLE_APP === '1',
    };
    const src = this.source();
    if (!src) {
      this.o.emit({ type: 'data-info', connected: false, ...base });
      return;
    }
    const db = describeDatabase(src.url);
    try {
      const schema = await this.getSchema(src.url, true);
      this.o.emit({ type: 'data-info', connected: true, from: src.from, db, tables: schema.tables.length, ...base });
    } catch (err) {
      this.o.emit({ type: 'data-info', connected: false, from: src.from, db, problem: this.explain(err), ...base });
    }
  }

  private asker(schema: Schema): Asker {
    if (this.o.asker) return this.o.asker;
    if (this.o.agent === 'mock') return demoAsker(() => schema);
    if (this.o.agent === 'claude' && this.o.apiKey) return claudeAsker(this.o.apiKey);
    throw new DataError(
      this.o.agent === 'invalid-key'
        ? 'Anthropic rejected your API key, so questions in plain words can’t be answered. Fix the key in Hivebubble’s settings and restart.'
        : 'Questions in plain words need your Anthropic API key. Add it in Hivebubble’s settings, or put ANTHROPIC_API_KEY in .env.local.',
    );
  }

  private async ask(raw: string): Promise<void> {
    const question = raw.trim().slice(0, 2000);
    if (!question) return;
    const src = this.needSource();
    const claude = !this.o.asker && this.o.agent === 'claude';
    if (claude) {
      const spend = this.o.ledger.summary(readSettings().dailyCapUsd);
      if (spend.remainingUsd < 0.01) throw new DataError(`Paused for today: Claude has cost ${money(spend.todayUsd)} today, which reaches your daily limit of ${money(spend.dailyCapUsd)}.`);
    }
    this.o.emit({ type: 'data-working', message: 'Reading your tables…' });
    const schema = await this.getSchema(src.url);
    const asker = this.asker(schema);
    this.o.emit({ type: 'data-working', message: claude ? 'Claude is working out the question…' : 'Working out the question…' });
    const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: this.timeZone });
    const { answer, costUsd } = await asker({ question, schema: schemaText(schema), today, timeZone: this.timeZone });
    if (costUsd > 0) {
      this.o.ledger.add(costUsd);
      this.o.emit({ type: 'spend', spend: this.o.ledger.summary(readSettings().dailyCapUsd) });
    }
    const cost = costUsd > 0 ? costUsd : undefined;
    if (answer.kind === 'unclear') {
      this.o.emit({ type: 'data-reply', question, text: answer.reply, costUsd: cost });
      return;
    }
    if (answer.kind === 'change') {
      this.o.emit({ type: 'data-working', message: 'Finding the rows it would change…' });
      const proposal = await prepareChange(src.url, schema, answer.plan, { question, timeZone: this.timeZone });
      this.prune();
      this.proposals.set(proposal.id, proposal);
      this.o.emit({ type: 'data-proposal', question, explanation: answer.explanation, proposal: proposalView(proposal), costUsd: cost });
      return;
    }
    this.o.emit({ type: 'data-working', message: 'Asking the database…' });
    try {
      const result = await runReadOnly(src.url, answer.sql, { timeZone: this.timeZone });
      this.o.emit({
        type: 'data-result',
        question,
        sql: answer.sql,
        headline: fillHeadline(answer.headline, result),
        explanation: answer.explanation,
        table: { columns: result.columns, rows: result.rows, truncated: result.truncated },
        ms: result.ms,
        costUsd: cost,
      });
    } catch (err) {
      throw new DataError(`${this.explain(err)}\n\nThe query was:\n${answer.sql}`);
    }
  }

  private async run(sql: string): Promise<void> {
    const src = this.needSource();
    this.o.emit({ type: 'data-working', message: 'Asking the database…' });
    const result = await runReadOnly(src.url, sql, { timeZone: this.timeZone });
    const n = result.truncated ? `${result.rows.length}+` : String(result.rows.length);
    this.o.emit({ type: 'data-result', sql, headline: `${n} row${n === '1' ? '' : 's'}.`, table: { columns: result.columns, rows: result.rows, truncated: result.truncated }, ms: result.ms });
  }

  private prune(): void {
    for (const [id, p] of this.proposals) if (Date.now() - p.createdAt > PROPOSAL_TTL_MS) this.proposals.delete(id);
  }

  private async apply(id: string, word?: string): Promise<void> {
    const src = this.needSource();
    this.prune();
    const proposal = this.proposals.get(id);
    if (!proposal) throw new DataError('This preview is too old. Ask again to see the rows as they are now.');
    this.o.emit({ type: 'data-working', message: 'Saving a backup, then making the change…' });
    const change = await applyChange(src.url, proposal, { dir: backupsDir(this.o.projectDir), word, timeZone: this.timeZone });
    this.proposals.delete(id);
    this.o.log(`Changed data: ${change.summary} (${change.count} row${change.count === 1 ? '' : 's'} in ${change.table}, backup ${change.id}).`);
    this.o.emit({ type: 'data-applied', change });
    this.changes();
  }

  private changes(): void {
    this.o.emit({ type: 'data-changes', changes: listChanges(backupsDir(this.o.projectDir)) });
  }

  private async undo(id: string, force: boolean): Promise<void> {
    const src = this.needSource();
    this.o.emit({ type: 'data-working', message: 'Putting the rows back…' });
    const schema = await this.getSchema(src.url, true);
    const result = await undoChange(src.url, schema, { dir: backupsDir(this.o.projectDir), id, force, timeZone: this.timeZone });
    if (result.ok) {
      this.o.log(`Undid the data change: ${result.item.summary}.`);
      this.o.emit({ type: 'data-undo-result', id, ok: true, message: `Undone: ${result.item.summary}.`, change: result.item });
      this.changes();
    } else {
      this.o.emit({ type: 'data-undo-result', id, ok: false, message: result.message, canForce: result.canForce });
    }
  }

  private async logs(): Promise<void> {
    const groups = groupErrors(this.o.errorLog.read(), this.o.projectDir);
    const src = this.source();
    let auth = null;
    let authProblem: string | undefined;
    if (src) {
      try {
        auth = await authActivity(src.url, this.timeZone);
      } catch (err) {
        authProblem = this.explain(err);
      }
    }
    this.o.emit({ type: 'data-logs', groups, auth, authProblem });
  }
}
