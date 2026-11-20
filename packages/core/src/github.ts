import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isInside } from './paths.js';

/**
 * Downloads a folder of a GitHub repository at one exact commit (registry
 * entries are pinned, never "latest"). Two kinds of request: the commit's file
 * tree from the API, then each file from raw.githubusercontent.com. Symlinks
 * are skipped, and no path may leave the target folder.
 */

export interface RepoRef {
  /** owner/name */
  repo: string;
  /** A full 40-character commit SHA. */
  sha: string;
  /** The folder inside the repository ('' for the whole repository). */
  path: string;
}

export interface RemoteFile {
  /** Relative to the folder. */
  path: string;
  size: number;
}

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const api = () => process.env.HIVEBUBBLE_GITHUB_API ?? 'https://api.github.com';
const raw = () => process.env.HIVEBUBBLE_GITHUB_RAW ?? 'https://raw.githubusercontent.com';

function headers(): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'hivebubble' };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

export function validRef(ref: RepoRef): string | null {
  if (!REPO.test(ref.repo)) return `"${ref.repo}" is not an owner/name repository`;
  if (!SHA.test(ref.sha)) return `"${ref.sha}" is not a full commit SHA`;
  if (ref.path && !safeRelative(ref.path)) return `"${ref.path}" is not a safe folder path`;
  return null;
}

/** A relative path with no way out of its folder. */
export function safeRelative(p: string): boolean {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export async function listFiles(ref: RepoRef, limits = { maxFiles: 400, maxBytes: 15_000_000 }): Promise<RemoteFile[]> {
  const bad = validRef(ref);
  if (bad) throw new Error(bad);
  const res = await fetch(`${api()}/repos/${ref.repo}/git/trees/${ref.sha}?recursive=1`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${ref.repo} at ${ref.sha.slice(0, 7)}.`);
  const data = (await res.json()) as { tree?: Array<{ path: string; type: string; mode?: string; size?: number }>; truncated?: boolean };
  const prefix = ref.path ? `${ref.path.replace(/\/+$/, '')}/` : '';
  const files = (data.tree ?? [])
    .filter((e) => e.type === 'blob' && e.mode !== '120000' && e.path.startsWith(prefix))
    .map((e) => ({ path: e.path.slice(prefix.length), size: e.size ?? 0 }));
  if (files.length === 0) throw new Error(`${ref.repo} has no files in "${ref.path}" at ${ref.sha.slice(0, 7)}${data.truncated ? ' (the tree was too big to list)' : ''}.`);
  if (files.length > limits.maxFiles) throw new Error(`"${ref.path}" has ${files.length} files, more than the ${limits.maxFiles} Hivebubble accepts.`);
  const total = files.reduce((t, f) => t + f.size, 0);
  if (total > limits.maxBytes) throw new Error(`"${ref.path}" is ${(total / 1e6).toFixed(1)} MB, more than Hivebubble accepts.`);
  const unsafe = files.find((f) => !safeRelative(f.path));
  if (unsafe) throw new Error(`Refusing the unsafe path "${unsafe.path}".`);
  return files;
}

export async function fetchFile(ref: RepoRef, rel: string): Promise<Buffer> {
  const full = [ref.path, rel].filter(Boolean).join('/');
  const res = await fetch(`${raw()}/${ref.repo}/${ref.sha}/${full.split('/').map(encodeURIComponent).join('/')}`, { headers: { 'user-agent': 'hivebubble' } });
  if (!res.ok) throw new Error(`Couldn't download ${full} (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

/** Every file of the folder, keyed by relative path. */
export async function fetchFolder(ref: RepoRef): Promise<Map<string, Buffer>> {
  const files = await listFiles(ref);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < files.length; i += 6) {
    const batch = files.slice(i, i + 6);
    const bodies = await Promise.all(batch.map((f) => fetchFile(ref, f.path)));
    batch.forEach((f, n) => out.set(f.path, bodies[n]));
  }
  return out;
}

/** Write fetched files under `dest`, applying renames (create-vite style `_gitignore` → `.gitignore`). */
export function writeFiles(dest: string, files: Map<string, Buffer>, renames: Record<string, string> = {}): string[] {
  const written: string[] = [];
  for (const [rel, body] of files) {
    const target = renames[rel] ?? rel;
    if (!safeRelative(target)) throw new Error(`Refusing the unsafe path "${target}".`);
    const abs = path.join(dest, target);
    if (!isInside(dest, abs)) throw new Error(`Refusing the unsafe path "${target}".`);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    written.push(target);
  }
  return written.sort();
}

export function sourceUrl(ref: RepoRef): string {
  return `https://github.com/${ref.repo}/tree/${ref.sha}/${ref.path}`;
}
