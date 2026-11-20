import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import net from 'node:net';
import { outsideProject } from './agent.js';
import { findFreePort, isPortFree } from './processes.js';
import { Checkpoints, isInside } from './checkpoints.js';
import { injectBubble, BUBBLE_TAG } from './inject.js';
import { parseNewText } from './mockAgent.js';
import { detectProject, devCommand, ProjectError } from './project.js';
import { buildPrompt } from './prompt.js';
import { routeTask } from './router.js';

describe('router', () => {
  const route = (text: string, extra: Partial<Parameters<typeof routeTask>[0]> = {}) =>
    routeTask({ text, hasElement: false, ...extra });

  it('sends text changes to low effort', () => {
    assert.equal(route('change the headline to "Fresh bread daily"').effort, 'low');
    assert.equal(route('fix the typo in the footer').kind, 'copy');
    assert.equal(route('make the title say "Hello"').kind, 'copy');
  });
  it('sends style tweaks to low effort', () => {
    const r = route('make this button rounder', { hasElement: true });
    assert.equal(r.kind, 'style');
    assert.equal(r.effort, 'low');
    assert.equal(r.label, 'Quick');
  });
  it('sends new sections to medium effort', () => {
    assert.deepEqual([route('add a testimonials section').kind, route('add a testimonials section').effort], ['component', 'medium']);
  });
  it('sends data and auth features to high effort', () => {
    assert.equal(route('add a sign-up form that saves to a database').effort, 'high');
    assert.equal(route('let people log in').kind, 'feature');
  });
  it('sends bugs to high effort', () => {
    assert.equal(route("the page is blank, here's the error").kind, 'bug');
  });
  it('sends new apps to xhigh and never picks max on its own', () => {
    assert.equal(route('make me a booking app for my salon').effort, 'xhigh');
    assert.equal(route('make me a booking app', { mode: 'thorough', previousFailed: true }).effort, 'xhigh');
  });
  it('does not treat sizes in pixels as bugs', () => {
    assert.notEqual(route('make it 500px wide').kind, 'bug');
  });
  it('moves one level up after a failure and with the Thorough switch', () => {
    assert.equal(route('change the text to "Hi"', { previousFailed: true }).effort, 'medium');
    assert.equal(route('change the text to "Hi"', { mode: 'thorough' }).effort, 'medium');
    assert.equal(route('add a pricing section', { mode: 'quick' }).effort, 'low');
  });
  it('treats an unclear request on a picked element as small', () => {
    assert.equal(route('hmm, this one', { hasElement: true }).effort, 'low');
    assert.equal(route('hmm, this one').effort, 'medium');
  });
});

describe('injectBubble', () => {
  it('adds the script before </body>', () => {
    const out = injectBubble('<html><body><p>Hi</p></body></html>');
    assert.ok(out.includes(`<p>Hi</p>${BUBBLE_TAG}</body>`));
  });
  it('is idempotent and handles documents without a body', () => {
    const once = injectBubble('<p>fragment</p>');
    assert.equal(injectBubble(once), once);
    assert.ok(once.endsWith(BUBBLE_TAG));
  });
  it('uses the last </BODY>, case-insensitively', () => {
    const out = injectBubble('<BODY><script>"</body>"</script></BODY>');
    assert.ok(out.endsWith(`${BUBBLE_TAG}</BODY>`));
  });
});

function tempProject(pkg: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-test-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('project detection', () => {
  it('detects a Vite project and builds the npm dev command', () => {
    const dir = tempProject({ name: 'shop', scripts: { dev: 'vite' }, devDependencies: { vite: '^8.0.0' } });
    const info = detectProject(dir);
    assert.equal(info.framework, 'vite');
    assert.equal(info.packageManager, 'npm');
    assert.equal(info.needsInstall, true);
    assert.deepEqual(devCommand(info, 5199).args, ['run', 'dev', '--', '--port', '5199', '--strictPort']);
  });
  it('detects Next.js with pnpm (no -- separator)', () => {
    const dir = tempProject({ scripts: { dev: 'next dev' }, dependencies: { next: '16' } }, { 'pnpm-lock.yaml': '' });
    const info = detectProject(dir);
    assert.equal(info.framework, 'next');
    assert.deepEqual(devCommand(info, 3001), { cmd: 'pnpm', args: ['run', 'dev', '--port', '3001'], env: { PORT: '3001', BROWSER: 'none' } });
  });
  it('explains what is wrong with a folder it cannot run', () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-test-'));
    assert.throws(() => detectProject(empty), ProjectError);
    assert.throws(() => detectProject(tempProject({ scripts: { build: 'x' } })), /no "dev" or "start" script/);
  });
});

describe('checkpoints', () => {
  it('restores edited files and removes created ones', () => {
    const dir = tempProject({}, { 'src/App.jsx': 'old' });
    const cp = new Checkpoints(dir);
    cp.begin();
    cp.snapshot(path.join(dir, 'src/App.jsx'));
    cp.snapshot(path.join(dir, 'src/New.jsx'));
    writeFileSync(path.join(dir, 'src/App.jsx'), 'new');
    writeFileSync(path.join(dir, 'src/New.jsx'), 'created');
    cp.snapshot(path.join(dir, 'src/App.jsx')); // second snapshot keeps the first original
    assert.equal(cp.commit(), true);
    assert.deepEqual(cp.undo().files.sort(), ['src/App.jsx', 'src/New.jsx']);
    assert.equal(readFileSync(path.join(dir, 'src/App.jsx'), 'utf8'), 'old');
    assert.equal(existsSync(path.join(dir, 'src/New.jsx')), false);
    assert.equal(cp.canUndo(), false);
  });
  it('refuses files outside the project', () => {
    const dir = tempProject({});
    const cp = new Checkpoints(dir);
    cp.begin();
    assert.throws(() => cp.snapshot('/etc/hosts'));
    assert.equal(isInside(dir, path.join(dir, '..', 'other')), false);
  });
  it('does not keep an undo point for a task that changed nothing', () => {
    const cp = new Checkpoints(tempProject({}));
    cp.begin();
    assert.equal(cp.commit(), false);
    assert.equal(cp.canUndo(), false);
  });
});

describe('ports', () => {
  it('sees a port as taken when something listens on 127.0.0.1 only', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    assert.equal(await isPortFree(port), false);
    assert.notEqual(await findFreePort(port), port);
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('project boundary for agent tools', () => {
  const cwd = '/tmp/site';
  it('allows files and searches inside the project', () => {
    assert.equal(outsideProject(cwd, { file_path: 'src/App.jsx' }), null);
    assert.equal(outsideProject(cwd, { file_path: '/tmp/site/src/App.jsx' }), null);
    assert.equal(outsideProject(cwd, { pattern: 'src/**/*.jsx' }), null);
    assert.equal(outsideProject(cwd, { pattern: 'Welcome', path: 'src' }), null);
  });
  it('blocks reads, edits and searches that leave the project', () => {
    assert.match(outsideProject(cwd, { file_path: '/Users/me/.ssh/id_rsa' }) ?? '', /outside the project/);
    assert.match(outsideProject(cwd, { file_path: '../other/secret.txt' }) ?? '', /outside the project/);
    assert.match(outsideProject(cwd, { pattern: '/etc/**' }) ?? '', /outside the project/);
    assert.match(outsideProject(cwd, { pattern: '../**/*.env' }) ?? '', /outside the project/);
    assert.match(outsideProject(cwd, { pattern: 'x', path: '/' }) ?? '', /outside the project/);
  });
});

describe('prompts', () => {
  it('reads the new text out of a request', () => {
    assert.equal(parseNewText('change the text to "Fresh bread daily"'), 'Fresh bread daily');
    assert.equal(parseNewText('make it say “Hello hive”'), 'Hello hive');
    assert.equal(parseNewText('make it bigger'), undefined);
  });
  it('includes the picked element in the agent prompt', () => {
    const p = buildPrompt('make this bigger', { tag: 'h1', selector: 'main > h1', text: 'Welcome', html: '<h1>Welcome</h1>' });
    assert.match(p, /Picked element on the page:/);
    assert.match(p, /visible text: "Welcome"/);
    assert.equal(buildPrompt('  hi  '), 'hi');
  });
});
