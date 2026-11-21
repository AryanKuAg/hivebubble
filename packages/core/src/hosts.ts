import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManagedProcess } from './processes.js';
import type { HostId } from './types.js';

export type { HostId };

/**
 * Hosting providers (README §9). Each takes a folder of built files and puts
 * it online, reporting progress as it goes:
 * - Vercel and Netlify through their REST APIs: every file is sent once,
 *   identified by its SHA-1, then a deployment is made from those files;
 * - Cloudflare through its official CLI (Wrangler, pinned), which its docs
 *   recommend over the raw upload API.
 * API calls were checked against the providers' docs on 2026-11-21.
 */

export interface SiteFile {
  /** Relative to the build folder, with forward slashes. */
  path: string;
  body: Buffer;
  sha1: string;
}

export interface Progress {
  (step: { phase: 'upload' | 'finalize'; message: string; done?: number; total?: number; file?: string }): void;
}

export interface Published {
  url: string;
  /** Where the person manages the site on the host. */
  adminUrl?: string;
  /** What to remember for the next deploy to the same site. */
  state: Record<string, string>;
}

const vercelApi = () => process.env.HIVEBUBBLE_VERCEL_API ?? 'https://api.vercel.com';
const netlifyApi = () => process.env.HIVEBUBBLE_NETLIFY_API ?? 'https://api.netlify.com/api/v1';
export const WRANGLER = 'wrangler@4.158.0';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('Stopped.'))), { once: true });
  });

export function siteFiles(dir: string, list: string[]): SiteFile[] {
  return list.map((rel) => {
    const body = readFileSync(path.join(dir, rel));
    return { path: rel, body, sha1: createHash('sha1').update(body).digest('hex') };
  });
}

/** A host name: lowercase letters, digits and dashes. */
export function siteSlug(name: string, max = 40): string {
  return (
    name
      .toLowerCase()
      .replace(/^@[^/]+\//, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'my-site'
  );
}

async function api<T>(url: string, { token, ...init }: RequestInit & { token: string }, what: string): Promise<T> {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'user-agent': 'hivebubble', ...(init.headers ?? {}) } });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON: keep the text for the message.
  }
  if (!res.ok) {
    const err = data as { error?: { message?: string; code?: string } | string; message?: string } | undefined;
    const message = (typeof err?.error === 'object' ? err.error.message : err?.error) ?? err?.message ?? text.slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new Error(`The host refused the token while ${what} (HTTP ${res.status}). Check the token in Hivebubble's Hosting settings.`);
    throw new Error(`The host said no while ${what} (HTTP ${res.status}): ${message || 'no details'}`);
  }
  return data as T;
}

// ---- Vercel -------------------------------------------------------------------

interface VercelDeployment {
  id: string;
  url: string;
  readyState: string;
  alias?: string[];
  errorMessage?: string | null;
}

export async function deployVercel(
  files: SiteFile[],
  opts: { token: string; name: string; teamId?: string; signal?: AbortSignal; pollMs?: number },
  progress: Progress,
): Promise<Published> {
  const team = opts.teamId ? `teamId=${encodeURIComponent(opts.teamId)}` : '';
  const q = (extra = '') => [team, extra].filter(Boolean).join('&');
  // 1. Upload every distinct file, identified by its SHA-1.
  const unique = [...new Map(files.map((f) => [f.sha1, f])).values()];
  let done = 0;
  for (const f of unique) {
    progress({ phase: 'upload', message: `Uploading ${f.path}`, done, total: unique.length, file: f.path });
    await api(`${vercelApi()}/v2/files${q() ? `?${q()}` : ''}`, {
      method: 'POST',
      token: opts.token,
      headers: { 'content-type': 'application/octet-stream', 'x-vercel-digest': f.sha1 },
      body: new Uint8Array(f.body),
      signal: opts.signal,
    }, `uploading ${f.path}`);
    done++;
  }
  progress({ phase: 'upload', message: 'All files uploaded', done, total: unique.length });
  // 2. A production deployment from those files. No package.json is sent, so nothing is built there.
  progress({ phase: 'finalize', message: 'Creating the deployment' });
  let dep = await api<VercelDeployment>(`${vercelApi()}/v13/deployments?${q('skipAutoDetectionConfirmation=1')}`, {
    method: 'POST',
    token: opts.token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: opts.name,
      files: files.map((f) => ({ file: f.path, sha: f.sha1, size: f.body.length })),
      projectSettings: { framework: null },
      target: 'production',
    }),
    signal: opts.signal,
  }, 'creating the deployment');
  // 3. Wait until it's ready.
  const deadline = Date.now() + 5 * 60_000;
  while (!['READY', 'ERROR', 'CANCELED'].includes(dep.readyState)) {
    if (Date.now() > deadline) throw new Error('Vercel took more than 5 minutes to get the site ready.');
    progress({ phase: 'finalize', message: `Vercel is getting it ready (${dep.readyState.toLowerCase()})` });
    await sleep(opts.pollMs ?? 1500, opts.signal);
    dep = await api<VercelDeployment>(`${vercelApi()}/v13/deployments/${encodeURIComponent(dep.id)}${q() ? `?${q()}` : ''}`, { token: opts.token, signal: opts.signal }, 'checking the deployment');
  }
  if (dep.readyState !== 'READY') throw new Error(`Vercel couldn't finish the deployment: ${dep.errorMessage ?? dep.readyState.toLowerCase()}.`);
  // The production alias (name.vercel.app) is the address to share; the unique URL is a fallback.
  const host = dep.alias?.find((a) => a.endsWith('.vercel.app')) ?? dep.alias?.[0] ?? dep.url;
  return { url: `https://${host}`, state: { project: opts.name } };
}

// ---- Netlify --------------------------------------------------------------------

interface NetlifySite {
  id: string;
  name: string;
  ssl_url?: string;
  url?: string;
  admin_url?: string;
}

interface NetlifyDeploy {
  id: string;
  state: string;
  required?: string[];
  ssl_url?: string;
  deploy_ssl_url?: string;
  error_message?: string | null;
}

export async function deployNetlify(
  files: SiteFile[],
  opts: { token: string; name: string; siteId?: string; signal?: AbortSignal; pollMs?: number },
  progress: Progress,
): Promise<Published> {
  // 1. A site, made once and reused (its name is its netlify.app address, so it gets a short random suffix).
  let site: NetlifySite | null = null;
  if (opts.siteId) {
    site = await api<NetlifySite>(`${netlifyApi()}/sites/${encodeURIComponent(opts.siteId)}`, { token: opts.token, signal: opts.signal }, 'finding the site').catch(() => null);
  }
  for (let attempt = 0; !site && attempt < 4; attempt++) {
    const name = `${siteSlug(opts.name, 30)}-${Math.random().toString(36).slice(2, 6)}`;
    progress({ phase: 'finalize', message: `Creating the site ${name}` });
    site = await api<NetlifySite>(`${netlifyApi()}/sites`, {
      method: 'POST',
      token: opts.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: opts.signal,
    }, 'creating the site').catch((err: Error) => {
      if (/HTTP 422/.test(err.message) && attempt < 3) return null; // name taken: try another
      throw err;
    });
  }
  if (!site) throw new Error("Netlify couldn't create a site.");
  // 2. A deploy described by digests: Netlify answers with the files it doesn't have yet.
  const digest: Record<string, string> = {};
  for (const f of files) digest[`/${f.path}`] = f.sha1;
  let deploy = await api<NetlifyDeploy>(`${netlifyApi()}/sites/${encodeURIComponent(site.id)}/deploys`, {
    method: 'POST',
    token: opts.token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files: digest }),
    signal: opts.signal,
  }, 'starting the deploy');
  const required = new Set(deploy.required ?? []);
  const toSend = [...new Map(files.filter((f) => required.has(f.sha1)).map((f) => [f.sha1, f])).values()];
  let done = 0;
  for (const f of toSend) {
    progress({ phase: 'upload', message: `Uploading ${f.path}`, done, total: toSend.length, file: f.path });
    const encoded = f.path.split('/').map(encodeURIComponent).join('/');
    await api(`${netlifyApi()}/deploys/${encodeURIComponent(deploy.id)}/files/${encoded}`, {
      method: 'PUT',
      token: opts.token,
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(f.body),
      signal: opts.signal,
    }, `uploading ${f.path}`);
    done++;
  }
  progress({ phase: 'upload', message: toSend.length ? 'All files uploaded' : 'Netlify already had every file', done, total: toSend.length });
  // 3. Wait until it's live.
  const deadline = Date.now() + 5 * 60_000;
  while (deploy.state !== 'ready') {
    if (deploy.state === 'error') throw new Error(`Netlify couldn't finish the deploy: ${deploy.error_message ?? 'unknown error'}.`);
    if (Date.now() > deadline) throw new Error('Netlify took more than 5 minutes to get the site ready.');
    progress({ phase: 'finalize', message: `Netlify is getting it ready (${deploy.state})` });
    await sleep(opts.pollMs ?? 1500, opts.signal);
    deploy = await api<NetlifyDeploy>(`${netlifyApi()}/deploys/${encodeURIComponent(deploy.id)}`, { token: opts.token, signal: opts.signal }, 'checking the deploy');
  }
  return {
    url: site.ssl_url ?? deploy.ssl_url ?? deploy.deploy_ssl_url ?? site.url ?? '',
    adminUrl: site.admin_url,
    state: { siteId: site.id, name: site.name },
  };
}

// ---- Cloudflare (Wrangler) ----------------------------------------------------------

/** Runs a command and streams its lines; replaced in tests. */
export type Runner = (cmd: string, args: string[], env: Record<string, string>, onLine: (line: string) => void, signal?: AbortSignal) => Promise<number | null>;

export const runCommand: Runner = async (cmd, args, env, onLine, signal) => {
  const proc = new ManagedProcess({ cmd, args, env }, os.tmpdir(), onLine);
  const stop = () => void proc.stop();
  signal?.addEventListener('abort', stop, { once: true });
  const code = await proc.exited;
  signal?.removeEventListener('abort', stop);
  return code;
};

export async function deployCloudflare(
  dir: string,
  opts: { token: string; accountId: string; name: string; signal?: AbortSignal; run?: Runner; today?: string },
  progress: Progress,
): Promise<Published> {
  const work = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-cloudflare-'));
  try {
    const name = siteSlug(opts.name, 63);
    // A Worker with only static assets; unknown paths fall back to index.html (single-page apps).
    const config = {
      name,
      compatibility_date: opts.today ?? new Date().toISOString().slice(0, 10),
      assets: { directory: dir, not_found_handling: 'single-page-application' },
    };
    writeFileSync(path.join(work, 'wrangler.json'), JSON.stringify(config, null, 2));
    const outputFile = path.join(work, 'output.ndjson');
    const lines: string[] = [];
    progress({ phase: 'upload', message: 'Uploading with Cloudflare’s Wrangler (the first time downloads it)' });
    const code = await (opts.run ?? runCommand)(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['--yes', WRANGLER, 'deploy', '--config', path.join(work, 'wrangler.json')],
      {
        CLOUDFLARE_API_TOKEN: opts.token,
        CLOUDFLARE_ACCOUNT_ID: opts.accountId,
        WRANGLER_OUTPUT_FILE_PATH: outputFile,
        WRANGLER_SEND_METRICS: 'false',
        CI: '1',
      },
      (line) => {
        lines.push(line);
        if (line.trim()) progress({ phase: 'upload', message: line.trim().slice(0, 120) });
      },
      opts.signal,
    );
    if (code !== 0) {
      const tail = lines.filter((l) => l.trim()).slice(-8).join('\n');
      throw new Error(`Wrangler couldn't deploy (exit code ${code}).\n${tail}`);
    }
    // Wrangler's machine-readable output lists the deploy's addresses; the printed text is the fallback.
    let url = '';
    try {
      for (const raw of readFileSync(outputFile, 'utf8').split('\n')) {
        const entry = raw.trim() ? (JSON.parse(raw) as { targets?: string[] }) : null;
        url ||= entry?.targets?.find((t) => t.startsWith('https://')) ?? '';
      }
    } catch {
      // No output file: read the printed text below.
    }
    url ||= lines.join('\n').match(/https:\/\/[\w.-]+\.workers\.dev\S*/)?.[0] ?? '';
    if (!url) throw new Error('Wrangler deployed, but didn’t say where. Check the Workers section of your Cloudflare dashboard.');
    return { url, adminUrl: 'https://dash.cloudflare.com/', state: { name } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
