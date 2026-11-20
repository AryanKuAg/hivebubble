#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnvFiles } from './env.js';
import { sourceUrl } from './github.js';
import { skillRegistry, starterRegistry } from './registry.js';
import { startHivebubble, type Reporter, type Running } from './server.js';
import { installSkill, listSkills, removeSkill, skillUpdateDiff, updateSkill } from './skills.js';
import { createFromStarter, findStarter, folderName, pickStarter } from './starters.js';
import { VERSION } from './version.js';

const HELP = `Hivebubble ${VERSION}: talk to your website, watch the hive build it.

Usage:
  hivebubble [project-folder] [options]       Run a project with the bubble
  hivebubble new <folder> [--for "<what>"]    Create a project from a starter
  hivebubble starters                         List the starters
  hivebubble skills <list|add|remove|diff|update> <project> [skill]

Options:
  --port <n>          Preview port to try first (default 4321)
  --mock-agent        Demo mode: a local stand-in agent, no Claude calls
  --max-budget <usd>  Spending limit for one task (default: the saved setting, $2)
  --daily-cap <usd>   Pause once Claude has cost this much today (default: the saved setting, $5)
  --prompt <text>     Put this request in the bubble's message box
  --attach <url>      Use a dev server you already run (e.g. http://localhost:3000)
                      instead of starting one; the browser extension adds the bubble to it
  --no-open           Don't open the browser
  --json              Print machine-readable output (used by the Mac app)
  --exit-with-stdin   Stop when stdin closes (used by the Mac app)
  -h, --help          Show this help
  -v, --version       Show the version

new: --for "<what to build>" picks the starter (or --starter <id>); --accept-license
     allows a starter whose license has obligations.

Claude needs your own Anthropic API key in ANTHROPIC_API_KEY (or in .env.local).`;

function run(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      'mock-agent': { type: 'boolean', default: false },
      'max-budget': { type: 'string' },
      'daily-cap': { type: 'string' },
      prompt: { type: 'string' },
      attach: { type: 'string' },
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
  // Read fresh before every task (readSettings), so the flag wins over the saved setting.
  if (values['daily-cap']) process.env.HIVEBUBBLE_DAILY_CAP = values['daily-cap'];

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
    draft: values.prompt,
    attach: values.attach,
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

// ---- subcommands: starters and skills (the Mac app uses them with --json) ----

async function subcommand(name: string, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      for: { type: 'string' },
      starter: { type: 'string' },
      'accept-license': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const out = (data: unknown, text: string) => console.log(values.json ? JSON.stringify(data) : text);
  try {
    if (name === 'starters') {
      const { starters } = starterRegistry();
      out(starters, starters.map((s) => `${s.id.padEnd(16)} ${s.title}: ${s.description}`).join('\n'));
      return 0;
    }
    if (name === 'new') {
      const want = values.for ?? '';
      const starter = values.starter ? findStarter(values.starter) : pickStarter(want);
      // A folder named on the command line is used as is; a made-up name gets a number if it's taken.
      const dir = positionals[0] ? path.resolve(positionals[0]) : freeFolder(path.resolve(folderName(want, starter)));
      const created = await createFromStarter(dir, starter.id, { acceptLicense: values['accept-license'] });
      out(
        { dir: created.dir, starter: { id: starter.id, title: starter.title }, files: created.files, prompt: want || undefined },
        `Created ${created.dir} from the ${starter.title} starter (${created.files} files).\nStart it with: hivebubble ${JSON.stringify(created.dir)}${want ? ` --prompt ${JSON.stringify(want)}` : ''}`,
      );
      return 0;
    }
    if (name === 'skills') {
      const [action, project, skill] = positionals;
      if (!action || !project) throw new Error('Usage: hivebubble skills <list|add|remove|diff|update> <project> [skill]');
      const dir = path.resolve(project);
      if (action === 'list') {
        const installed = listSkills(dir);
        const ids = new Set(installed.map((s) => s.id));
        const available = skillRegistry()
          .filter((e) => !ids.has(e.id))
          .map((e) => ({ id: e.id, name: e.name, title: e.title, description: e.description, author: e.author, license: e.license, verified: e.verified, scripts: e.scripts, network: e.network, url: sourceUrl(e.source), reviewed: e.reviewed }));
        const lines = [...installed.map((s) => `● ${s.title} (${s.byHand ? 'added by hand' : `${s.version}${s.update ? `, update to ${s.update.version}` : ''}`})`), ...available.map((a) => `○ ${a.title} (${a.id})`)];
        out({ installed, available }, lines.join('\n') || 'No skills.');
        return 0;
      }
      if (!skill) throw new Error(`Name the skill to ${action}.`);
      if (action === 'add') {
        const added = await installSkill(dir, skill, 'Added in the Skills screen');
        out({ skill: added }, `Added ${added.title} (${added.version}).`);
      } else if (action === 'remove') {
        const removed = removeSkill(dir, skill);
        out({ removed }, removed ? `Removed ${skill}.` : `${skill} isn't installed.`);
      } else if (action === 'diff') {
        const diff = await skillUpdateDiff(dir, skill);
        out({ diff }, diff ? `${skill}: ${diff.from} → ${diff.to} (reviewed ${diff.reviewed})\n${diff.skillMd}` : `${skill} is up to date.`);
      } else if (action === 'update') {
        const updated = await updateSkill(dir, skill);
        out({ skill: updated }, `Updated ${updated.title} to ${updated.version}.`);
      } else {
        throw new Error(`Unknown action "${action}".`);
      }
      return 0;
    }
    throw new Error(`Unknown command "${name}".`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (values.json) console.log(JSON.stringify({ error: message }));
    else console.error(`✖ ${message}`);
    return 1;
  }
}

function freeFolder(base: string): string {
  const taken = (dir: string) => existsSync(dir) && readdirSync(dir).some((n) => n !== '.DS_Store');
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now().toString(36)}`;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => undefined).unref();
}

const [first, ...rest] = process.argv.slice(2);
if (first === 'new' || first === 'skills' || first === 'starters') {
  void subcommand(first, rest).then((code) => process.exit(code));
} else {
  run();
}
