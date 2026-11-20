import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { lineDiff } from './diff.js';
import { fetchFolder, sourceUrl, writeFiles, type RepoRef } from './github.js';
import { projectDataDir, readJson, writeJson } from './home.js';
import { skillRegistry, type SkillEntry } from './registry.js';
import type { Route } from './types.js';

/**
 * Skills in a project (README §8). Registry skills install into
 * `.claude/skills/<name>/`, where the Agent SDK finds them, and are recorded in
 * `.hivebubble/skills.lock` with their source, commit, license and why they
 * were added. Nothing updates on its own: an update shows its diff first.
 */

/** Hivebubble's own skills, from its plugin. */
export const OWN_SKILLS = { explain: 'hivebubble:explain', style: 'hivebubble:house-style', verify: 'hivebubble:verify' };

export interface LockEntry {
  id: string;
  name: string;
  title: string;
  source: RepoRef;
  license: string;
  verified: boolean;
  scripts: boolean;
  network: boolean;
  installedAt: string;
  /** Why it was added: the request that brought it in, or "added in the Skills screen". */
  reason: string;
  files: string[];
  /** sha256 of the installed files, to notice changes made by hand. */
  hash: string;
}

interface LockFile {
  version: 1;
  skills: Record<string, LockEntry>;
  /** Registry skills the person said no to, so they aren't offered again. */
  declined: string[];
}

export interface InstalledSkill {
  name: string;
  title: string;
  description?: string;
  id?: string;
  author?: string;
  url?: string;
  /** The pinned commit, short. */
  version?: string;
  license?: string;
  verified: boolean;
  scripts: boolean;
  network: boolean;
  reason: string;
  installedAt?: string;
  /** Its files changed since it was installed. */
  modified: boolean;
  /** Put there by hand, not by Hivebubble. */
  byHand: boolean;
  /** A newer reviewed version is in the registry. */
  update?: { version: string; reviewed: string };
}

export interface SkillDiff {
  name: string;
  from: string;
  to: string;
  reviewed: string;
  added: string[];
  removed: string[];
  changed: string[];
  /** The SKILL.md changes, line by line. */
  skillMd: string;
  scripts: boolean;
  network: boolean;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SCRIPT_FILE = /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|bin|so|dylib)$/i;
const NETWORK = /\b(?:curl|wget)\s+(?:-\S+\s+)*["']?https?:\/\/|\bfetch\(\s*["'`]https?:|\brequests\.(?:get|post)\(|\burllib\.request|\bhttp\.request\(|\bnet\.connect\(/;

const lockFile = (project: string) => path.join(project, '.hivebubble', 'skills.lock');
export const skillsRoot = (project: string) => path.join(project, '.claude', 'skills');

export function readLock(project: string): LockFile {
  const lock = readJson<LockFile>(lockFile(project), { version: 1, skills: {}, declined: [] });
  return { version: 1, skills: lock.skills ?? {}, declined: lock.declined ?? [] };
}

function writeLock(project: string, lock: LockFile): void {
  projectDataDir(project);
  writeJson(lockFile(project), lock);
}

function readFolder(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(abs, `${prefix}${name}/`);
      else out.set(`${prefix}${name}`, readFileSync(abs));
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

function hashFiles(files: Map<string, Buffer>): string {
  const h = createHash('sha256');
  for (const [rel, body] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    h.update(rel);
    h.update('\0');
    h.update(body);
    h.update('\0');
  }
  return h.digest('hex');
}

/** Whether a skill's files include scripts, or commands that reach the network. */
export function scanFlags(files: Map<string, Buffer>): { scripts: boolean; network: boolean } {
  let scripts = false;
  let network = false;
  for (const [rel, body] of files) {
    const head = body.subarray(0, 2).toString('latin1');
    if (SCRIPT_FILE.test(rel) || head === '#!') scripts = true;
    if (body.length < 2_000_000 && NETWORK.test(body.toString('utf8'))) network = true;
  }
  return { scripts, network };
}

export function frontmatter(md: string): { name?: string; description?: string } {
  const block = md.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? '';
  const field = (key: string) => block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');
  return { name: field('name'), description: field('description') };
}

function wordMatch(text: string, keyword: string): boolean {
  return new RegExp(`\\b${keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
}

export function listSkills(project: string): InstalledSkill[] {
  const lock = readLock(project);
  const registry = new Map(skillRegistry().map((e) => [e.id, e]));
  const out: InstalledSkill[] = [];
  const root = skillsRoot(project);
  const folders = existsSync(root) ? readdirSync(root).filter((n) => existsSync(path.join(root, n, 'SKILL.md'))) : [];
  for (const name of folders.sort()) {
    const entry = lock.skills[name];
    const files = readFolder(path.join(root, name));
    const md = files.get('SKILL.md')?.toString('utf8') ?? '';
    if (!entry) {
      const flags = scanFlags(files);
      out.push({ name, title: name, description: frontmatter(md).description, verified: false, ...flags, reason: 'Added by hand', modified: false, byHand: true });
      continue;
    }
    const latest = registry.get(entry.id);
    out.push({
      name,
      title: entry.title,
      description: latest?.description ?? frontmatter(md).description,
      id: entry.id,
      author: latest?.author,
      url: sourceUrl(entry.source),
      version: entry.source.sha.slice(0, 7),
      license: entry.license,
      verified: entry.verified,
      scripts: entry.scripts,
      network: entry.network,
      reason: entry.reason,
      installedAt: entry.installedAt,
      modified: hashFiles(files) !== entry.hash,
      byHand: false,
      update: latest && latest.source.sha !== entry.source.sha ? { version: latest.source.sha.slice(0, 7), reviewed: latest.reviewed } : undefined,
    });
  }
  return out;
}

function registryEntry(id: string): SkillEntry {
  const entry = skillRegistry().find((e) => e.id === id || e.name === id);
  if (!entry) throw new Error(`There is no skill called "${id}" in Hivebubble's registry.`);
  return entry;
}

/** Download a registry skill at its pinned commit and add it to the project. */
export async function installSkill(project: string, id: string, reason: string): Promise<InstalledSkill> {
  const entry = registryEntry(id);
  if (!NAME.test(entry.name)) throw new Error(`"${entry.name}" is not a valid skill name.`);
  const lock = readLock(project);
  const dest = path.join(skillsRoot(project), entry.name);
  if (existsSync(dest) && !lock.skills[entry.name]) {
    throw new Error(`The project already has its own "${entry.name}" skill. Hivebubble won't overwrite it.`);
  }
  const files = await fetchFolder(entry.source);
  const md = files.get('SKILL.md')?.toString('utf8');
  if (!md) throw new Error(`${entry.title} has no SKILL.md at the pinned commit.`);
  if (frontmatter(md).name !== entry.name) throw new Error(`${entry.title}'s SKILL.md is named "${frontmatter(md).name}", not "${entry.name}" as reviewed.`);
  const flags = scanFlags(files);
  if ((flags.scripts && !entry.scripts) || (flags.network && !entry.network)) {
    throw new Error(`${entry.title}'s files don't match their review (they contain ${flags.scripts ? 'scripts' : 'network calls'}), so it wasn't added.`);
  }
  // Write next to the destination first, then swap it in, so a failed download leaves nothing half-installed.
  const staging = path.join(projectDataDir(project, 'staging'), `${entry.name}-${Date.now().toString(36)}`);
  const written = writeFiles(staging, files);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(staging, dest);
  lock.skills[entry.name] = {
    id: entry.id,
    name: entry.name,
    title: entry.title,
    source: entry.source,
    license: entry.license,
    verified: entry.verified,
    scripts: flags.scripts,
    network: flags.network,
    installedAt: new Date().toISOString(),
    reason: reason.slice(0, 200),
    files: written,
    hash: hashFiles(files),
  };
  lock.declined = lock.declined.filter((d) => d !== entry.id);
  writeLock(project, lock);
  return listSkills(project).find((s) => s.name === entry.name)!;
}

export function removeSkill(project: string, name: string): boolean {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a skill name.`);
  const dir = path.join(skillsRoot(project), name);
  const lock = readLock(project);
  const known = Boolean(lock.skills[name]);
  if (!existsSync(dir) && !known) return false;
  rmSync(dir, { recursive: true, force: true });
  delete lock.skills[name];
  writeLock(project, lock);
  return true;
}

/** What updating a skill to the registry's version would change, or null when it is current. */
export async function skillUpdateDiff(project: string, name: string): Promise<SkillDiff | null> {
  const entry = readLock(project).skills[name];
  if (!entry) throw new Error(`"${name}" wasn't added by Hivebubble, so there's no reviewed version to update to.`);
  const latest = registryEntry(entry.id);
  if (latest.source.sha === entry.source.sha) return null;
  const next = await fetchFolder(latest.source);
  const now = readFolder(path.join(skillsRoot(project), name));
  const added = [...next.keys()].filter((f) => !now.has(f));
  const removed = [...now.keys()].filter((f) => !next.has(f));
  const changed = [...next.keys()].filter((f) => now.has(f) && !now.get(f)!.equals(next.get(f)!));
  return {
    name,
    from: entry.source.sha.slice(0, 7),
    to: latest.source.sha.slice(0, 7),
    reviewed: latest.reviewed,
    added,
    removed,
    changed,
    skillMd: lineDiff(now.get('SKILL.md')?.toString('utf8') ?? '', next.get('SKILL.md')?.toString('utf8') ?? ''),
    ...scanFlags(next),
  };
}

export async function updateSkill(project: string, name: string): Promise<InstalledSkill> {
  const entry = readLock(project).skills[name];
  if (!entry) throw new Error(`"${name}" wasn't added by Hivebubble.`);
  return installSkill(project, entry.id, entry.reason);
}

export function declineSkill(project: string, id: string): void {
  const lock = readLock(project);
  if (!lock.declined.includes(id)) lock.declined.push(id);
  writeLock(project, lock);
}

function projectDeps(project: string): Record<string, string> {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(path.join(project, 'package.json'), {});
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

/**
 * The skills to switch on for one task (README §6: "the 1–3 relevant ones"):
 * Hivebubble's own as the task needs them, installed registry skills that fit
 * the task, and every skill the project's owner added by hand. Everything
 * else the agent could see (Claude Code's built-in skills) stays hidden.
 */
export function skillsForTask(project: string, route: Pick<Route, 'kind' | 'checks'>, text: string): string[] {
  const names = [OWN_SKILLS.explain];
  if (route.kind !== 'question') names.push(OWN_SKILLS.style);
  if (route.checks.length > 0) names.push(OWN_SKILLS.verify);
  const lower = text.toLowerCase();
  const registry = new Map(skillRegistry().map((e) => [e.id, e]));
  let fromRegistry = 0;
  for (const s of listSkills(project)) {
    if (s.byHand) {
      names.push(s.name);
      continue;
    }
    const entry = s.id ? registry.get(s.id) : undefined;
    const fits = !entry || entry.useFor.includes(route.kind) || entry.keywords.some((k) => wordMatch(lower, k));
    if (fits && fromRegistry < 3) {
      names.push(s.name);
      fromRegistry++;
    }
  }
  return names;
}

/** A registry skill worth offering for this request: relevant, not installed, not declined before. */
export function suggestSkill(project: string, route: Pick<Route, 'kind'>, text: string): SkillEntry | null {
  if (route.kind === 'question') return null;
  const lock = readLock(project);
  const installed = new Set(Object.values(lock.skills).map((s) => s.id));
  const deps = projectDeps(project);
  const lower = text.toLowerCase();
  for (const entry of skillRegistry()) {
    if (installed.has(entry.id) || lock.declined.includes(entry.id)) continue;
    if (entry.frameworks && !entry.frameworks.every((f) => deps[f])) continue;
    if (existsSync(path.join(skillsRoot(project), entry.name))) continue;
    const byWord = entry.keywords.some((k) => wordMatch(lower, k));
    const forNewApp = route.kind === 'new-app' && entry.useFor.includes('new-app');
    if (byWord || forNewApp) return entry;
  }
  return null;
}
