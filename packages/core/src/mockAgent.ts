import { readdirSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import path from 'node:path';
import type { AgentContext, AgentResult } from './agent.js';
import type { PickedElement } from './types.js';

/**
 * Demo mode: a tiny local stand-in for Claude, used for tests, demos and for
 * trying Hivebubble without an API key. It can do exactly one thing for real:
 * change the text of a picked element ("change the text to "…""). Every step
 * it takes is a real file search, read or edit, so the bee cursors and undo
 * behave exactly as they do with Claude.
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

export async function runMock(ctx: AgentContext, req: { text: string; element?: PickedElement }): Promise<AgentResult> {
  const { signal } = ctx.abort;
  const rel = (abs: string) => path.relative(ctx.cwd, abs);
  try {
    const needle = req.element?.text?.trim();
    const replacement = parseNewText(req.text);

    const searchId = nextId();
    ctx.emit({ type: 'tool', id: searchId, phase: 'start', action: 'search', tool: 'Grep' });
    await sleep(500, signal);
    const files = sourceFiles(ctx.cwd);
    const hits = needle ? files.filter((f) => readFileSync(f, 'utf8').includes(needle)) : [];
    ctx.emit({ type: 'tool', id: searchId, phase: 'end', action: 'search', tool: 'Grep' });

    const toRead = hits.length > 0 ? hits.slice(0, 2) : files.slice(0, 2);
    for (const file of toRead) {
      const id = nextId();
      ctx.emit({ type: 'tool', id, phase: 'start', action: 'read', tool: 'Read', file: rel(file) });
      await sleep(450, signal);
      ctx.emit({ type: 'tool', id, phase: 'end', action: 'read', tool: 'Read', file: rel(file) });
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
    const id = nextId();
    ctx.checkpoints.snapshot(file);
    ctx.emit({ type: 'tool', id, phase: 'start', action: 'edit', tool: 'Edit', file: rel(file) });
    await sleep(600, signal);
    const source = readFileSync(file, 'utf8');
    writeFileSync(file, source.replace(needle, replacement));
    ctx.emit({ type: 'tool', id, phase: 'end', action: 'edit', tool: 'Edit', file: rel(file) });

    const summary = `Changed “${needle}” to “${replacement}”. (Demo mode: add an API key to let Claude do more.)`;
    ctx.emit({ type: 'say', role: 'assistant', text: summary });
    return { ok: true, summary };
  } catch {
    return { ok: false, summary: 'Stopped.' };
  }
}
