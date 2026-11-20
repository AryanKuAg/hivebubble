import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManagedProcess } from './processes.js';
import type { ProjectInfo } from './project.js';
import type { Check, CheckResult } from './types.js';

/**
 * The checks after a task (README §5, step 6). Each one says plainly what
 * failed, so the bubble can show it and Claude can fix it on the retry. Slow
 * checks compare against a baseline taken when the project opened, so errors
 * that were already there never count against a task.
 */

export const CHECK_LABELS: Record<Check, string> = {
  page: 'Checking the page',
  typecheck: 'Checking types',
  build: 'Trying a production build',
};

/** Files the dev server compiles into modules the page loads. */
const MODULE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|sass|less|styl|pcss|postcss)$/i;
const TS_FILE = /\.(?:[cm]?tsx?|vue|svelte)$/i;
const MAX_DETAIL = 1600;
const TYPECHECK_MS = 120_000;
const BUILD_MS = 180_000;

export interface CheckRun {
  /** Files the task changed (relative to the project) that still exist. */
  changed: string[];
  /** Errors the open page reported while the task ran. */
  pageErrors: string[];
  signal: AbortSignal;
}

export interface CheckHooks {
  onStart(check: Check): void;
  onEnd(result: CheckResult): void;
}

function short(text: string, max = MAX_DETAIL): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The compile error Vite puts in its 500 page (`const error = {"message": …}`). */
export function viteErrorMessage(body: string): string | null {
  const m = body.match(/"message":"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

export interface TsError {
  file: string;
  line: number;
  code: string;
  message: string;
}

/** `src/App.tsx(12,5): error TS2322: Type …` lines from tsc --pretty false. */
export function parseTscErrors(output: string): TsError[] {
  const out: TsError[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/);
    if (m) out.push({ file: m[1].trim().split(path.sep).join('/'), line: Number(m[2]), code: m[3], message: m[4].trim() });
  }
  return out;
}

/** An error's identity without its line number, which shifts as code is edited. */
const errorKey = (e: TsError) => `${e.file}|${e.code}|${e.message}`;

function readTsconfig(file: string): { references?: Array<{ path: string }> } | null {
  try {
    // tsconfig allows comments and trailing commas.
    const text = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bin(info: ProjectInfo, name: string): string | null {
  const file = path.join(info.dir, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  return existsSync(file) ? file : null;
}

/** The tsconfig files to check: the project's references when its root config only points at others. */
export function typecheckConfigs(dir: string): string[] {
  const root = path.join(dir, 'tsconfig.json');
  const config = readTsconfig(root);
  if (!config) return [];
  const refs = (config.references ?? [])
    .map((r) => path.resolve(dir, r.path))
    .map((p) => (p.endsWith('.json') ? p : path.join(p, 'tsconfig.json')))
    .filter((p) => existsSync(p));
  return refs.length > 0 ? refs : [root];
}

interface Ran {
  code: number | null;
  output: string;
  timedOut: boolean;
}

async function runTool(cmd: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Ran> {
  const lines: string[] = [];
  const proc = new ManagedProcess({ cmd, args, env: { CI: '1' } }, cwd, (line) => {
    lines.push(line);
    if (lines.length > 400) lines.shift();
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void proc.stop();
  }, timeoutMs);
  const onAbort = () => void proc.stop();
  signal?.addEventListener('abort', onAbort, { once: true });
  const code = await proc.exited;
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  return { code, output: lines.join('\n'), timedOut };
}

export class Checker {
  private typeBaseline: Promise<Set<string> | null> | null = null;
  private buildBaseline: Promise<boolean | null> | null = null;

  constructor(
    private readonly info: ProjectInfo,
    private readonly devPort: () => number | null,
    private readonly log: (line: string) => void,
  ) {}

  get canTypecheck(): boolean {
    return existsSync(path.join(this.info.dir, 'tsconfig.json')) && bin(this.info, 'tsc') !== null;
  }

  /** Vite projects only for now: building next to a running `next dev` would fight over `.next`. */
  get canBuild(): boolean {
    return this.info.framework === 'vite' && bin(this.info, 'vite') !== null;
  }

  /** Take the slow baselines in the background once the dev server is up. */
  warmUp(): void {
    if (this.canTypecheck) this.typeBaseline ??= this.typeErrors().then((r) => (r ? new Set(r.errors.map(errorKey)) : null));
    if (this.canBuild) {
      this.buildBaseline ??= this.build().then((r) => {
        if (!r.ok) this.log('The production build was already failing when the project opened, so build checks are off for now.');
        return r.ok;
      });
    }
  }

  async run(checks: Check[], run: CheckRun, hooks: CheckHooks): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const check of checks) {
      if (run.signal.aborted) break;
      const blocked = results.find((r) => !r.ok && !r.skipped);
      const started = Date.now();
      hooks.onStart(check);
      let result: CheckResult;
      try {
        result = blocked
          ? { check, ok: true, skipped: `the ${blocked.check} check failed first`, durationMs: 0 }
          : await this.one(check, run);
      } catch (err) {
        result = { check, ok: true, skipped: `it could not run (${err instanceof Error ? err.message : String(err)})`, durationMs: 0 };
      }
      result.durationMs = Date.now() - started;
      hooks.onEnd(result);
      results.push(result);
    }
    return results;
  }

  private one(check: Check, run: CheckRun): Promise<CheckResult> {
    if (check === 'page') return this.pageCheck(run);
    if (check === 'typecheck') return this.typeCheck(run);
    return this.buildCheck(run);
  }

  // ---- page: the dev server compiles every changed file, the page shows no new errors ----

  private async pageCheck(run: CheckRun): Promise<CheckResult> {
    const port = this.devPort();
    if (port === null) return { check: 'page', ok: true, skipped: 'the dev server is not running', durationMs: 0 };
    const base = `http://localhost:${port}`;
    const problems: string[] = [];
    const modules = this.info.framework === 'vite' ? run.changed.filter((f) => MODULE_FILE.test(f)) : [];
    for (const file of modules) {
      const res = await fetch(`${base}/${file.split('/').map(encodeURIComponent).join('/')}`, { signal: run.signal });
      const body = await res.text();
      if (res.status >= 500) problems.push(`${file} does not compile: ${viteErrorMessage(body) ?? short(body, 400)}`);
    }
    const page = await fetch(base, { signal: run.signal, redirect: 'manual' });
    if (page.status >= 500) problems.push(`The page itself fails to load (HTTP ${page.status}): ${short(await page.text(), 400)}`);
    // Runtime errors the open page reported, when they come from the changed files.
    const names = run.changed.map((f) => f.split('/').pop()!).filter(Boolean);
    for (const error of run.pageErrors) {
      if (names.some((n) => error.includes(n))) problems.push(`The page shows an error: ${short(error, 400)}`);
    }
    return problems.length > 0
      ? { check: 'page', ok: false, detail: short(problems.join('\n')), durationMs: 0 }
      : { check: 'page', ok: true, durationMs: 0 };
  }

  // ---- typecheck: no new TypeScript errors ----

  private async typeErrors(signal?: AbortSignal): Promise<{ errors: TsError[]; output: string } | null> {
    const tsc = bin(this.info, 'tsc');
    if (!tsc) return null;
    const errors: TsError[] = [];
    let output = '';
    for (const config of typecheckConfigs(this.info.dir)) {
      const r = await runTool(tsc, ['--noEmit', '--pretty', 'false', '-p', config], this.info.dir, TYPECHECK_MS, signal);
      if (r.timedOut || signal?.aborted) return null;
      errors.push(...parseTscErrors(r.output));
      output += r.output;
    }
    return { errors, output };
  }

  private async typeCheck(run: CheckRun): Promise<CheckResult> {
    if (!this.canTypecheck) return { check: 'typecheck', ok: true, skipped: 'the project does not use TypeScript', durationMs: 0 };
    if (!run.changed.some((f) => TS_FILE.test(f))) return { check: 'typecheck', ok: true, skipped: 'no TypeScript file changed', durationMs: 0 };
    const baseline = this.typeBaseline ? await this.typeBaseline : null;
    const now = await this.typeErrors(run.signal);
    if (!now) return { check: 'typecheck', ok: true, skipped: 'TypeScript took too long', durationMs: 0 };
    // New errors only: compared with the baseline, or else limited to the changed files.
    const fresh = baseline
      ? now.errors.filter((e) => !baseline.has(errorKey(e)))
      : now.errors.filter((e) => run.changed.some((f) => e.file.endsWith(f)));
    if (fresh.length === 0) {
      this.typeBaseline = Promise.resolve(new Set(now.errors.map(errorKey)));
      return { check: 'typecheck', ok: true, durationMs: 0 };
    }
    const lines = fresh.slice(0, 12).map((e) => `${e.file}:${e.line}: ${e.code} ${e.message}`);
    if (fresh.length > 12) lines.push(`…and ${fresh.length - 12} more.`);
    return { check: 'typecheck', ok: false, detail: short(`TypeScript found ${fresh.length} new error${fresh.length === 1 ? '' : 's'}:\n${lines.join('\n')}`), durationMs: 0 };
  }

  // ---- build: the production build still works ----

  private async build(signal?: AbortSignal): Promise<{ ok: boolean; output: string; timedOut: boolean }> {
    const vite = bin(this.info, 'vite');
    if (!vite) return { ok: false, output: 'vite is not installed', timedOut: false };
    // Outside the project: Vite reloads the open page when an .html file inside it changes.
    const out = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-build-'));
    try {
      const r = await runTool(vite, ['build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'], this.info.dir, BUILD_MS, signal);
      return { ok: r.code === 0 && !r.timedOut, output: r.output, timedOut: r.timedOut };
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }

  private async buildCheck(run: CheckRun): Promise<CheckResult> {
    if (!this.canBuild) return { check: 'build', ok: true, skipped: 'build checks only run for Vite projects so far', durationMs: 0 };
    const baseline = this.buildBaseline ? await this.buildBaseline : null;
    if (baseline === false) return { check: 'build', ok: true, skipped: 'the build was already failing before this task', durationMs: 0 };
    const r = await this.build(run.signal);
    if (r.timedOut) return { check: 'build', ok: true, skipped: 'the build took more than 3 minutes', durationMs: 0 };
    if (r.ok) {
      this.buildBaseline = Promise.resolve(true);
      return { check: 'build', ok: true, durationMs: 0 };
    }
    const tail = r.output.split('\n').filter((l) => l.trim()).slice(-25).join('\n');
    return { check: 'build', ok: false, detail: short(`The production build failed:\n${tail}`), durationMs: 0 };
  }
}
