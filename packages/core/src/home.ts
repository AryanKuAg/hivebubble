import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Hivebubble's own folder on this computer (not inside any project): the
 * spending ledger, settings shared with the Mac app, and Claude's config.
 * `HIVEBUBBLE_HOME` moves it (tests use a temporary folder).
 */
export function hivebubbleHome(): string {
  const dir =
    process.env.HIVEBUBBLE_HOME ||
    (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Hivebubble') : path.join(os.homedir(), '.hivebubble'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A folder inside the project's `.hivebubble/` (undo points, the router log,
 * the source-tags config). The first one also writes `.hivebubble/.gitignore`
 * containing `*`, so the folder never shows up in the project's git.
 */
export function projectDataDir(root: string, ...sub: string[]): string {
  const base = path.join(root, '.hivebubble');
  const dir = path.join(base, ...sub);
  mkdirSync(dir, { recursive: true });
  const ignore = path.join(base, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, "# Hivebubble's own files for this project.\n*\n");
  return dir;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write JSON through a temporary file, so a crash never leaves half a file behind. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export interface Settings {
  /** Hivebubble pauses once Claude has cost this much today. */
  dailyCapUsd: number;
  /** The most one task may cost. */
  taskCapUsd: number;
}

export const DEFAULT_SETTINGS: Settings = { dailyCapUsd: 5, taskCapUsd: 2 };

function positive(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Settings, read fresh each time so a change in the Mac app applies to the
 * next task. Environment variables (and the CLI flags that set them) win.
 */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const saved = readJson<Partial<Settings>>(path.join(hivebubbleHome(), 'settings.json'), {});
  return {
    dailyCapUsd: positive(env.HIVEBUBBLE_DAILY_CAP) ?? positive(saved.dailyCapUsd) ?? DEFAULT_SETTINGS.dailyCapUsd,
    taskCapUsd: positive(env.HIVEBUBBLE_TASK_CAP) ?? positive(saved.taskCapUsd) ?? DEFAULT_SETTINGS.taskCapUsd,
  };
}
