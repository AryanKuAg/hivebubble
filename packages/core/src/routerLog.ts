import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { projectDataDir } from './home.js';
import type { Check, CheckResult, Effort, Mode, TaskKind } from './types.js';
import type { TokenTotals } from './cost.js';

/**
 * The router's learning log (README §6): one line per task in
 * `.hivebubble/router-log.jsonl` with what the router saw, what it chose and
 * how it went. It stays on this computer. Estimates for big tasks come from
 * it, and its outcomes are what the rules get tuned with.
 */

export interface Attempt {
  effort: Effort;
  ok: boolean;
  costUsd: number;
  durationMs: number;
  tokens?: TokenTotals;
}

export interface TaskRecord {
  id: string;
  at: string;
  text: string;
  kind: TaskKind;
  effort: Effort;
  mode?: Mode;
  signals: string[];
  checks: Check[];
  attempts: Attempt[];
  checkResults?: CheckResult[];
  /** done: finished and every check passed; failed: the agent or a check failed; stopped: Stop was pressed. */
  outcome: 'done' | 'failed' | 'stopped';
  filesChanged: number;
  costUsd: number;
  durationMs: number;
}

type Line = TaskRecord | { event: 'undone'; id: string; at: string };

export class RouterLog {
  private readonly file: string;

  constructor(private readonly root: string) {
    this.file = path.join(root, '.hivebubble', 'router-log.jsonl');
  }

  private append(line: Line): void {
    try {
      projectDataDir(this.root);
      appendFileSync(this.file, `${JSON.stringify(line)}\n`);
    } catch {
      // The log helps tuning; a task never fails because of it.
    }
  }

  record(task: TaskRecord): void {
    this.append({ ...task, text: task.text.slice(0, 300) });
  }

  markUndone(id: string): void {
    this.append({ event: 'undone', id, at: new Date().toISOString() });
  }

  private lines(): Line[] {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out: Line[] = [];
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        out.push(JSON.parse(raw) as Line);
      } catch {
        // Skip a damaged line.
      }
    }
    return out;
  }

  /** What past tasks at this effort cost, when they finished and weren't undone (for estimates). */
  costs(effort: Effort, limit = 50): number[] {
    const lines = this.lines();
    const undone = new Set(lines.filter((l): l is Extract<Line, { event: 'undone' }> => 'event' in l).map((l) => l.id));
    return lines
      .filter((l): l is TaskRecord => !('event' in l) && l.effort === effort && l.outcome === 'done' && !undone.has(l.id))
      .slice(-limit)
      .map((t) => t.costUsd);
  }
}
