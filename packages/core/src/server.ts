import { existsSync, readFileSync } from 'node:fs';
import type http from 'node:http';
import { createRequire } from 'node:module';
import { verifyApiKey } from './agent.js';
import { Checker } from './checks.js';
import { sourceFiles } from './mockAgent.js';
import { ManagedProcess, findFreePort, waitForPort } from './processes.js';
import { detectProject, devCommand, frameworkLabel, installCommand } from './project.js';
import { createProxy } from './proxy.js';
import { Session } from './session.js';
import { planSourceTags } from './sourceTags.js';
import type { AgentKind } from './types.js';

export type StartState = 'detecting' | 'installing' | 'starting' | 'ready' | 'stopped' | 'error';

export interface Reporter {
  status(state: StartState, message: string, extra?: Record<string, unknown>): void;
  log(source: 'install' | 'dev' | 'hivebubble', line: string): void;
}

export interface StartOptions {
  projectDir: string;
  /** Preview port to try first. */
  port?: number;
  /** 'mock' runs the demo agent; otherwise Claude runs when an API key is present. */
  agent?: 'auto' | 'mock';
  apiKey?: string;
  maxBudgetUsd?: number;
  /** A request to put in the bubble's message box (from creating the app). */
  draft?: string;
  reporter: Reporter;
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

export async function startHivebubble(opts: StartOptions): Promise<Running> {
  const r = opts.reporter;
  r.status('detecting', 'Reading the project…');
  const info = detectProject(opts.projectDir);
  const project = { name: info.name, framework: frameworkLabel(info.framework) };
  r.log('hivebubble', `Project: ${info.name} (${project.framework}, ${info.packageManager}) at ${info.dir}`);

  const bubbleFile = bubbleScriptPath();
  let agent: AgentKind = opts.agent === 'mock' ? 'mock' : opts.apiKey ? 'claude' : 'missing-key';
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

  let devPort: number | null = null;
  const log = (line: string) => r.log('hivebubble', line);
  const checker = new Checker(info, () => devPort, log);
  const session = new Session({
    cwd: info.dir,
    project,
    agent,
    apiKey: opts.apiKey,
    maxBudgetUsd: opts.maxBudgetUsd,
    draft: opts.draft,
    log,
    checker,
    // Only page files count: a project with nothing but config gets built from the start.
    isEmpty: () => sourceFiles(info.dir, 20).filter((f) => !/(?:^|[\\/])(?:index\.html|[\w.-]*config\.[cm]?[jt]s)$/.test(f)).length === 0,
  });

  let stopping = false;
  const server = createProxy({
    target: () => devPort,
    bubbleJs: () => readFileSync(bubbleFile, 'utf8'),
    onClient: (ws) => session.attach(ws),
    health: () => ({ ok: true, project: info.name, framework: project.framework, devPort, agent, sourceTags: session.sourceTags }),
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

  const cleanupServer = () => {
    session.stop();
    server.close();
    server.closeAllConnections();
  };

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
