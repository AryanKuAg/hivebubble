#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnvFiles } from './env.js';
import { startHivebubble, type Reporter, type Running } from './server.js';
import { VERSION } from './version.js';

const HELP = `Hivebubble ${VERSION}: talk to your website, watch the hive build it.

Usage: hivebubble [project-folder] [options]

Options:
  --port <n>          Preview port to try first (default 4321)
  --mock-agent        Demo mode: a local stand-in agent, no Claude calls
  --max-budget <usd>  Spending limit for one task (default 2)
  --no-open           Don't open the browser
  --json              Print machine-readable events (used by the Mac app)
  --exit-with-stdin   Stop when stdin closes (used by the Mac app)
  -h, --help          Show this help
  -v, --version       Show the version

Claude needs your own Anthropic API key in ANTHROPIC_API_KEY (or in .env.local).`;

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'mock-agent': { type: 'boolean', default: false },
      'max-budget': { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'exit-with-stdin': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(VERSION);

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  loadEnvFiles([path.join(process.cwd(), '.env.local'), path.join(repoRoot, '.env.local')]);

  const json = values.json;
  const reporter: Reporter = json
    ? {
        status: (state, message, extra) => console.log(JSON.stringify({ event: 'status', state, message, ...extra })),
        log: (source, line) => console.log(JSON.stringify({ event: 'log', source, line })),
      }
    : {
        status: (state, message) => console.log(`${state === 'error' ? '✖' : state === 'ready' ? '🐝' : '›'} ${message}`),
        log: (source, line) => console.log(`  ${source === 'hivebubble' ? '' : `[${source}] `}${line}`),
      };

  const projectDir = path.resolve(positionals[0] ?? process.cwd());
  let running: Running | null = null;
  let stopping = false;

  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    await running?.stop().catch(() => undefined);
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  if (values['exit-with-stdin']) {
    process.stdin.resume();
    process.stdin.on('end', () => void shutdown(0));
  }

  startHivebubble({
    projectDir,
    port: values.port ? Number(values.port) : undefined,
    agent: values['mock-agent'] ? 'mock' : 'auto',
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxBudgetUsd: values['max-budget'] ? Number(values['max-budget']) : undefined,
    reporter,
  })
    .then((r) => {
      running = r;
      if (stopping) return void r.stop();
      if (!values['no-open'] && !json) openBrowser(r.url);
    })
    .catch((err: unknown) => {
      reporter.status('error', err instanceof Error ? err.message : String(err));
      void shutdown(1);
    });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

main();
