import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ATTR, isHostTag, tagSource } from './transform.js';
import { projectPath, sourceTags } from './vite.js';

/** 1-based column of the first occurrence of `needle`. */
const col = (line: string, needle: string) => line.indexOf(needle) + 1;
const tags = (code: string) => [...code.matchAll(new RegExp(`${ATTR}=\\{"([^"]+)"\\}`, 'g'))].map((m) => m[1]);

describe('tagSource', () => {
  it('tags DOM elements with file:line:column and keeps every line in place', () => {
    const code = [
      'export default function Hero() {',
      '  return (',
      '    <header className="hero">',
      '      <h1>Welcome</h1>',
      '    </header>',
      '  );',
      '}',
    ].join('\n');
    const out = tagSource(code, 'src/Hero.jsx', { typescript: false });
    assert.ok(out);
    assert.equal(out.count, 2);
    assert.deepEqual(tags(out.code), ['src/Hero.jsx:3:5', 'src/Hero.jsx:4:7']);
    assert.equal(out.code.split('\n').length, code.split('\n').length);
    assert.match(out.code, /<header data-hivebubble-src=\{"src\/Hero.jsx:3:5"\} className="hero">/);
    assert.ok(out.map.mappings.length > 0);
  });

  it('leaves components, fragments and member expressions alone', () => {
    const code = 'const a = <><Card title="x" /><motion.div /><ui.Button /><p>hi</p></>;';
    const out = tagSource(code, 'a.jsx', { typescript: false });
    assert.deepEqual(tags(out!.code), [`a.jsx:1:${col(code, '<p>')}`]);
  });

  it('tags SVG shapes and custom elements but not invisible SVG parts or unknown lowercase names', () => {
    const out = tagSource('<svg><defs><linearGradient id="g"><stop /></linearGradient></defs><path d="M0" /><my-widget /><mesh /></svg>', 'i.jsx', { typescript: false });
    assert.equal(out!.count, 3); // svg, path, my-widget
    assert.ok(!out!.code.includes(`<mesh ${ATTR}`));
    assert.ok(!out!.code.includes(`<stop ${ATTR}`));
  });

  it('parses TypeScript with generics, casts, satisfies and decorators', () => {
    const code = [
      'type P<T> = { items: T[] };',
      'export const List = <T,>({ items }: P<T>) => <ul>{items.map((i) => <li key={String(i)}>{i as string}</li>)}</ul>;',
      'const cfg = { a: 1 } satisfies Record<string, number>;',
      'class Store { @observable value = 1; }',
    ].join('\n');
    const out = tagSource(code, 'src/List.tsx', { typescript: true });
    const line2 = code.split('\n')[1];
    assert.deepEqual(tags(out!.code), [`src/List.tsx:2:${col(line2, '<ul>')}`, `src/List.tsx:2:${col(line2, '<li ')}`]);
  });

  it('skips files it cannot parse, files without JSX and 3D scenes', () => {
    assert.equal(tagSource('const a = 1 < 2;', 'a.js', { typescript: false }), null);
    assert.equal(tagSource('<div', 'a.jsx', { typescript: false }), null);
    assert.equal(tagSource('import { Canvas } from "@react-three/fiber";\nexport const S = () => <Canvas><line /></Canvas>;', 's.jsx', { typescript: false }), null);
  });

  it('does not tag an element twice', () => {
    const once = tagSource('const a = <div>hi</div>;', 'a.jsx', { typescript: false })!;
    assert.equal(tagSource(once.code, 'a.jsx', { typescript: false }), null);
  });

  it('escapes unusual file names safely', () => {
    const out = tagSource('const a = <div />;', 'src/we"ird {x}.jsx', { typescript: false })!;
    assert.ok(out.code.includes(`${ATTR}={"src/we\\"ird {x}.jsx:1:11"}`));
  });

  it('knows which names are DOM elements', () => {
    assert.ok(isHostTag('div') && isHostTag('textPath') && isHostTag('x-card'));
    assert.ok(!isHostTag('mesh') && !isHostTag('group') && !isHostTag('Div'));
  });
});

describe('vite plugin', () => {
  const root = '/work/shop';

  it('only tags the project\'s own JSX modules', () => {
    assert.equal(projectPath([root], '/work/shop/src/App.jsx'), 'src/App.jsx');
    assert.equal(projectPath([root], '/work/shop/src/App.tsx?t=1700000000'), 'src/App.tsx');
    assert.equal(projectPath([root], '/work/shop/src/App.jsx?raw'), null);
    assert.equal(projectPath([root], '/work/shop/node_modules/lib/x.jsx'), null);
    assert.equal(projectPath([root], '/work/other/src/App.jsx'), null);
    assert.equal(projectPath([root], '/work/shop/src/util.ts'), null);
    assert.equal(projectPath([root], '\0virtual:thing.jsx'), null);
  });

  it('matches paths through a symlinked project folder', () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'hb-tags-'));
    mkdirSync(path.join(base, 'real'));
    symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
    const plugin = sourceTags({ projectDir: path.join(base, 'link') });
    const out = plugin.transform.handler('export const A = () => <p>hi</p>;', path.join(realpathSync(base), 'real', 'src', 'A.jsx'));
    assert.deepEqual(tags(out!.code), ['src/A.jsx:1:24']);
  });

  it('runs only in the dev server and before other plugins', () => {
    const plugin = sourceTags({ projectDir: root });
    assert.equal(plugin.apply, 'serve');
    assert.equal(plugin.enforce, 'pre');
    assert.ok(plugin.transform.filter.id.test('/work/shop/src/App.tsx'));
  });
});
