import { existsSync, readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { AgentContext, AgentResult } from './agent.js';
import { lineAt, parseSourceTag, spanLines } from './locate.js';
import { insideProject, projectRelative } from './paths.js';
import type { PickedElement, ToolAction, ToolEvent } from './types.js';

/**
 * Demo mode: a tiny local stand-in for Claude, used for tests, demos and for
 * trying Hivebubble without an API key. It can do exactly one thing for real:
 * change the text of a picked element ("change the text to "…""). Every step
 * it takes is a real file search, read or edit, reported with the same lines
 * and search hits as Claude's, so the bee cursors and undo behave exactly as
 * they do with Claude. Like Claude, it skips the search when the picked
 * element has a source tag.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.astro', 'coverage', '.hivebubble', '.turbo', '.vercel']);
const SOURCE_EXT = new Set(['.html', '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.md', '.mdx']);

export function sourceFiles(root: string, limit = 2000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name));
      } else if (SOURCE_EXT.has(path.extname(e.name))) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

export function parseNewText(text: string): string | undefined {
  const m = text.match(/\b(?:to|says?|with)\s*[:]?\s*["“']([^"”']{1,300})["”']/i);
  return m?.[1];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });

let counter = 0;
const nextId = () => `demo_${Date.now()}_${counter++}`;

export interface MockOptions {
  /** Multiplies every pause: 1 paces steps roughly like Claude (so the bees have time to fly), tests use less. */
  pace?: number;
}

export async function runMock(ctx: AgentContext, req: { text: string; element?: PickedElement }, opts: MockOptions = {}): Promise<AgentResult> {
  const { signal } = ctx.abort;
  const pace = opts.pace ?? 1;
  const rel = (abs: string) => projectRelative(ctx.cwd, abs) ?? abs;
  // Each step: the tool runs, then a short pause while "Claude" thinks about the result.
  const step = async (action: ToolAction, tool: string, ms: number, start: Partial<ToolEvent>, end: () => Partial<ToolEvent> = () => ({})) => {
    const id = nextId();
    ctx.emit({ type: 'tool', id, phase: 'start', action, tool, ...start });
    await sleep(ms * pace, signal);
    ctx.emit({ type: 'tool', id, phase: 'end', action, tool, file: start.file, ok: true, ...end() });
    await sleep(450 * pace, signal);
  };
  try {
    // Planning before the first step, as Claude does: the bees fly out and think meanwhile.
    await sleep(1100 * pace, signal);
    const needle = req.element?.text?.trim();
    const replacement = parseNewText(req.text);

    // With a source tag the picked element says where it's written: go straight there.
    let hits: string[] = [];
    const tag = parseSourceTag(req.element?.src);
    const tagged = tag ? path.resolve(ctx.cwd, tag.file) : null;
    if (tag && tagged && insideProject(ctx.cwd, tagged) && existsSync(tagged)) {
      const from = Math.max(1, tag.line - 4);
      await step('read', 'Read', 900, { file: rel(tagged), lines: [from, tag.line + 8] });
      if (needle && readFileSync(tagged, 'utf8').includes(needle)) hits = [tagged];
    }

    if (hits.length === 0) {
      const files = sourceFiles(ctx.cwd);
      hits = needle ? files.filter((f) => readFileSync(f, 'utf8').includes(needle)) : [];
      const found = hits.slice(0, 4).map((f) => {
        const text = readFileSync(f, 'utf8');
        return { file: rel(f), line: lineAt(text, text.indexOf(needle!)) };
      });
      await step('search', 'Grep', 700, {}, () => (found.length > 0 ? { hits: found } : {}));
      for (const file of hits.length > 0 ? hits.slice(0, 2) : files.slice(0, 2)) {
        await step('read', 'Read', 800, { file: rel(file) });
      }
    }

    if (!needle || !replacement || hits.length === 0) {
      const summary = !needle
        ? 'Demo mode can only change text. Pick an element first, then type: change the text to "your new words". Add an Anthropic API key to let Claude make any change.'
        : !replacement
          ? 'Demo mode needs the new words in quotes, like: change the text to "Fresh bread every morning".'
          : "Demo mode couldn't find that text in the project's files. Add an Anthropic API key so Claude can find and change it.";
      ctx.emit({ type: 'say', role: 'assistant', text: summary });
      return { ok: false, summary };
    }

    const file = hits[0];
    ctx.checkpoints.snapshot(file);
    const source = readFileSync(file, 'utf8');
    const at = source.indexOf(needle);
    await step('edit', 'Edit', 1200, { file: rel(file), lines: spanLines(source, at, needle.length) }, () => {
      writeFileSync(file, source.slice(0, at) + replacement + source.slice(at + needle.length));
      return { lines: spanLines(readFileSync(file, 'utf8'), at, replacement.length) };
    });

    const summary = `Changed “${needle}” to “${replacement}”. (Demo mode: add an API key to let Claude do more.)`;
    ctx.emit({ type: 'say', role: 'assistant', text: summary });
    return { ok: true, summary };
  } catch {
    return { ok: false, summary: 'Stopped.' };
  }
}
