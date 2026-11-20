import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { routeTask, withoutQuotes } from './router.js';
import type { Effort, PickedElement, TaskKind } from './types.js';

interface Case {
  id: string;
  prompt: string;
  element?: PickedElement;
  expect: { kind: TaskKind; effort: Effort };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const set = JSON.parse(readFileSync(path.join(here, '../bench/prompts.json'), 'utf8')) as { prompts: Case[] };

describe('router test set (bench/prompts.json)', () => {
  it('has 30 prompts across every kind of task', () => {
    assert.equal(set.prompts.length, 30);
    const kinds = new Set(set.prompts.map((c) => c.expect.kind));
    for (const kind of ['copy', 'style', 'component', 'feature', 'bug', 'new-app', 'question', 'general']) assert.ok(kinds.has(kind as TaskKind), kind);
  });
  for (const c of set.prompts) {
    it(`${c.id}: ${c.expect.kind} at ${c.expect.effort}`, () => {
      const r = routeTask({ text: c.prompt, hasElement: Boolean(c.element), elementSrc: c.element?.src });
      assert.deepEqual([r.kind, r.effort], [c.expect.kind, c.expect.effort], `"${c.prompt}" → ${r.kind}/${r.effort} (${r.signals.join(', ')})`);
    });
  }
});

describe('router v1 signals', () => {
  const route = (text: string, extra: Partial<Parameters<typeof routeTask>[0]> = {}) => routeTask({ text, hasElement: false, ...extra });

  it('picks checks per kind of task', () => {
    assert.deepEqual(route('change the title to "Hi"').checks, ['page']);
    assert.deepEqual(route('add a testimonials section').checks, ['page', 'typecheck']);
    assert.deepEqual(route('let people log in').checks, ['page', 'typecheck', 'build']);
    assert.deepEqual(route('what does this page do?').checks, []);
  });
  it('treats quoted new text as text, not as a risky request', () => {
    const r = route('change the button text to "Pay now with Stripe"');
    assert.equal(r.kind, 'copy');
    assert.equal(r.effort, 'low');
    assert.ok(!r.signals.some((s) => s.startsWith('risk:')));
    assert.equal(withoutQuotes(`say "hi" and 'bye' but don't`).includes('hi'), false);
  });
  it('gives risky areas careful effort and a build check', () => {
    const r = route('move the api key into the .env file');
    assert.equal(r.effort, 'high');
    assert.ok(r.checks.includes('build'));
    assert.ok(r.signals.includes('risk:secrets'));
  });
  it('goes one level deeper after an undo, and for several asks at once', () => {
    assert.equal(route('make it bigger', { hasElement: true, previousUndone: true }).effort, 'medium');
    assert.ok(route('make it bigger', { previousUndone: true }).signals.includes('after-undo'));
    assert.equal(route('change the title colour; also make the footer bold; and then center the logo').effort, 'medium');
  });
  it('builds from the start in an empty project', () => {
    const r = route('a page for my dog walking business', { emptyProject: true });
    assert.deepEqual([r.kind, r.effort], ['new-app', 'xhigh']);
  });
  it('only reaches max effort through Think harder', () => {
    assert.equal(route('make me a booking app', { mode: 'thorough', previousFailed: true }).effort, 'xhigh');
    const r = route('change the title to "Hi"', { thinkHarder: true });
    assert.deepEqual([r.effort, r.label], ['max', 'Deepest']);
  });
  it('records what it saw', () => {
    const r = route('make this rounder', { hasElement: true, elementSrc: 'src/A.jsx:3:5', mode: 'quick' });
    assert.deepEqual(r.signals, ['rule:style', 'element:source', 'mode:quick']);
  });
});
