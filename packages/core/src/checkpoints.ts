import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { projectDataDir, readJson, writeJson } from './home.js';
import { insideProject } from './paths.js';

export { isInside } from './paths.js';

/** One file a task changed: what it held before, and what the task left in it (null: it didn't exist). */
interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
}

interface Entry {
  id: string;
  at: string;
  prompt: string;
  files: FileChange[];
}

export interface UndoResult {
  /** Files restored, relative to the project. */
  files: string[];
  /** Files that changed after the task; nothing was restored because of them. */
  conflicts: string[];
}

export interface UndoPoint {
  id: string;
  at: string;
  prompt: string;
  files: string[];
}

const ENTRY = /^(\d{6})-[\w-]+\.json$/;

/**
 * Undo points. Before any file is edited or written during a task, its
 * original content is saved once; when the task ends, what it left behind is
 * saved too. Undo restores the files of the most recent task (deleting files
 * the task created), but not over changes made after the task, unless asked
 * to. Undo points are kept in `.hivebubble/undo/`, so they survive a restart.
 */
export class Checkpoints {
  private current: { prompt: string; files: Map<string, string | null>; id?: string } | null = null;
  private stack: Entry[] = [];
  private seq = 0;
  private readonly dir: string | null;
  private readonly maxDepth: number;

  constructor(
    private readonly root: string,
    opts: { maxDepth?: number; persist?: boolean } = {},
  ) {
    this.maxDepth = opts.maxDepth ?? 20;
    this.dir = opts.persist === false ? null : path.join(root, '.hivebubble', 'undo');
    this.load();
  }

  private load(): void {
    if (!this.dir || !existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir).filter((n) => ENTRY.test(n)).sort()) {
      const entry = readJson<Entry | null>(path.join(this.dir, name), null);
      if (entry && Array.isArray(entry.files)) this.stack.push(entry);
      this.seq = Math.max(this.seq, Number(name.match(ENTRY)![1]));
    }
  }

  private fileOf(entry: Entry): string | null {
    if (!this.dir) return null;
    const name = readdirSync(this.dir).find((n) => n.endsWith(`-${entry.id}.json`));
    return name ? path.join(this.dir, name) : null;
  }

  /** Start a task's undo point. `id` ties it to the task's line in the router log. */
  begin(prompt = '', id?: string): void {
    this.current = { prompt: prompt.slice(0, 300), files: new Map(), id };
  }

  /** Call before a file changes. Paths outside the project root are refused. */
  snapshot(filePath: string): void {
    if (!this.current) return;
    const abs = path.resolve(this.root, filePath);
    if (!insideProject(this.root, abs)) throw new Error(`Refusing to touch a file outside the project: ${filePath}`);
    if (this.current.files.has(abs)) return;
    this.current.files.set(abs, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
  }

  /** Files the current task has changed so far that still exist, relative to the project (for the checks). */
  touched(): string[] {
    if (!this.current) return [];
    return [...this.current.files.keys()].filter((abs) => existsSync(abs)).map((abs) => this.rel(abs));
  }

  /** Finish the task. Returns true when the task changed at least one file. */
  commit(): boolean {
    const task = this.current;
    this.current = null;
    if (!task) return false;
    const files: FileChange[] = [];
    for (const [abs, before] of task.files) {
      const after = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      if (after !== before) files.push({ path: this.rel(abs), before, after });
    }
    if (files.length === 0) return false;
    const id = task.id && /^[\w-]+$/.test(task.id) ? task.id : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const entry: Entry = { id, at: new Date().toISOString(), prompt: task.prompt, files };
    this.stack.push(entry);
    if (this.dir) {
      projectDataDir(this.root, 'undo');
      writeJson(path.join(this.dir, `${String(++this.seq).padStart(6, '0')}-${entry.id}.json`), entry);
    }
    while (this.stack.length > this.maxDepth) this.drop(this.stack.shift()!);
    return true;
  }

  canUndo(): boolean {
    return this.stack.length > 0;
  }

  /** The latest task's files that changed after it ended (by hand, or by another tool). */
  conflicts(): string[] {
    const entry = this.stack[this.stack.length - 1];
    if (!entry) return [];
    return entry.files.filter((f) => this.read(f.path) !== f.after).map((f) => f.path);
  }

  /**
   * Restore the last task's files. When some changed after the task, nothing
   * is restored and they are listed in `conflicts`, unless `force` is set.
   */
  undo(force = false): UndoResult {
    const entry = this.stack[this.stack.length - 1];
    if (!entry) return { files: [], conflicts: [] };
    const conflicts = this.conflicts();
    if (conflicts.length > 0 && !force) return { files: [], conflicts };
    this.stack.pop();
    for (const f of entry.files) {
      const abs = path.resolve(this.root, f.path);
      if (!insideProject(this.root, abs)) continue;
      if (f.before === null) rmSync(abs, { force: true });
      else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, f.before);
      }
    }
    this.drop(entry);
    return { files: entry.files.map((f) => f.path), conflicts };
  }

  /** Undo points, newest first. */
  history(): UndoPoint[] {
    return [...this.stack].reverse().map((e) => ({ id: e.id, at: e.at, prompt: e.prompt, files: e.files.map((f) => f.path) }));
  }

  private drop(entry: Entry): void {
    const file = this.fileOf(entry);
    if (file) rmSync(file, { force: true });
  }

  private read(rel: string): string | null {
    const abs = path.resolve(this.root, rel);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  }

  private rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }
}
