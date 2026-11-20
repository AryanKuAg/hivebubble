import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { outsideProject } from './agent.js';
import { Checkpoints } from './checkpoints.js';
import {
  Locator,
  changedLines,
  cssRules,
  cssSelectors,
  grepHits,
  lineAt,
  pageSelector,
  parseSourceTag,
  patchLines,
  spanLines,
} from './locate.js';
import { runMock } from './mockAgent.js';
import { insideProject, projectRelative } from './paths.js';
import { detectProject, devCommand, type ProjectInfo } from './project.js';
import { buildPrompt } from './prompt.js';
import { findViteConfig, planSourceTags, sourceTagsBlocker, viteWrapperSource } from './sourceTags.js';
import type { ServerEvent, ToolEvent } from './types.js';

function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-m2-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('line ranges', () => {
  const text = 'one\ntwo\nthree\nfour\n';
  it('finds the lines a span covers', () => {
    assert.equal(lineAt(text, 0), 1);
    assert.equal(lineAt(text, text.indexOf('three')), 3);
    assert.deepEqual(spanLines(text, text.indexOf('two'), 'two\nthree'.length), [2, 3]);
    assert.deepEqual(spanLines(text, text.indexOf('two'), 'two\n'.length), [2, 2]);
  });
  it('finds the changed lines between two versions', () => {
    assert.deepEqual(changedLines('a\nb\nc\nd', 'a\nB\nC\nd'), { before: [2, 3], after: [2, 3] });
    assert.deepEqual(changedLines('a\nb\nc', 'a\nb\nnew\nc'), { before: [3, 3], after: [3, 3] });
    assert.deepEqual(changedLines('a\nb\nc', 'a\nc'), { before: [2, 2], after: [2, 2] });
    assert.deepEqual(changedLines('same', 'same'), {});
  });
  it('reads changed lines from a structured patch, without context lines', () => {
    const patch = [{ oldStart: 10, oldLines: 7, newStart: 10, newLines: 8, lines: [' a', ' b', ' c', '-old', '+new 1', '+new 2', ' d', ' e', ' f'] }];
    assert.deepEqual(patchLines(patch), [13, 14]);
    assert.deepEqual(patchLines([{ newStart: 5, lines: [' x', '-gone', ' y'] }]), [5, 6]);
    assert.equal(patchLines(undefined), undefined);
  });
  it('parses source tags', () => {
    assert.deepEqual(parseSourceTag('src/App.jsx:12:7'), { file: 'src/App.jsx', line: 12, column: 7 });
    assert.deepEqual(parseSourceTag('src/App.jsx:12'), { file: 'src/App.jsx', line: 12, column: undefined });
    assert.equal(parseSourceTag('nope'), null);
  });
});

describe('stylesheets', () => {
  const css = [
    ':root { --honey: #f2a71b; }', // 1
    '/* cards { not a rule } */', // 2
    '.menu ul { display: grid; }', // 3
    '.menu li {', // 4
    '  padding: 20px;', // 5
    '  background: url("http://x/y.png");', // 6
    '}', // 7
    '@media (max-width: 600px) {', // 8
    '  .button:hover, .hero h1::after { color: red; }', // 9
    '}', // 10
    '@keyframes pop { from { opacity: 0 } to { opacity: 1 } }', // 11
    '.card { &:focus-visible { outline: 0 } .title { margin: 0 } }', // 12
  ].join('\n');

  it('reads rules with their lines, through comments, media queries and nesting', () => {
    const rules = cssRules(css).map((r) => [r.selectors.join(', '), r.start, r.end]);
    assert.deepEqual(rules, [
      [':root', 1, 1],
      ['.menu ul', 3, 3],
      ['.menu li', 4, 7],
      ['.button:hover, .hero h1::after', 9, 9],
      ['.card', 12, 12],
      ['.card:focus-visible', 12, 12],
      ['.card .title', 12, 12],
    ]);
  });
  it('turns the rules an edit touches into selectors the page can match', () => {
    assert.deepEqual(cssSelectors(css, [5, 5]), ['.menu li']);
    assert.deepEqual(cssSelectors(css, [9, 9]), ['.button', '.hero h1']);
    assert.deepEqual(cssSelectors(css, [11, 11]), []);
    assert.deepEqual(cssSelectors(css).slice(0, 3), [':root', '.menu ul', '.menu li']);
  });
  it('strips state-only pseudo-classes but keeps structural ones', () => {
    assert.equal(pageSelector('.nav a:hover'), '.nav a');
    assert.equal(pageSelector('.x:focus-visible'), '.x');
    assert.equal(pageSelector('li:first-child::before'), 'li:first-child');
    assert.equal(pageSelector('input::-webkit-input-placeholder'), 'input');
    assert.equal(pageSelector(':hover'), null);
    assert.equal(pageSelector('& + &'), null);
  });
});

describe('locator', () => {
  it('locates an edit before and after it happens', () => {
    const dir = tempDir({ 'src/Hero.jsx': 'a\n<h1>\n  Hello\n</h1>\nb\n' });
    const file = path.join(dir, 'src/Hero.jsx');
    const loc = new Locator(dir);
    const input = { file_path: file, old_string: '  Hello\n', new_string: '  Hi\n  there\n' };
    assert.deepEqual(loc.start('t1', 'Edit', input), { lines: [3, 3] });
    writeFileSync(file, 'a\n<h1>\n  Hi\n  there\n</h1>\nb\n');
    // Without a structured patch it finds the new text where the old one was.
    assert.deepEqual(loc.end('t1', 'Edit', input, {}), { lines: [3, 4] });
    // With one, it trusts the patch.
    loc.start('t2', 'Edit', { ...input, old_string: 'b\n' });
    assert.deepEqual(loc.end('t2', 'Edit', input, { structuredPatch: [{ newStart: 4, lines: [' x', '+y'] }] }), { lines: [5, 5] });
  });
  it('gives selectors for stylesheet edits and line ranges for partial reads', () => {
    const dir = tempDir({ 'App.css': '.a { color: red; }\n.b {\n  margin: 0;\n}\n' });
    const loc = new Locator(dir);
    assert.deepEqual(loc.start('c', 'Edit', { file_path: path.join(dir, 'App.css'), old_string: 'margin: 0;' }), { lines: [3, 3], selectors: ['.b'] });
    assert.deepEqual(loc.start('r', 'Read', { file_path: 'App.css', offset: 2, limit: 3 }), { lines: [2, 4], selectors: ['.b'] });
    assert.deepEqual(loc.start('w', 'Write', { file_path: 'new.jsx', content: 'x' }), {});
  });
  it('finds search hits in content and file-list results', () => {
    const dir = tempDir({ 'src/A.jsx': 'x' });
    const content = `${path.join(dir, 'src/A.jsx')}:3:  <h1>Welcome</h1>\nsrc/B.jsx-4-  context line\nsrc/B.jsx:9:Welcome`;
    assert.deepEqual(grepHits(dir, { pattern: 'Welcome' }, { content }), [
      { file: 'src/A.jsx', line: 3 },
      { file: 'src/B.jsx', line: 9 },
    ]);
    assert.deepEqual(grepHits(dir, { pattern: 'x', path: 'src/A.jsx' }, { content: '12:found' }), [{ file: 'src/A.jsx', line: 12 }]);
    assert.deepEqual(grepHits(dir, {}, { filenames: [path.join(dir, 'src/A.jsx'), '/etc/hosts'] }), [{ file: 'src/A.jsx' }]);
  });
});

describe('symlinks and the project boundary', () => {
  it('blocks links that lead outside the project and allows a project opened through a link', () => {
    const outside = tempDir({ 'secret.txt': 'shh' });
    const dir = tempDir({ 'src/App.jsx': 'x' });
    symlinkSync(outside, path.join(dir, 'escape'));
    assert.match(outsideProject(dir, { file_path: path.join(dir, 'escape/secret.txt') }) ?? '', /outside the project/);
    assert.equal(insideProject(dir, 'escape/secret.txt'), false);
    assert.throws(() => {
      const cp = new Checkpoints(dir);
      cp.begin();
      cp.snapshot(path.join(dir, 'escape/secret.txt'));
    });

    const link = path.join(tempDir(), 'link');
    symlinkSync(dir, link);
    assert.equal(outsideProject(link, { file_path: path.join(realpathSync(dir), 'src/App.jsx') }), null);
    assert.equal(outsideProject(link, { file_path: 'src/New.jsx' }), null);
    assert.equal(projectRelative(link, path.join(realpathSync(dir), 'src/App.jsx')), 'src/App.jsx');
  });
});

describe('source tags setup', () => {
  const vite = (extra: Partial<ProjectInfo> = {}): ProjectInfo => ({
    dir: '/x',
    name: 'x',
    framework: 'vite',
    packageManager: 'npm',
    devScript: 'dev',
    devScriptCommand: 'vite',
    needsInstall: false,
    ...extra,
  });
  it('only turns on for scripts that start Vite directly', () => {
    assert.equal(sourceTagsBlocker(vite(), {}), null);
    assert.equal(sourceTagsBlocker(vite({ devScriptCommand: 'vite --host 0.0.0.0' }), {}), null);
    assert.equal(sourceTagsBlocker(vite({ devScriptCommand: 'npx vite dev' }), {}), null);
    assert.match(sourceTagsBlocker(vite({ framework: 'next', devScriptCommand: 'next dev' }), {}) ?? '', /only work with Vite/);
    assert.match(sourceTagsBlocker(vite({ devScriptCommand: 'npm run gen && vite' }), {}) ?? '', /doesn't start Vite directly/);
    assert.match(sourceTagsBlocker(vite({ devScriptCommand: 'vite --config other.config.js' }), {}) ?? '', /its own Vite config/);
    assert.match(sourceTagsBlocker(vite(), { HIVEBUBBLE_SOURCE_TAGS: '0' }) ?? '', /turned off/);
  });
  it('writes a config that loads the person\'s own one, and passes it to Vite', () => {
    const dir = tempDir({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '8' } }), 'vite.config.ts': 'export default {}' });
    const info = detectProject(dir);
    assert.equal(info.devScriptCommand, 'vite');
    const plan = planSourceTags(info, () => 'file:///hb/source-tags/dist/vite.js');
    assert.deepEqual(plan, { on: true, args: ['--config', '.hivebubble/vite.config.mjs'] });
    const wrapper = readFileSync(path.join(dir, '.hivebubble/vite.config.mjs'), 'utf8');
    assert.ok(wrapper.includes(JSON.stringify(path.join(dir, 'vite.config.ts'))));
    assert.ok(wrapper.includes('"file:///hb/source-tags/dist/vite.js"'));
    assert.equal(readFileSync(path.join(dir, '.hivebubble/.gitignore'), 'utf8').trim().split('\n').pop(), '*');
    assert.deepEqual(devCommand(info, 5173, plan.on ? plan.args : []).args, ['run', 'dev', '--', '--config', '.hivebubble/vite.config.mjs', '--port', '5173', '--strictPort']);
    assert.equal(findViteConfig(tempDir()), null);
    assert.ok(viteWrapperSource('/p', null, 'file:///x').includes('const userConfig = null;'));
  });
});

describe('demo agent with source tags', () => {
  const run = async (dir: string, src?: string) => {
    const events: ServerEvent[] = [];
    const cp = new Checkpoints(dir);
    cp.begin();
    const result = await runMock(
      { cwd: dir, emit: (e) => events.push(e), checkpoints: cp, abort: new AbortController() },
      { text: 'change the text to "Fresh bread"', element: { tag: 'p', selector: 'p.lede', text: 'Small-batch bread', html: '<p>Small-batch bread</p>', src } },
      { pace: 0.02 },
    );
    return { result, tools: events.filter((e): e is ToolEvent => e.type === 'tool') };
  };
  const files = { 'src/Hero.jsx': 'export const Hero = () => (\n  <header>\n    <p className="lede">Small-batch bread</p>\n  </header>\n);\n' };

  it('goes straight to the tagged file and line, without searching', async () => {
    const dir = tempDir(files);
    const { result, tools } = await run(dir, 'src/Hero.jsx:3:5');
    assert.equal(result.ok, true);
    assert.deepEqual(tools.filter((t) => t.phase === 'start').map((t) => t.tool), ['Read', 'Edit']);
    assert.deepEqual(tools[0].lines, [1, 11]);
    const edit = tools.filter((t) => t.tool === 'Edit');
    assert.deepEqual(edit.map((t) => t.lines), [[3, 3], [3, 3]]);
    assert.equal(edit[1].ok, true);
    assert.ok(readFileSync(path.join(dir, 'src/Hero.jsx'), 'utf8').includes('Fresh bread'));
  });
  it('searches when there is no source tag, and reports where it found the text', async () => {
    const dir = tempDir(files);
    const { tools } = await run(dir);
    const grep = tools.find((t) => t.tool === 'Grep' && t.phase === 'end');
    assert.deepEqual(grep?.hits, [{ file: 'src/Hero.jsx', line: 3 }]);
    assert.ok(existsSync(path.join(dir, 'src/Hero.jsx')));
  });
  it('tells Claude the picked element\'s source location', () => {
    const p = buildPrompt('make this bigger', { tag: 'h1', selector: 'h1', text: 'Hi', html: '<h1>Hi</h1>', src: 'src/Hero.jsx:3:5' });
    assert.match(p, /source location: src\/Hero.jsx:3:5 \(file:line:column\)/);
  });
});
