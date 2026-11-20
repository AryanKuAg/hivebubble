import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Undo points. Before any file is edited or written during a task, its
 * original content is saved once. Undo restores the files of the most recent
 * task (deleting files the task created).
 */
export class Checkpoints {
  private current: Map<string, string | null> | null = null;
  private stack: Map<string, string | null>[] = [];

  constructor(private readonly root: string, private readonly maxDepth = 20) {}

  begin(): void {
    this.current = new Map();
  }

  /** Call before a file changes. Paths outside the project root are refused. */
  snapshot(filePath: string): void {
    if (!this.current) return;
    const abs = path.resolve(this.root, filePath);
    if (!isInside(this.root, abs)) throw new Error(`Refusing to touch a file outside the project: ${filePath}`);
    if (this.current.has(abs)) return;
    this.current.set(abs, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
  }

  /** Finish the task. Returns true when the task changed at least one file. */
  commit(): boolean {
    const task = this.current;
    this.current = null;
    if (!task || task.size === 0) return false;
    this.stack.push(task);
    if (this.stack.length > this.maxDepth) this.stack.shift();
    return true;
  }

  canUndo(): boolean {
    return this.stack.length > 0;
  }

  /** Restore the last task's files. Returns their paths relative to the project. */
  undo(): string[] {
    const task = this.stack.pop();
    if (!task) return [];
    const files: string[] = [];
    for (const [abs, original] of task) {
      if (original === null) rmSync(abs, { force: true });
      else writeFileSync(abs, original);
      files.push(path.relative(this.root, abs));
    }
    return files;
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
