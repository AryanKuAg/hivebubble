import path from 'node:path';
import { hivebubbleHome, readJson, writeJson } from './home.js';
import type { Effort, SpendSummary } from './types.js';

/** List prices in USD per million tokens (Claude API, checked 2026-11-20). */
export interface Price {
  input: number;
  output: number;
  /** Cache writes that live 5 minutes, and 1 hour. */
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
};
const FALLBACK_PRICE = PRICES['claude-opus-5-5'];

/** Token counts as the Messages API reports them on each response. */
export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function usageCost(model: string | undefined, u: Usage): number {
  const p = (model && PRICES[model]) || FALLBACK_PRICE;
  const write1h = count(u.cache_creation?.ephemeral_1h_input_tokens);
  const write5m = Math.max(0, count(u.cache_creation_input_tokens) - write1h);
  return (
    (count(u.input_tokens) * p.input +
      count(u.output_tokens) * p.output +
      write5m * p.cacheWrite5m +
      write1h * p.cacheWrite1h +
      count(u.cache_read_input_tokens) * p.cacheRead) /
    1e6
  );
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The running cost of a task while Claude works, from the usage on each
 * streamed assistant message. The SDK streams one message per content block,
 * all sharing the response's id, so each API response is counted once with
 * its largest numbers. An estimate for the live meter: the result's
 * total_cost_usd is the real figure.
 */
export class CostMeter {
  private readonly turns = new Map<string, { model?: string; usage: Usage }>();

  add(message: { id?: string; model?: string; usage?: Usage | null }): number {
    if (!message.usage || !message.id) return this.total;
    const seen = this.turns.get(message.id);
    const u = message.usage;
    if (!seen) {
      this.turns.set(message.id, { model: message.model, usage: { ...u } });
    } else {
      const s = seen.usage;
      s.input_tokens = Math.max(count(s.input_tokens), count(u.input_tokens));
      s.output_tokens = Math.max(count(s.output_tokens), count(u.output_tokens));
      s.cache_creation_input_tokens = Math.max(count(s.cache_creation_input_tokens), count(u.cache_creation_input_tokens));
      s.cache_read_input_tokens = Math.max(count(s.cache_read_input_tokens), count(u.cache_read_input_tokens));
      if (u.cache_creation) s.cache_creation = u.cache_creation;
    }
    return this.total;
  }

  get total(): number {
    let usd = 0;
    for (const t of this.turns.values()) usd += usageCost(t.model, t.usage);
    return usd;
  }

  tokens(): TokenTotals {
    const t: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const { usage: u } of this.turns.values()) {
      t.input += count(u.input_tokens);
      t.output += count(u.output_tokens);
      t.cacheRead += count(u.cache_read_input_tokens);
      t.cacheWrite += count(u.cache_creation_input_tokens);
    }
    return t;
  }
}

// ---- spending ledger ----------------------------------------------------------

interface Day {
  usd: number;
  tasks: number;
}

interface LedgerFile {
  version: 1;
  days: Record<string, Day>;
}

/** The local calendar day, so "today" means the person's today. */
export function dayKey(when = new Date()): string {
  const m = String(when.getMonth() + 1).padStart(2, '0');
  const d = String(when.getDate()).padStart(2, '0');
  return `${when.getFullYear()}-${m}-${d}`;
}

/**
 * What Claude has cost, per day, across every project on this computer. It
 * lives in Hivebubble's own folder, where the Mac app reads it too.
 */
export class SpendLedger {
  constructor(private readonly file = path.join(hivebubbleHome(), 'spend.json')) {}

  private read(): LedgerFile {
    const data = readJson<LedgerFile>(this.file, { version: 1, days: {} });
    return data && typeof data.days === 'object' && data.days ? data : { version: 1, days: {} };
  }

  add(usd: number, when = new Date()): void {
    if (!(usd > 0)) return;
    const data = this.read();
    const key = dayKey(when);
    const day = data.days[key] ?? { usd: 0, tasks: 0 };
    day.usd = Math.round((day.usd + usd) * 1e6) / 1e6;
    day.tasks += 1;
    data.days[key] = day;
    writeJson(this.file, data);
  }

  summary(dailyCapUsd: number, when = new Date()): SpendSummary {
    const days = this.read().days;
    const today = days[dayKey(when)] ?? { usd: 0, tasks: 0 };
    const month = dayKey(when).slice(0, 7);
    let monthUsd = 0;
    let monthTasks = 0;
    for (const [key, day] of Object.entries(days)) {
      if (!key.startsWith(month)) continue;
      monthUsd += day.usd;
      monthTasks += day.tasks;
    }
    return {
      todayUsd: today.usd,
      todayTasks: today.tasks,
      monthUsd: Math.round(monthUsd * 1e4) / 1e4,
      monthTasks,
      dailyCapUsd,
      remainingUsd: Math.max(0, Math.round((dailyCapUsd - today.usd) * 1e4) / 1e4),
    };
  }
}

// ---- estimates ------------------------------------------------------------------

/**
 * A rough cost range per effort level, used before a project has a history
 * of its own. Real numbers from the router log replace it after a few tasks.
 */
const TYPICAL: Record<Effort, [number, number]> = {
  low: [0.02, 0.15],
  medium: [0.05, 0.4],
  high: [0.15, 1],
  xhigh: [0.4, 2.5],
  max: [0.8, 5],
};

export interface Estimate {
  lowUsd: number;
  highUsd: number;
  /** 'history': from this project's past tasks at this effort; 'typical': a rough guess. */
  basis: 'history' | 'typical';
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function estimateCost(effort: Effort, pastCosts: number[]): Estimate {
  const costs = pastCosts.filter((c) => c > 0).sort((a, b) => a - b);
  if (costs.length >= 3) {
    const round = (n: number) => Math.max(0.01, Math.round(n * 100) / 100);
    return { lowUsd: round(quantile(costs, 0.25)), highUsd: round(quantile(costs, 0.9)), basis: 'history' };
  }
  const [lowUsd, highUsd] = TYPICAL[effort];
  return { lowUsd, highUsd, basis: 'typical' };
}
