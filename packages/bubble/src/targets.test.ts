import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isFolder, outermost, parseSrc, pickByLines, shortSrc, spread, type SrcTag } from './targets';

const entry = (line: number, col = 1, file = 'src/Menu.jsx') => ({ tag: { file, line, col } as SrcTag, id: `${line}:${col}` });

describe('source tags in the bubble', () => {
  it('parses tags and shortens them for people', () => {
    assert.deepEqual(parseSrc('src/components/Hero.jsx:12:7'), { file: 'src/components/Hero.jsx', line: 12, col: 7 });
    assert.deepEqual(parseSrc('src/Hero.jsx:3'), { file: 'src/Hero.jsx', line: 3, col: 1 });
    assert.equal(parseSrc('Hero.jsx'), null);
    assert.equal(parseSrc(null), null);
    assert.equal(shortSrc('src/components/Hero.jsx:12:7'), 'Hero.jsx:12');
    assert.equal(shortSrc(undefined), undefined);
  });
});

describe('picking elements by lines', () => {
  // A menu: <section> on 18, <h2> on 19, <ul> on 20, and one <li> on 22 drawn three times.
  const entries = [entry(18), entry(19), entry(20), entry(22, 9), entry(22, 9), entry(22, 9), entry(23, 11)];

  it('takes the elements written on the lines', () => {
    assert.deepEqual(pickByLines(entries, [22, 23]).map((e) => e.id), ['22:9', '22:9', '22:9', '23:11']);
  });
  it('falls back to the nearest element written above the lines', () => {
    assert.deepEqual(pickByLines(entries, [21, 21]).map((e) => e.id), ['20:1']);
    assert.deepEqual(pickByLines(entries, [30, 31]).map((e) => e.id), ['23:11']);
  });
  it('uses the whole file when the lines are above every element, or not given', () => {
    assert.equal(pickByLines(entries, [1, 4]).length, entries.length);
    assert.equal(pickByLines(entries).length, entries.length);
    assert.deepEqual(pickByLines([], [1, 2]), []);
  });
});

describe('helpers', () => {
  it('tells folders (searched by Grep and Glob) from files', () => {
    for (const folder of ['.', '', 'src', 'src/', 'src/components']) assert.equal(isFolder(folder), true, folder);
    for (const file of ['src/App.jsx', 'vite.config.js', 'src/styles/app.module.css']) assert.equal(isFolder(file), false, file);
  });
  it('spreads a tour evenly and keeps the order', () => {
    assert.deepEqual(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), [1, 4, 7, 10]);
    assert.deepEqual(spread([1, 2], 4), [1, 2]);
  });
  it('drops elements inside other picked elements', () => {
    const fake = (name: string, kids: string[] = []) => ({ name, contains: (o: { name: string }) => kids.includes(o.name) });
    const header = fake('header', ['h1', 'p']);
    const h1 = fake('h1');
    const footer = fake('footer');
    const out = outermost([header, h1, footer] as unknown as Element[]) as unknown as Array<{ name: string }>;
    assert.deepEqual(out.map((e) => e.name), ['header', 'footer']);
  });
});
