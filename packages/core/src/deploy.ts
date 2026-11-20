import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderSVG } from 'uqr';
import { projectDataDir, readJson, writeJson } from './home.js';
import { deployCloudflare, deployNetlify, deployVercel, siteFiles, siteSlug, type Progress, type Runner } from './hosts.js';
import { sourceFiles } from './mockAgent.js';
import { ManagedProcess } from './processes.js';
import type { ProjectInfo } from './project.js';
import type { EnvNeed, HostCard, HostId, ServerEvent } from './types.js';

/**
 * The deploy wizard's engine (README §9): pick a host, check its account is
 * connected, check the environment variables the app reads, build locally,
 * upload with progress, then share the live URL and a QR code. Tokens come
 * from the environment: the Mac app passes them from the Keychain, and
 * command-line users put them in Hivebubble's .env.local.
 */

type HostInfo = Omit<HostCard, 'connected' | 'recommended' | 'lastUrl'>;

export const HOSTS: HostInfo[] = [
  {
    id: 'vercel',
    name: 'Vercel',
    bestFor: 'React and Next.js sites, and the simplest start',
    freePlan: 'Free for personal, non-commercial projects',
    steps: 4,
    time: 'About a minute',
    needs: ['VERCEL_TOKEN'],
    tokenUrl: 'https://vercel.com/account/tokens',
    connectSteps: ['Open the Tokens page of your Vercel account.', 'Create a token and name it “Hivebubble”.', 'Paste it into Hosting in the Hivebubble app, then restart the project.'],
    domainSteps: [
      'In Vercel, open the project, then Settings, then Domains, and add your domain.',
      'Vercel shows the DNS record to add. Add it where you bought the domain.',
      'Wait a few minutes. Vercel turns on HTTPS by itself.',
    ],
  },
  {
    id: 'netlify',
    name: 'Netlify',
    bestFor: 'Static sites, with a friendly dashboard',
    freePlan: 'Free plan available',
    steps: 4,
    time: 'About a minute',
    needs: ['NETLIFY_AUTH_TOKEN'],
    tokenUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
    connectSteps: ['Open Applications in your Netlify user settings.', 'Create a personal access token named “Hivebubble”.', 'Paste it into Hosting in the Hivebubble app, then restart the project.'],
    domainSteps: [
      'In Netlify, open the site, then Domain management, and add your domain.',
      'Netlify shows the DNS records to add, or offers to run your DNS for you.',
      'Wait a few minutes. Netlify turns on HTTPS by itself.',
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    bestFor: 'Fast sites on a global network',
    freePlan: 'Free plan available (Workers)',
    steps: 4,
    time: 'A minute or two the first time',
    needs: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'],
    tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    connectSteps: [
      'Open My Profile, then API Tokens, in Cloudflare.',
      'Create a token from the “Edit Cloudflare Workers” template.',
      'Copy your Account ID from the Workers & Pages overview.',
      'Paste both into Hosting in the Hivebubble app, then restart the project.',
    ],
    domainSteps: [
      'If your domain is on Cloudflare: open the Worker, then Settings, then Domains & Routes, and add a custom domain.',
      'Cloudflare creates the DNS record for you.',
      'Your domain elsewhere? Move its DNS to Cloudflare first, or use the workers.dev address.',
    ],
  },
];

interface DeployState {
  vercel?: { project: string };
  netlify?: { siteId: string; name: string };
  cloudflare?: { name: string };
  last?: { host: HostId; url: string; at: string; adminUrl?: string };
}

const stateFile = (project: string) => path.join(project, '.hivebubble', 'deploy.json');

export function readDeployState(project: string): DeployState {
  return readJson<DeployState>(stateFile(project), {});
}

const connected = (host: HostInfo, env: NodeJS.ProcessEnv) => host.needs.every((k) => Boolean(env[k]?.trim()));

export function hostCards(info: ProjectInfo, env: NodeJS.ProcessEnv = process.env): HostCard[] {
  const state = readDeployState(info.dir);
  // The host used last, else Vercel (first in the plan's order, and best for Next.js).
  const recommended = state.last?.host ?? 'vercel';
  return HOSTS.map((h) => ({
    ...h,
    connected: connected(h, env),
    recommended: h.id === recommended,
    lastUrl: state.last?.host === h.id ? state.last.url : undefined,
  }));
}

export function deploySupport(info: ProjectInfo): string | null {
  if (info.framework !== 'vite') return 'Putting a site online works for Vite projects so far';
  if (!existsSync(path.join(info.dir, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite'))) return 'Vite isn’t installed in this project yet';
  return null;
}

const BUILTIN_ENV = new Set(['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'NODE_ENV']);
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

/**
 * The environment variables the app reads (import.meta.env.X, process.env.X)
 * and whether a .env file sets them. Only names are read, never values, and
 * nothing here leaves the computer.
 */
export function envNeeds(project: string): EnvNeed[] {
  const used = new Map<string, Set<string>>();
  for (const file of sourceFiles(project, 3000)) {
    if (/\.(?:html|md|mdx)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\b(?:import\.meta\.env|process\.env)\.([A-Z_][A-Z0-9_]*)/g)) {
      if (BUILTIN_ENV.has(m[1])) continue;
      const set = used.get(m[1]) ?? new Set<string>();
      set.add(path.relative(project, file).split(path.sep).join('/'));
      used.set(m[1], set);
    }
  }
  const defined = new Set<string>();
  for (const name of ENV_FILES) {
    const file = path.join(project, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*\S/);
      if (m) defined.add(m[1]);
    }
  }
  return [...used].map(([name, files]) => ({ name, set: defined.has(name), usedIn: [...files].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.DS_Store') continue;
      const abs = path.join(d, name);
      if (statSync(abs).isDirectory()) walk(abs, `${prefix}${name}/`);
      else out.push(`${prefix}${name}`);
    }
  };
  walk(dir, '');
  return out;
}

/** Build with the project's own Vite config into a folder outside the project (the running dev server is left alone). */
export async function buildSite(info: ProjectInfo, signal: AbortSignal, onLine: (line: string) => void): Promise<{ dir: string; files: string[] }> {
  const out = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-deploy-'));
  const vite = path.join(info.dir, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
  const lines: string[] = [];
  const proc = new ManagedProcess({ cmd: vite, args: ['build', '--outDir', out, '--emptyOutDir'], env: { CI: '1' } }, info.dir, (line) => {
    lines.push(line);
    onLine(line);
  });
  const stop = () => void proc.stop();
  signal.addEventListener('abort', stop, { once: true });
  const code = await proc.exited;
  signal.removeEventListener('abort', stop);
  if (code !== 0) {
    rmSync(out, { recursive: true, force: true });
    const tail = lines.filter((l) => l.trim()).slice(-20).join('\n');
    throw Object.assign(new Error(signal.aborted ? 'Stopped.' : 'The build failed, so nothing was uploaded.'), { buildLog: tail });
  }
  const files = listFiles(out);
  if (!files.includes('index.html')) {
    rmSync(out, { recursive: true, force: true });
    throw new Error('The build has no index.html at its top level, so there is no page to put online.');
  }
  return { dir: out, files };
}

export interface DeployOptions {
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Replaces Wrangler for Cloudflare (tests). */
  run?: Runner;
  pollMs?: number;
}

/** The whole deploy, reported as `deploy` events. Resolves with the live URL. */
export async function deploySite(info: ProjectInfo, hostId: HostId, emit: (e: Extract<ServerEvent, { type: 'deploy' }>) => void, opts: DeployOptions): Promise<string> {
  const env = opts.env ?? process.env;
  const host = HOSTS.find((h) => h.id === hostId);
  if (!host) throw new Error(`Unknown host "${hostId}".`);
  const started = Date.now();
  const say = (phase: 'build' | 'upload' | 'finalize', message: string, extra: Partial<Extract<ServerEvent, { type: 'deploy' }>> = {}) =>
    emit({ type: 'deploy', host: hostId, phase, message, ...extra });
  try {
    const unsupported = deploySupport(info);
    if (unsupported) throw new Error(`${unsupported}.`);
    if (!connected(host, env)) throw new Error(`Connect your ${host.name} account first: ${host.connectSteps.join(' ')}`);

    say('build', 'Building the site on this computer first');
    const built = await buildSite(info, opts.signal, () => undefined);
    try {
      const files = siteFiles(built.dir, built.files);
      if (files.length > 5000) throw new Error(`The build has ${files.length} files, more than Hivebubble uploads.`);
      say('build', `Built ${files.length} files`, { done: files.length, total: files.length });
      const progress: Progress = (p) => say(p.phase, p.message, { done: p.done, total: p.total, file: p.file });
      const state = readDeployState(info.dir);
      const name = siteSlug(info.name);
      const published =
        hostId === 'vercel'
          ? await deployVercel(files, { token: env.VERCEL_TOKEN!, teamId: env.VERCEL_TEAM_ID || undefined, name: state.vercel?.project ?? name, signal: opts.signal, pollMs: opts.pollMs }, progress)
          : hostId === 'netlify'
            ? await deployNetlify(files, { token: env.NETLIFY_AUTH_TOKEN!, name, siteId: state.netlify?.siteId, signal: opts.signal, pollMs: opts.pollMs }, progress)
            : await deployCloudflare(built.dir, { token: env.CLOUDFLARE_API_TOKEN!, accountId: env.CLOUDFLARE_ACCOUNT_ID!, name: state.cloudflare?.name ?? name, signal: opts.signal, run: opts.run }, progress);
      // Remember the site, so the next deploy updates it instead of making another.
      projectDataDir(info.dir);
      const next: DeployState = { ...state, [hostId]: published.state, last: { host: hostId, url: published.url, at: new Date().toISOString(), adminUrl: published.adminUrl } };
      writeJson(stateFile(info.dir), next);
      emit({
        type: 'deploy',
        host: hostId,
        phase: 'live',
        message: `Live on ${host.name}`,
        url: published.url,
        adminUrl: published.adminUrl,
        qrSvg: renderSVG(published.url, { border: 1 }),
        durationMs: Date.now() - started,
      });
      return published.url;
    } finally {
      rmSync(built.dir, { recursive: true, force: true });
    }
  } catch (err) {
    const message = opts.signal.aborted ? 'Stopped. Nothing new went online.' : err instanceof Error ? err.message : String(err);
    emit({ type: 'deploy', host: hostId, phase: 'failed', message, buildLog: (err as { buildLog?: string }).buildLog, durationMs: Date.now() - started });
    throw err;
  }
}
