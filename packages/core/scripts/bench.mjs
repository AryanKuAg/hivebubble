// The Smart Router benchmark (README §6): every prompt in bench/prompts.json runs
// on a fresh copy of the example project, once at the router's effort ("auto")
// and once at max effort ("max"), and is graded with its "done" checks. It
// prints time, cost and pass rate per mode, which is where the numbers for
// "Auto effort vs. always-max" come from.
//
//   pnpm bench                     # show the plan and a rough cost, run nothing
//   pnpm bench --yes               # run it with Claude (uses your API key, costs money)
//   pnpm bench --mock --yes        # run the pipeline with the demo agent, no Claude calls
//
// Options: --only id,id   --modes auto,max   --max-usd 15 (stop when reached)
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(here, '..');
const repo = path.resolve(core, '../..');
const { runClaude } = await import(path.join(core, 'dist/agent.js'));
const { runMock } = await import(path.join(core, 'dist/mockAgent.js'));
const { routeTask } = await import(path.join(core, 'dist/router.js'));
const { Checkpoints } = await import(path.join(core, 'dist/checkpoints.js'));
const { estimateCost } = await import(path.join(core, 'dist/cost.js'));
const { buildPrompt } = await import(path.join(core, 'dist/prompt.js'));
const { loadEnvFiles } = await import(path.join(core, 'dist/env.js'));

const { values } = parseArgs({
  options: {
    yes: { type: 'boolean', default: false },
    mock: { type: 'boolean', default: false },
    only: { type: 'string' },
    modes: { type: 'string', default: 'auto,max' },
    'max-usd': { type: 'string', default: '15' },
  },
});

const set = JSON.parse(readFileSync(path.join(core, 'bench/prompts.json'), 'utf8'));
const example = path.join(repo, set.project);
const only = values.only ? new Set(values.only.split(',')) : null;
const cases = set.prompts.filter((c) => !only || only.has(c.id));
const modes = values.modes.split(',').filter((m) => m === 'auto' || m === 'max');
const maxUsd = Number(values['max-usd']);

function route(c, mode) {
  const r = routeTask({ text: c.prompt, hasElement: Boolean(c.element), elementSrc: c.element?.src });
  return mode === 'max' ? { ...r, effort: 'max' } : r;
}

// ---- the plan ----------------------------------------------------------------

let low = 0;
let high = 0;
for (const c of cases) for (const m of modes) {
  const e = estimateCost(route(c, m).effort, []);
  low += e.lowUsd;
  high += e.highUsd;
}
console.log(`${cases.length} prompts × ${modes.join(' + ')} = ${cases.length * modes.length} runs on ${set.project}.`);
if (!values.mock) console.log(`Rough cost with Claude: $${low.toFixed(2)}–$${high.toFixed(2)} (stops at $${maxUsd}).`);
if (!values.yes) {
  console.log('\nNothing ran. Add --yes to run it' + (values.mock ? '.' : ' (it uses your Anthropic API key), or --mock --yes for a free dry run.'));
  process.exit(0);
}
loadEnvFiles([path.join(repo, '.env.local')]);
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!values.mock && !apiKey) {
  console.error('Set ANTHROPIC_API_KEY (or put it in .env.local) to run the benchmark with Claude.');
  process.exit(1);
}
if (!existsSync(path.join(example, 'node_modules'))) {
  console.error(`Install the example first: cd ${set.project} && npm install`);
  process.exit(1);
}

// ---- one run -------------------------------------------------------------------

function copyExample() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-bench-'));
  for (const name of readdirSync(example)) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist') continue;
    cpSync(path.join(example, name), path.join(dir, name), { recursive: true });
  }
  symlinkSync(path.join(example, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

function filesUnder(dir, sub) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(path.join(dir, sub));
  return out;
}

function build(dir) {
  const out = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-bench-build-'));
  const r = spawnSync(path.join(dir, 'node_modules/.bin/vite'), ['build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: dir, encoding: 'utf8', timeout: 180_000 });
  rmSync(out, { recursive: true, force: true });
  return r.status === 0;
}

/** Grade a run with the prompt's "done" checks. */
function grade(c, dir, before) {
  const read = (f) => (existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : '');
  const failures = [];
  let built = null;
  for (const d of c.done) {
    if (d.file && d.includes !== undefined && !read(d.file).includes(d.includes)) failures.push(`${d.file} lacks "${d.includes}"`);
    if (d.file && d.excludes !== undefined && read(d.file).includes(d.excludes)) failures.push(`${d.file} still has "${d.excludes}"`);
    if (d.file && d.matches && !new RegExp(d.matches, 'i').test(read(d.file))) failures.push(`${d.file} doesn't match /${d.matches}/`);
    if (d.anyFile && !filesUnder(dir, d.anyFile).some((f) => new RegExp(d.matches, 'i').test(readFileSync(f, 'utf8')))) failures.push(`nothing in ${d.anyFile} matches /${d.matches}/`);
    if (d.changed && !d.changed.some((f) => read(f) !== before.get(f))) failures.push(`none of ${d.changed.join(', ')} changed`);
    if (d.unchanged && [...before].some(([f, text]) => read(f) !== text)) failures.push('files changed');
    // The production build compiles every module, so it stands in for the page check here.
    if (d.check === 'page' || d.check === 'build') {
      built ??= build(dir);
      if (!built) failures.push('the build fails');
    }
  }
  return failures;
}

async function run(c, mode) {
  const dir = copyExample();
  try {
    for (const s of c.setup ?? []) {
      const file = path.join(dir, s.file);
      writeFileSync(file, readFileSync(file, 'utf8').replace(s.replace[0], s.replace[1]));
    }
    const before = new Map(filesUnder(dir, 'src').map((f) => [path.relative(dir, f), readFileSync(f, 'utf8')]));
    const r = route(c, mode);
    const checkpoints = new Checkpoints(dir, { persist: false });
    checkpoints.begin(c.prompt);
    const ctx = { cwd: dir, emit: () => undefined, checkpoints, abort: new AbortController() };
    const started = Date.now();
    const result = values.mock
      ? await runMock(ctx, { text: c.prompt, element: c.element }, { pace: 0 })
      : await runClaude(ctx, { prompt: buildPrompt(c.prompt, c.element), route: r, apiKey, maxBudgetUsd: 4 });
    const durationMs = Date.now() - started;
    const failures = grade(c, dir, before);
    return { id: c.id, kind: r.kind, mode, effort: r.effort, agentOk: result.ok, pass: failures.length === 0, failures, costUsd: result.costUsd ?? 0, durationMs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- the benchmark -------------------------------------------------------------

const results = [];
let spent = 0;
for (const c of cases) {
  for (const mode of modes) {
    if (spent >= maxUsd) break;
    const r = await run(c, mode);
    spent += r.costUsd;
    results.push(r);
    console.log(`${r.pass ? '✔' : '✖'} ${r.id.padEnd(24)} ${mode.padEnd(4)} ${r.effort.padEnd(6)} ${(r.durationMs / 1000).toFixed(1).padStart(6)}s  $${r.costUsd.toFixed(3)}${r.failures.length ? `  (${r.failures.join('; ')})` : ''}`);
  }
}

const sum = (rows, k) => rows.reduce((t, r) => t + r[k], 0);
console.log('\n| Mode | Runs | Pass rate | Total time | Total cost |\n|---|---|---|---|---|');
const byMode = {};
for (const mode of modes) {
  const rows = results.filter((r) => r.mode === mode);
  if (rows.length === 0) continue;
  byMode[mode] = { runs: rows.length, pass: rows.filter((r) => r.pass).length, seconds: sum(rows, 'durationMs') / 1000, usd: sum(rows, 'costUsd') };
  const m = byMode[mode];
  console.log(`| ${mode} | ${m.runs} | ${Math.round((m.pass / m.runs) * 100)}% | ${m.seconds.toFixed(0)}s | $${m.usd.toFixed(2)} |`);
}
if (byMode.auto && byMode.max && byMode.auto.seconds > 0 && byMode.auto.usd > 0) {
  console.log(`\nAuto effort vs. always-max: ${(byMode.max.seconds / byMode.auto.seconds).toFixed(1)}× faster, ${(byMode.max.usd / byMode.auto.usd).toFixed(1)}× cheaper, passing ${byMode.auto.pass}/${byMode.auto.runs} vs ${byMode.max.pass}/${byMode.max.runs}.`);
}
const outDir = path.join(core, 'bench/results');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}${values.mock ? '-mock' : ''}.json`);
writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), mock: values.mock, modes, results, byMode }, null, 2)}\n`);
console.log(`\nResults: ${path.relative(repo, file)}`);
