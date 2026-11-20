import { realpathSync } from 'node:fs';
import path from 'node:path';

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The real location of a path, following symlinks, even when the file doesn't
 * exist yet (a file the agent is about to create): its nearest existing folder
 * is resolved and the rest is added back.
 */
export function realPath(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let dir = abs;
  for (;;) {
    try {
      return path.join(realpathSync(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * True when `target` is inside the project folder once symlinks are followed,
 * so a link inside the project can't be used to reach files outside it. A
 * project opened through a symlinked path (like /tmp on a Mac) still works.
 */
export function insideProject(root: string, target: string): boolean {
  return isInside(realPath(root), realPath(path.resolve(root, target)));
}

/** The path relative to the project folder, with forward slashes, or null when it is outside. */
export function projectRelative(root: string, file: string): string | null {
  const abs = path.resolve(root, file);
  for (const [base, target] of [
    [path.resolve(root), abs],
    [realPath(root), abs],
    [realPath(root), realPath(abs)],
  ]) {
    if (isInside(base, target)) return path.relative(base, target).split(path.sep).join('/');
  }
  return null;
}
