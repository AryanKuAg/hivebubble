import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { createRequire } from 'node:module';
import { verifyApiKey } from './agent.js';
import { Checker } from './checks.js';
import { projectDataDir } from './home.js';
import { DevErrorCatcher } from './logs.js';
import { sourceFiles } from './mockAgent.js';
import { ManagedProcess, findFreePort, waitForPort } from './processes.js';
import { detectProject, devCommand, frameworkLabel, installCommand } from './project.js';
import { createProxy, extensionIds } from './proxy.js';
import { Session } from './session.js';
import { planSourceTags } from './sourceTags.js';
import type { AgentKind } from './types.js';

export type StartState = 'detecting' | 'installing' | 'starting' | 'ready' | 'stopped' | 'error';

export interface Reporter {
  status(state: StartState, message: string, extra?: Record<string, unknown>): void;
  log(source: 'install' | 'dev' | 'hivebubble', line: string): void;
  /** Other news for the desktop app, e.g. ('harness', { connected, client }). */
  event?(name: string, data: Record<string, unknown>): void;
}

export interface StartOptions {
  projectDir: string;
  /** Preview port to try first. */
  port?: number;
  /**
   * Who does the work. 'harness' (the default): a coding agent the person
   * runs, like Claude Code with Hivebubble's plugin; no API key. 'api':
   * Hivebubble's own Claude agent with an Anthropic API key. 'mock': demo mode.
   */
  agent?: 'harness' | 'api' | 'mock';
  apiKey?: string;
  maxBudgetUsd?: number;
  /** A request to put in the bubble's message box (from creating the app). */
  draft?: string;
  /** A dev server the person already runs, e.g. http://localhost:3000: nothing is installed or started. */
  attach?: string;
  reporter: Reporter;
}

/** The dev server to attach to: http on this machine, with a port. */
export function parseAttachUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    throw new Error(`"${raw}" isn't an address. Use one like http://localhost:3000.`);
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.port) {
    throw new Error(`Hivebubble attaches to a dev server on this computer, like http://localhost:3000 (got ${raw}).`);
  }
  return url;
}

export interface Running {
  url: string;
  stop(): Promise<void>;
}

export function bubbleScriptPath(): string {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@hivebubble/bubble/dist/bubble.js');
  if (!existsSync(file)) throw new Error('The bubble script is not built yet. Run `pnpm build` in the Hivebubble folder.');
  return file;
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: the preview is never exposed to the local network.
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

/**
 * .hivebubble/engine.json: where this engine listens and the key for its
 * coding-agent API. Readable by the person's own programs only (0600), so
 * Claude Code's plugin can find the engine and a web page never can.
 */
export function writeEngineFile(projectDir: string, data: { url: string; token: string; agent: AgentKind; project: string }): string {
  const file = path.join(projectDataDir(projectDir), 'engine.json');
  writeFileSync(file, `${JSON.stringify({ version: 1, ...data, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows keeps its own permissions.
  }
  return file;
}

function removeEngineFile(file: string): void {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
    if (data.pid === process.pid) rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}

export async function startHivebubble(opts: StartOptions): Promise<Running> {
  const r = opts.reporter;
  const attach = opts.attach ? parseAttachUrl(opts.attach) : null;
  r.status('detecting', 'Reading the project…');
  const info = detectProject(opts.projectDir);
  const project = { name: info.name, framework: frameworkLabel(info.framework) };
  r.log('hivebubble', `Project: ${info.name} (${project.framework}, ${info.packageManager}) at ${info.dir}`);

  const bubbleFile = bubbleScriptPath();
  let agent: AgentKind = opts.agent === 'mock' ? 'mock' : opts.agent === 'api' ? (opts.apiKey ? 'claude' : 'missing-key') : 'harness';
  if (agent === 'claude' && opts.apiKey) {
    const check = await verifyApiKey(opts.apiKey);
    if (check === 'rejected') {
      agent = 'invalid-key';
      r.log('hivebubble', 'Anthropic rejected the API key. The bubble will open, but Claude cannot make changes until you fix the key.');
    } else if (check === 'unknown') {
      r.log('hivebubble', "Couldn't check the API key (offline?). Tasks will report any problem.");
    }
  }
  if (agent === 'missing-key') r.log('hivebubble', 'No Anthropic API key found. The bubble will open, but Claude cannot make changes until you add a key.');
  if (agent === 'mock') r.log('hivebubble', 'Demo mode: a local stand-in agent that can only change text. No Claude calls.');
  if (agent === 'harness') {
    r.log('hivebubble', 'No API key needed: Claude Code does the work. In Claude Code, in this project’s folder, type /hivebubble:work.');
    r.log('hivebubble', 'First time? Add Hivebubble’s plugin to Claude Code: claude plugin marketplace add AryanKuAg/hivebubble, then claude plugin install hivebubble@hivebubble.');
  }

  let devPort: number | null = null;
  const log = (line: string) => r.log('hivebubble', line);
  const checker = new Checker(info, () => devPort, log);
  // Where the person's own dev server is (named in requests for a coding agent).
  const siteUrl = () => (attach ? attach.origin : devPort ? `http://localhost:${devPort}` : null);
  const session = new Session({
    site: siteUrl,
    cwd: info.dir,
    project,
    agent,
    apiKey: opts.apiKey,
    maxBudgetUsd: opts.maxBudgetUsd,
    draft: opts.draft,
    info,
    log,
    checker,
    // Only page files count: a project with nothing but config gets built from the start.
    isEmpty: () => sourceFiles(info.dir, 20).filter((f) => !/(?:^|[\\/])(?:index\.html|[\w.-]*config\.[cm]?[jt]s)$/.test(f)).length === 0,
  });

  // Errors in the dev server's output go to the logs summary (Users & Data).
  const devErrors = new DevErrorCatcher(session.errors);
  session.harness.onChange = (state) => r.event?.('harness', state);

  let stopping = false;
  let preview = '';
  // A new secret every run: the browser extension pairs again by itself.
  const pairing = { token: randomBytes(24).toString('base64url'), extensionIds: extensionIds() };
  // The coding agent's key: only in .hivebubble/engine.json, never sent to a page.
  const harnessToken = randomBytes(24).toString('base64url');
  const server = createProxy({
    target: () => devPort,
    bubbleJs: () => readFileSync(bubbleFile, 'utf8'),
    onClient: (ws) => session.attach(ws),
    health: () => ({
      ok: true,
      project: info.name,
      framework: project.framework,
      devPort,
      agent,
      sourceTags: session.sourceTags,
      preview,
      // The person's own dev server: the browser extension adds the bubble there.
      site: siteUrl(),
    }),
    pairing,
    harness: { token: harnessToken, handle: (name, body, client, signal) => session.harnessApi(name, body, client, signal) },
  });
  let proxyPort = await findFreePort(opts.port ?? 4321);
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server, proxyPort);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= 20) throw err;
      proxyPort = await findFreePort(proxyPort + 1);
    }
  }
  const url = `http://localhost:${proxyPort}`;
  preview = url;
  // How Claude Code's Hivebubble plugin finds this engine: the project's own folder.
  const engineFile = writeEngineFile(info.dir, { url: `http://127.0.0.1:${proxyPort}`, token: harnessToken, agent, project: info.name });

  const cleanupServer = () => {
    session.stop();
    server.close();
    server.closeAllConnections();
    removeEngineFile(engineFile);
  };

  if (attach) {
    // The person runs the dev server: nothing to install or start, and no source tags.
    devPort = Number(attach.port);
    r.log('hivebubble', `Attached to your dev server at ${attach.origin}. Hivebubble didn't start it, so source tags are off.`);
    r.log('hivebubble', `Open ${attach.origin} with the Hivebubble browser extension to get the bubble there, or use ${url}.`);
    r.status('ready', `Your site is live at ${url}`, { url, devPort, agent, project, sourceTags: false, spend: session.spend(), site: attach.origin });
    checker.warmUp();
    return {
      url,
      async stop() {
        stopping = true;
        cleanupServer();
        r.status('stopped', 'Stopped.');
      },
    };
  }

  if (info.needsInstall) {
    r.status('installing', `Installing packages with ${info.packageManager} (first run only)…`);
    const install = new ManagedProcess(installCommand(info), info.dir, (line) => r.log('install', line));
    const code = await install.exited;
    if (code !== 0) {
      cleanupServer();
      throw new Error(`Installing packages failed (exit code ${code}). The log above says why.`);
    }
  }

  const tags = planSourceTags(info);
  r.log(
    'hivebubble',
    tags.on
      ? 'Source tags are on: the picker knows where each element is written, and the bees fly to the exact element being changed.'
      : `Source tags are off because ${tags.why}. The bees fly near the right part of the page instead.`,
  );

  const wanted = await findFreePort(info.framework === 'next' ? 3000 : 5173);
  const startDev = async (extra: string[]) => {
    let reported: number | null = null;
    const proc = new ManagedProcess(devCommand(info, wanted, extra), info.dir, (line) => {
      r.log('dev', line);
      devErrors.line(line);
      const m = line.match(/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/);
      if (m && reported === null) reported = Number(m[1]);
    });
    const up = await waitForPort(() => reported ?? wanted, 120_000, () => proc.running);
    return { proc, port: up ? (reported ?? wanted) : null };
  };

  r.status('starting', 'Starting your dev server…');
  let started = await startDev(tags.on ? tags.args : []);
  if (started.port === null && tags.on && !started.proc.running) {
    // Never let source tags be the reason a project doesn't start.
    r.log('hivebubble', 'The dev server stopped while starting with source tags. Starting it again without them…');
    started = await startDev([]);
  } else {
    session.sourceTags = tags.on;
  }
  const dev = started.proc;
  if (started.port === null) {
    const stillRunning = dev.running;
    await dev.stop();
    cleanupServer();
    throw new Error(stillRunning ? 'The dev server did not start within 2 minutes.' : 'The dev server stopped while starting. The log above says why.');
  }
  devPort = started.port;
  r.status('ready', `Your site is live at ${url}`, { url, devPort, agent, project, sourceTags: session.sourceTags, spend: session.spend() });
  // Baselines for the type and build checks, so errors that were already there never count against a task.
  checker.warmUp();

  void dev.exited.then((code) => {
    if (stopping) return;
    devPort = null;
    r.status('error', `The dev server stopped (exit code ${code}). Fix the error in the log, then restart.`);
  });

  return {
    url,
    async stop() {
      stopping = true;
      await dev.stop();
      cleanupServer();
      r.status('stopped', 'Stopped.');
    },
  };
}
