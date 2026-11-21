import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { projectRelative } from './paths.js';
import type { SearchHit, ToolWhere } from './types.js';

/**
 * Where on the page each agent step happens. The bubble gets the lines of a
 * file the agent is reading or changing (and, for stylesheets, the selectors
 * of the rules involved), then flies the bees to the elements drawn by that
 * code. Everything here comes from the real tool calls: nothing is guessed.
 */

export type LineRange = [number, number];

const STYLE_FILE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/i;
const MAX_BYTES = 2_000_000;

export function isStyleFile(file: string): boolean {
  return STYLE_FILE.test(file);
}

/** The file a tool call is about, from its input. */
export function toolFile(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  if (typeof o.file_path === 'string') return o.file_path;
  if (typeof o.notebook_path === 'string') return o.notebook_path;
  if (typeof o.path === 'string') return o.path;
  return undefined;
}

/** A text file's content, or null when it's missing, too big or not readable. */
export function readText(file: string): string | null {
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The 1-based line a character index sits on. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  const stop = Math.min(index, text.length);
  for (let i = 0; i < stop; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** The lines a span of text covers (a trailing newline doesn't count as another line). */
export function spanLines(text: string, index: number, length: number): LineRange {
  const start = lineAt(text, index);
  let end = start;
  const stop = Math.min(text.length, index + length - 1);
  for (let i = index; i < stop; i++) if (text.charCodeAt(i) === 10) end++;
  return [start, end];
}

/**
 * The lines that differ between two versions of a file, found by trimming the
 * lines both share at the start and the end. A pure insertion or deletion
 * gives the one line where it happened.
 */
export function changedLines(before: string, after: string): { before?: LineRange; after?: LineRange } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  if (start === a.length && start === b.length) return {};
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const side = (end: number, total: number): LineRange => {
    const first = Math.max(1, Math.min(start + 1, total));
    return end >= start ? [start + 1, end + 1] : [first, first];
  };
  return { before: side(endA, a.length), after: side(endB, b.length) };
}

interface Hunk {
  newStart: number;
  lines: string[];
}

/**
 * The new-file lines a structured patch (from the Edit and Write tools) really
 * changed, leaving out its context lines. A deletion marks the lines around
 * the gap it left.
 */
export function patchLines(patch: unknown): LineRange | undefined {
  if (!Array.isArray(patch)) return undefined;
  let lo = Infinity;
  let hi = -Infinity;
  const mark = (from: number, to: number) => {
    lo = Math.min(lo, from);
    hi = Math.max(hi, to);
  };
  for (const hunk of patch as Hunk[]) {
    if (!hunk || typeof hunk.newStart !== 'number' || !Array.isArray(hunk.lines)) continue;
    let n = Math.max(1, hunk.newStart);
    // Removed lines followed by added ones are a replacement (the added lines
    // mark it); removed lines on their own leave a gap between two lines.
    let removedAt: number | null = null;
    const flush = () => {
      if (removedAt !== null) mark(Math.max(1, removedAt - 1), removedAt);
      removedAt = null;
    };
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) {
        removedAt = null;
        mark(n, n);
        n++;
      } else if (line.startsWith('-')) {
        removedAt ??= n;
      } else if (!line.startsWith('\\')) {
        flush();
        n++;
      }
    }
    flush();
  }
  return lo <= hi ? [lo, hi] : undefined;
}

// ---- stylesheets -------------------------------------------------------------

export interface CssRule {
  /** The full selector list, with nesting resolved (`.menu { li {} }` gives `.menu li`). */
  selectors: string[];
  start: number;
  end: number;
}

/** At-rules whose blocks hold something other than rules (keyframe steps, font descriptors…). */
const OPAQUE_AT_RULE = /^(?:-[a-z]+-)?(?:keyframes|font-face|page|property|counter-style|font-feature-values|font-palette-values|view-transition)$/i;

function splitList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out.filter(Boolean);
}

function nest(parents: string[] | null, own: string[]): string[] {
  if (!parents) return own;
  const out: string[] = [];
  for (const p of parents) {
    for (const c of own) out.push(c.includes('&') ? c.replaceAll('&', p) : `${p} ${c}`);
    if (out.length > 24) break;
  }
  return out;
}

/** A small, forgiving CSS/SCSS/Less reader: rule blocks with their selectors and lines. */
export function cssRules(css: string): CssRule[] {
  type Frame = { kind: 'rule' | 'at' | 'opaque'; selectors: string[] | null; rule?: CssRule };
  const rules: CssRule[] = [];
  const stack: Frame[] = [];
  let prelude = '';
  let preludeLine = 1;
  let line = 1;
  const parentSelectors = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === 'rule') return stack[i].selectors;
    return null;
  };
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const stop = close === -1 ? css.length : close + 2;
      for (let j = i; j < stop; j++) if (css.charCodeAt(j) === 10) line++;
      i = stop - 1;
      continue;
    }
    // `//` comments (Sass, Less), but not the `//` inside url(http://…).
    if (ch === '/' && css[i + 1] === '/' && !/url\([^)]*$/i.test(prelude)) {
      const close = css.indexOf('\n', i);
      i = (close === -1 ? css.length : close) - 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch && css[j] !== '\n') j += css[j] === '\\' ? 2 : 1;
      if (!prelude.trim()) preludeLine = line;
      const closed = css[j] === ch;
      prelude += css.slice(i, closed ? j + 1 : j);
      // An unclosed string ends at the line break, which the loop then counts.
      i = closed ? j : j - 1;
      continue;
    }
    if (ch === '\n') line++;
    if (ch === '{') {
      const text = prelude.trim().replace(/\s+/g, ' ');
      const inOpaque = stack.some((f) => f.kind === 'opaque');
      if (text.startsWith('@')) {
        const name = text.slice(1).split(/[\s({]/)[0];
        stack.push({ kind: inOpaque || OPAQUE_AT_RULE.test(name) ? 'opaque' : 'at', selectors: null });
      } else if (inOpaque || !text) {
        stack.push({ kind: 'opaque', selectors: null });
      } else {
        const rule: CssRule = { selectors: nest(parentSelectors(), splitList(text)), start: preludeLine, end: line };
        rules.push(rule);
        stack.push({ kind: 'rule', selectors: rule.selectors, rule });
      }
      prelude = '';
    } else if (ch === '}') {
      const frame = stack.pop();
      if (frame?.rule) frame.rule.end = line;
      prelude = '';
    } else if (ch === ';') {
      prelude = '';
    } else {
      if (!prelude.trim() && ch.trim()) preludeLine = line;
      prelude += ch;
    }
  }
  for (const frame of stack) if (frame.rule) frame.rule.end = line;
  return rules;
}

/** Pseudo-classes and pseudo-elements that only apply in some states; removed so the page can match the element itself. */
const STATEFUL_PSEUDO =
  /::?-?[a-z-]*(?:before|after|placeholder|selection|marker|backdrop|first-line|first-letter|file-selector-button|scrollbar[a-z-]*|thumb|track|cue)(?:\([^)]*\))?|:(?:hover|focus|focus-visible|focus-within|active|visited|link|any-link|target|checked|disabled|enabled|indeterminate|invalid|valid|in-range|out-of-range|required|optional|read-only|read-write|placeholder-shown|autofill|default|user-invalid|user-valid|open|popover-open|modal|fullscreen|playing|paused)(?![\w-])(?:\([^)]*\))?/gi;

/** A selector the page can look up with querySelectorAll, or null when nothing useful is left. */
export function pageSelector(selector: string): string | null {
  const cleaned = selector
    .replace(STATEFUL_PSEUDO, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([>+~])\s*$/, '')
    .trim();
  if (!cleaned || /^[>+~]/.test(cleaned) || cleaned.includes('&') || /^(?:from|to|\d+%)$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * Selectors of the rules a line range touches (the innermost rules first), or
 * of the whole stylesheet when no range is given.
 */
export function cssSelectors(css: string, lines?: LineRange, limit = 6): string[] {
  let rules = cssRules(css);
  if (lines) {
    const [a, b] = lines;
    rules = rules.filter((r) => r.start <= b && r.end >= a).sort((x, y) => x.end - x.start - (y.end - y.start));
  }
  const out: string[] = [];
  for (const rule of rules) {
    for (const s of rule.selectors) {
      const sel = pageSelector(s);
      if (sel && !out.includes(sel)) out.push(sel);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ---- searches -------------------------------------------------------------

/** Where a Grep found matches, from its result: files and, in content mode, lines. */
export function grepHits(cwd: string, input: unknown, response: unknown, limit = 4): SearchHit[] {
  if (!response || typeof response !== 'object') return [];
  const r = response as { content?: unknown; filenames?: unknown };
  const searched = toolFile(input);
  const hits: SearchHit[] = [];
  const add = (file: string, line?: number) => {
    const rel = projectRelative(cwd, file);
    if (!rel || hits.some((h) => h.file === rel && h.line === line)) return;
    hits.push(line ? { file: rel, line } : { file: rel });
  };
  if (typeof r.content === 'string') {
    for (const row of r.content.split('\n')) {
      if (hits.length >= limit) break;
      // `path:line:text` for a match (context rows use `path-line-text`); a single-file search leaves the path out.
      const m = row.match(/^(.+?):(\d+):/) ?? row.match(/^()(\d+):/);
      if (!m) continue;
      const file = m[1] || (searched && path.extname(searched) ? searched : '');
      if (file) add(file, Number(m[2]));
    }
  }
  if (hits.length === 0 && Array.isArray(r.filenames)) {
    for (const f of r.filenames) {
      if (hits.length >= limit) break;
      if (typeof f === 'string') add(f);
    }
  }
  return hits;
}

// ---- tool calls -------------------------------------------------------------

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function withSelectors(file: string, text: string | null, lines: LineRange | undefined): ToolWhere {
  const where: ToolWhere = lines ? { lines } : {};
  if (text !== null && isStyleFile(file)) {
    const selectors = cssSelectors(text, lines);
    if (selectors.length > 0) where.selectors = selectors;
  }
  return where;
}

/**
 * Works out where each tool call lands. `start` runs before the tool (so for
 * an edit it describes the code as the page shows it now) and `end` after it
 * (the changed code, as the page will show it after hot reload).
 */
export class Locator {
  /** Where an edit's old text was, by tool call, so the end of the edit can find the new text in the same place. */
  private readonly editAt = new Map<string, number>();

  constructor(private readonly cwd: string) {}

  start(id: string, tool: string, input: unknown): ToolWhere {
    const rel = toolFile(input);
    if (!rel) return {};
    const file = path.resolve(this.cwd, rel);
    const o = input as Record<string, unknown>;
    switch (tool) {
      case 'Read': {
        const offset = num(o.offset);
        const limit = num(o.limit);
        const lines: LineRange | undefined = offset || limit ? [offset ?? 1, (offset ?? 1) + (limit ?? 2000) - 1] : undefined;
        return withSelectors(file, isStyleFile(file) ? readText(file) : null, lines);
      }
      case 'Edit': {
        const text = readText(file);
        const old = str(o.old_string);
        if (text === null || !old) return {};
        const at = text.indexOf(old);
        if (at === -1) return {};
        this.editAt.set(id, at);
        return withSelectors(file, text, spanLines(text, at, old.length));
      }
      case 'Write': {
        const text = readText(file);
        const content = str(o.content);
        if (text === null || content === undefined) return {};
        return withSelectors(file, text, changedLines(text, content).before);
      }
      default:
        return {};
    }
  }

  end(id: string, tool: string, input: unknown, response: unknown): ToolWhere {
    const at = this.editAt.get(id);
    this.editAt.delete(id);
    if (tool === 'Grep') {
      const hits = grepHits(this.cwd, input, response);
      return hits.length > 0 ? { hits } : {};
    }
    if (tool !== 'Edit' && tool !== 'Write') return {};
    const rel = toolFile(input);
    if (!rel) return {};
    const file = path.resolve(this.cwd, rel);
    const o = input as Record<string, unknown>;
    const text = readText(file);
    let lines = patchLines((response as { structuredPatch?: unknown } | null)?.structuredPatch);
    if (!lines && text !== null) {
      const next = str(o.new_string);
      if (tool === 'Edit' && at !== undefined && next !== undefined) lines = spanLines(text, at, next.length);
    }
    return withSelectors(file, text, lines);
  }

  forget(id: string): void {
    this.editAt.delete(id);
  }
}

/** Parse a `file:line:column` source tag (column optional). */
export function parseSourceTag(src: string | undefined): { file: string; line: number; column?: number } | null {
  if (!src) return null;
  const m = src.match(/^(.+?):(\d+)(?::(\d+))?$/);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined };
}
