import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fetchFolder, writeFiles } from './github.js';
import { PERMISSIVE, resourcesDir, starterRegistry, type StarterEntry } from './registry.js';

/**
 * "New app from a starter" (README §8): for "make me a booking app", pick a
 * starter from the registry, copy it into a new folder without its git
 * history, and let Claude adapt it once it runs.
 */

const SKIP = new Set(['node_modules', 'dist', '.git', '.hivebubble', '.DS_Store']);

function score(text: string, starter: StarterEntry): number {
  const lower = text.toLowerCase();
  return starter.keywords.reduce((n, k) => n + (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower) ? 1 : 0), 0);
}

/** The starter that fits a request best, or the registry's fallback. */
export function pickStarter(text: string): StarterEntry {
  const { starters, fallback } = starterRegistry();
  let best: StarterEntry | null = null;
  let bestScore = 0;
  for (const s of starters) {
    const n = score(text, s);
    if (n > bestScore) {
      best = s;
      bestScore = n;
    }
  }
  return best ?? starters.find((s) => s.id === fallback) ?? starters[0];
}

export function findStarter(id: string): StarterEntry {
  const starter = starterRegistry().starters.find((s) => s.id === id);
  if (!starter) throw new Error(`There is no starter called "${id}".`);
  return starter;
}

/** A folder name from a request: "make me a booking app for my salon" → "salon-booking". */
export function folderName(text: string, starter: StarterEntry): string {
  const owner = text.toLowerCase().match(/\bfor (?:my|our|the|a|an)\s+([a-z][a-z' -]{1,30}?)(?:\s+(?:in|that|with|where|so)\b|[.,!?]|$)/)?.[1];
  const slug = (s: string) => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = owner ? `${slug(owner)}-${starter.id === 'landing' ? 'site' : starter.id}` : `my-${starter.id === 'landing' ? 'site' : starter.id}`;
  return base.slice(0, 40).replace(/-+$/, '') || 'my-app';
}

export interface Created {
  dir: string;
  starter: StarterEntry;
  files: number;
}

/**
 * Create a project from a starter in `dir` (which must be new or empty).
 * Licenses other than the permissive ones need `acceptLicense`.
 */
export async function createFromStarter(dir: string, starterId: string, opts: { acceptLicense?: boolean } = {}): Promise<Created> {
  const starter = findStarter(starterId);
  if (!PERMISSIVE.has(starter.license) && !opts.acceptLicense) {
    throw new Error(`${starter.title} uses the ${starter.license} license, which comes with obligations. Accept it explicitly to use this starter.`);
  }
  const target = path.resolve(dir);
  if (existsSync(target) && readdirSync(target).some((n) => n !== '.DS_Store')) {
    throw new Error(`${target} already has files in it. Choose a new or empty folder.`);
  }
  mkdirSync(target, { recursive: true });
  let files: number;
  if ('local' in starter.source) {
    const from = path.join(resourcesDir(), starter.source.local);
    cpSync(from, target, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });
    files = countFiles(target);
  } else {
    files = writeFiles(target, await fetchFolder(starter.source), starter.source.renames).length;
  }
  // The package is named after its folder, not after the starter.
  const pkgFile = path.join(target, 'package.json');
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>;
    pkg.name = path.basename(target).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'my-app';
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return { dir: target, starter, files };
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}
