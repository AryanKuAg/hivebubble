import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validRef, type RepoRef } from './github.js';
import type { TaskKind } from './types.js';

/**
 * The curated registry (README §8): `registry/skills.json` and
 * `registry/starters.json` in the Hivebubble repository. Entries arrive by pull
 * request after someone has read every file at the pinned commit.
 */

export interface SkillEntry {
  id: string;
  /** The skill's own name (its SKILL.md `name`), also its folder under .claude/skills. */
  name: string;
  title: string;
  description: string;
  author: string;
  source: RepoRef;
  license: string;
  licenseSource?: string;
  /** When someone last read every file at the pinned commit (YYYY-MM-DD). */
  reviewed: string;
  verified: boolean;
  /** Whether the skill includes scripts, or tells the agent to make network calls. */
  scripts: boolean;
  network: boolean;
  /** Task kinds the skill is switched on for, once installed. */
  useFor: TaskKind[];
  /** Words in a request that make the skill relevant (and worth suggesting). */
  keywords: string[];
  /** Packages the project must use for the skill to apply (e.g. react). */
  frameworks?: string[];
}

export type StarterSource = { local: string } | (RepoRef & { renames?: Record<string, string> });

export interface StarterEntry {
  id: string;
  title: string;
  description: string;
  source: StarterSource;
  license: string;
  reviewed: string;
  verified: boolean;
  keywords: string[];
}

/** Licenses that allow reuse without obligations a non-developer could miss. */
export const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0']);

/**
 * Where Hivebubble's own files are: the registry, the starters and its
 * plugin. In the repository checkout that is the repo root; a packaged app
 * points `HIVEBUBBLE_RESOURCES` at its bundled copy.
 */
export function resourcesDir(): string {
  return process.env.HIVEBUBBLE_RESOURCES || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

export function pluginDir(): string {
  return path.join(resourcesDir(), 'plugin');
}

function read<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(resourcesDir(), 'registry', name), 'utf8')) as T;
}

export function skillRegistry(): SkillEntry[] {
  return read<{ skills: SkillEntry[] }>('skills.json').skills;
}

export function starterRegistry(): { starters: StarterEntry[]; fallback: string } {
  return read<{ starters: StarterEntry[]; fallback: string }>('starters.json');
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What's wrong with the registry files, for the tests and for reviewers of new entries. */
export function registryProblems(): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const check = (kind: string, e: { id: string; license: string; reviewed: string }) => {
    if (ids.has(`${kind}:${e.id}`)) problems.push(`${kind} ${e.id}: duplicate id`);
    ids.add(`${kind}:${e.id}`);
    if (!PERMISSIVE.has(e.license)) problems.push(`${kind} ${e.id}: license ${e.license} needs a closer look`);
    if (!DATE.test(e.reviewed)) problems.push(`${kind} ${e.id}: reviewed must be YYYY-MM-DD`);
  };
  for (const s of skillRegistry()) {
    check('skill', s);
    const bad = validRef(s.source);
    if (bad) problems.push(`skill ${s.id}: ${bad}`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.name)) problems.push(`skill ${s.id}: name must be lowercase letters, digits and dashes`);
  }
  const { starters, fallback } = starterRegistry();
  for (const s of starters) {
    check('starter', s);
    if ('local' in s.source) {
      if (!existsSync(path.join(resourcesDir(), s.source.local, 'package.json'))) problems.push(`starter ${s.id}: ${s.source.local}/package.json is missing`);
    } else {
      const bad = validRef(s.source);
      if (bad) problems.push(`starter ${s.id}: ${bad}`);
    }
  }
  if (!starters.some((s) => s.id === fallback)) problems.push(`starters: the fallback "${fallback}" is not a starter`);
  return problems;
}
