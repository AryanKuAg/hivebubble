import type { Effort, ToolAction, ToolEvent } from '../../core/src/types';
import { Effects, type Fx } from './effects';
import { Flyer, castOf, type Personality } from './flight';
import { BEE } from './icons';
import { isVisible, outermost, pageHasTags, resolveTargets, spread } from './targets';
import type { PageWatcher } from './watch';

type Point = { x: number; y: number };

const VERB: Record<ToolAction, string> = {
  read: 'Reading',
  search: 'Searching',
  edit: 'Editing',
  write: 'Writing',
  other: 'Working',
};

/** Bigger jobs get a bigger swarm, so the router's choice is visible. */
export const SWARM_SIZE: Record<Effort, number> = { low: 3, medium: 4, high: 5, xhigh: 6, max: 7 };

const CANDIDATES = 'h1,h2,h3,h4,p,img,button,a,li,section,header,footer,nav,form,input,label,figure,blockquote';
const STAGGER_MS = 170;
const HALF = 17; // half the bee's drawn size
/** How long a bee stays on each element while it reads its way through a file. */
const HOP_MS = 420;
/** Nothing running for this long while a task is on means Claude is thinking. */
const THINK_AFTER_MS = 350;
const STYLE_FILE = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/i;

interface Bee {
  el: HTMLElement;
  svg: SVGElement | null;
  label: HTMLElement;
  flyer: Flyer | null;
  personality: Personality;
  /** Its place in the ring around the element being worked on, so bees and labels don't pile up. */
  slot: number;
  step: Step | null;
  /** An edit: "click" into the element once the bee gets there. */
  clickArmed: boolean;
  returning: boolean;
  leftAt: number;
}

/** One real agent step (a tool call), carried by one bee. */
interface Step {
  id: string;
  event: ToolEvent;
  bee: Bee;
  /** The elements the step is about. Empty: unknown (no source tags) or, with `bench`, nothing on this page. */
  targets: Element[];
  /** The code draws nothing on this page (config, data, API code): the work shows at the workbench. */
  bench: boolean;
  /** For reads: which target the bee is on in its tour of the file. */
  hop: number;
  hopAt: number;
  fx: Fx[];
  startedAt: number;
  ended: boolean;
  /** Keep the step on screen until this time once it has ended (a read's tour, a ✓). */
  holdUntil: number;
  /** The step failed: its bee perches by the "!" it raised. */
  failed?: boolean;
  /** The page-error bee: not an agent step. */
  pinned?: boolean;
}

export interface SwarmOptions {
  layer: HTMLElement;
  tray: HTMLElement;
  /** The bubble's own element, never a target. */
  host: Element;
  /** The hive's entrance hole, where bees leave and come back. */
  entrance: () => Point;
  /** The workbench next to the hive, for work on code that draws nothing on the page. */
  bench: () => Point;
  /** The element the person picked, if any. */
  focus: () => Element | null;
  /** A box bees should keep out of (the open chat panel), so they stay in view. */
  avoid: () => DOMRect | null;
  watcher: PageWatcher;
  /** What the hive is doing now, in a few words ("Reading Hero.jsx", "Thinking"). */
  onActivity: (text: string) => void;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const fileName = (file?: string) => file?.split('/').pop();

export function describeTool(e: Pick<ToolEvent, 'action' | 'file' | 'tool'>): string {
  const name = fileName(e.file) ?? (e.action === 'search' ? 'the project' : e.tool);
  return `${VERB[e.action]} ${name}`;
}

/**
 * The swarm. When a task starts, a stream of bees flies out of the hive (more
 * for bigger tasks), each with its own way of flying. Every real step the
 * agent takes is handed to the next bee in turn, which flies to the elements
 * that step's code draws and carries its label:
 * - reading: the bee tours the file's elements under a reading ripple;
 * - searching: the bee hops to where the search found its matches;
 * - editing: it clicks in, a caret blinks in its label and the element
 *   shimmers; a ✓ appears once hot reload puts the change on the page;
 * - code that draws nothing on this page: the bee works at the workbench;
 * - a failed step turns the bee amber at the problem;
 * - nothing running: Claude is thinking, and the bees bob in place.
 * With source tags the elements are exact. Without them, bees fly to the
 * picked element or a stand-in element, and no element gets highlighted.
 */
export class Swarm {
  /** The dev server stamps data-hivebubble-src on elements (from the engine's hello). */
  sourceTags = false;
  private bees: Bee[] = [];
  private homebound: Bee[] = [];
  private readonly steps = new Map<string, Step>();
  private area: Element[] = [];
  private turn = 0;
  private timers: number[] = [];
  private trayTimer = 0;
  private raf = 0;
  private last = 0;
  private working = false;
  private thinking = false;
  private quietSince = 0;
  private readonly fx: Effects;

  constructor(private readonly o: SwarmOptions) {
    this.fx = new Effects(o.layer);
  }

  /** Send bees out of the hive until there are `size` of them. */
  launch(size: number): void {
    const starting = !this.working;
    this.working = true;
    if (starting) this.quietSince = performance.now();
    const wanted = reduced() ? 1 : size;
    const focused = this.o.focus();
    if (this.area.length === 0 && focused?.isConnected) this.area = [focused];
    const missing = wanted - this.bees.length;
    if (missing > 0) {
      const taken = new Set(this.bees.map((b) => b.personality.name));
      const cast = castOf(missing + taken.size).filter((p) => !taken.has(p.name)).slice(0, missing);
      cast.forEach((personality, n) => {
        const bee = this.spawn(personality);
        this.timers.push(window.setTimeout(() => this.takeOff(bee), n * STAGGER_MS));
      });
    }
    this.ensureLoop();
  }

  tool(e: ToolEvent): void {
    if (this.bees.length === 0) this.launch(SWARM_SIZE.medium);
    if (e.phase === 'start') this.start(e);
    else this.end(e);
  }

  /** The dev server's error overlay appeared (or went away): a bee turns amber and points at it. */
  pageError(overlay: Element | null): void {
    for (const step of [...this.steps.values()]) if (step.pinned) this.retire(step);
    if (!overlay || !this.working || this.bees.length === 0) return;
    const box = overlay.shadowRoot?.querySelector('.window') ?? overlay;
    const bee = this.bees.find((b) => !b.step) ?? this.bees[this.bees.length - 1];
    if (bee.step) this.retire(bee.step);
    const now = performance.now();
    const step: Step = {
      id: 'page-error',
      event: { type: 'tool', id: 'page-error', phase: 'start', action: 'other', tool: 'page' },
      bee,
      targets: [box],
      bench: false,
      hop: 0,
      hopAt: now,
      fx: [this.fx.add('alert', box)],
      startedAt: now,
      ended: false,
      holdUntil: 0,
      failed: true,
      pinned: true,
    };
    this.steps.set(step.id, step);
    bee.step = step;
    bee.el.classList.remove('thinking', 'building', 'done');
    bee.el.classList.add('error');
    this.setLabel(bee, 'Error on the page');
    if (!bee.flyer) this.takeOff(bee);
    this.sendTo(bee, this.spotFor(bee));
    this.ensureLoop();
  }

  /**
   * The task finished: the bees fly back into the hive, each in its own time.
   * Steps that already ended get to finish showing what they did (a ✓ still
   * landing, a read's tour) before their bee leaves; steps cut short by Stop
   * end now.
   */
  finish(): void {
    this.working = false;
    this.thinking = false;
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    for (const step of [...this.steps.values()]) {
      if (!step.ended || step.pinned) this.retire(step);
    }
    this.fx.clear([...this.steps.values()].flatMap((s) => s.fx));
    let order = 0;
    for (const bee of [...this.bees]) {
      bee.el.classList.remove('thinking');
      if (!bee.step) this.goHome(bee, order++ * 120);
    }
    this.area = [];
    window.clearTimeout(this.trayTimer);
    this.trayTimer = window.setTimeout(() => {
      this.o.tray.replaceChildren();
      this.o.tray.hidden = true;
    }, 2500);
    this.ensureLoop();
  }

  private goHome(bee: Bee, delay = 0): void {
    this.bees = this.bees.filter((b) => b !== bee);
    bee.step = null;
    bee.clickArmed = false;
    this.setLabel(bee, '');
    bee.el.classList.remove('building', 'error', 'done', 'thinking', 'clicking');
    if (!bee.flyer || reduced()) {
      bee.el.remove();
      return;
    }
    const fly = () => {
      const home = this.o.entrance();
      bee.returning = true;
      bee.leftAt = performance.now();
      bee.flyer!.homing = true;
      bee.flyer!.setAnchor(home.x, home.y);
      this.homebound.push(bee);
      this.ensureLoop();
    };
    if (delay > 0) window.setTimeout(fly, delay);
    else fly();
  }

  // ---- steps -----------------------------------------------------------------

  private exact(): boolean {
    return this.sourceTags && pageHasTags();
  }

  private start(e: ToolEvent): void {
    this.setThinking(false);
    const bee = this.nextBee();
    if (bee.step) this.retire(bee.step);
    const exact = this.exact();
    // A search with no file or folder looks through the whole project: the bee scans the page.
    const where = e.action === 'search' && !e.file ? { ...e, file: '.' } : e;
    const targets = exact ? resolveTargets(where, this.o.host) : this.approximate(e);
    const now = performance.now();
    const step: Step = {
      id: e.id,
      event: e,
      bee,
      targets,
      bench: exact && targets.length === 0,
      hop: 0,
      hopAt: now,
      fx: [],
      startedAt: now,
      ended: false,
      holdUntil: 0,
    };
    this.steps.set(e.id, step);
    bee.step = step;

    const building = e.action === 'edit' || e.action === 'write';
    bee.el.classList.remove('error', 'done', 'thinking');
    bee.el.classList.toggle('building', building);
    this.setLabel(bee, describeTool(e), building);
    bee.clickArmed = building && targets.length > 0;
    // Only highlight elements known to be the real ones.
    if (exact || this.isFocus(targets[0])) {
      if (building) step.fx = outermost(targets).slice(0, 4).map((el) => this.fx.add('shimmer', el));
      else if (targets[0]) step.fx = [this.fx.add('ripple', targets[0])];
    }
    if (targets.length > 0) this.area = targets;

    if (!bee.flyer) this.takeOff(bee);
    this.sendTo(bee, this.spotFor(bee));
    // Idle bees regroup around whatever is being worked on now, like a team converging on a task.
    for (const helper of this.bees) {
      if (helper !== bee && !helper.step && helper.flyer) this.sendTo(helper, this.spotFor(helper));
    }
    this.trayAdd(describeTool(e), e.action, step.bench);
    this.o.onActivity(describeTool(e));
    this.ensureLoop();
  }

  private end(e: ToolEvent): void {
    const step = this.steps.get(e.id);
    if (!step) return;
    step.ended = true;
    const now = performance.now();
    const bee = step.bee;
    const name = fileName(e.file);

    if (e.ok === false) {
      step.failed = true;
      for (const f of step.fx) this.fx.remove(f);
      step.fx = step.targets[0] && (this.exact() || this.isFocus(step.targets[0])) ? [this.fx.add('alert', step.targets[0])] : [];
      bee.el.classList.remove('building');
      bee.el.classList.add('error');
      this.setLabel(bee, name ? `Hit a snag in ${name}` : 'Hit a snag');
      step.holdUntil = now + 1800;
    } else if (e.action === 'edit' || e.action === 'write') {
      this.setLabel(bee, describeTool(step.event));
      step.holdUntil = Infinity; // until the change shows up on the page
      const style = Boolean(e.selectors?.length) || STYLE_FILE.test(e.file ?? '');
      const reached = e.file ? this.o.watcher.afterUpdate(e.file, style) : Promise.resolve(false);
      void reached.then((updated) => this.landed(step, e, updated));
    } else if (e.hits && e.hits.length > 0 && this.exact()) {
      const found = spread(
        e.hits.flatMap((h) => resolveTargets({ file: h.file, lines: h.line ? [h.line, h.line] : undefined }, this.o.host, 2)),
        4,
      );
      if (found.length > 0) {
        step.targets = found;
        step.bench = false;
        step.hop = 0;
        step.hopAt = now;
        const ripple = step.fx.find((f) => f.kind === 'ripple');
        if (ripple) this.fx.move(ripple, found[0]);
        else step.fx.push(this.fx.add('ripple', found[0]));
        this.area = found;
        this.setLabel(bee, `Found it in ${fileName(e.hits[0].file)}`);
        this.sendTo(bee, this.spotFor(bee));
        step.holdUntil = now + found.length * HOP_MS + 400;
      } else {
        step.holdUntil = now + 500;
      }
    } else {
      // A read: let the bee finish its quick tour of what the file draws.
      const tour = step.targets.length > 1 ? Math.min(step.targets.length, 6) * HOP_MS : 900;
      step.holdUntil = Math.max(now + 300, step.startedAt + tour);
    }
    if (this.inFlight() === 0) this.quietSince = now;
  }

  /** An edit reached the page (or at least the file was saved): ✓ on the elements it changed. */
  private landed(step: Step, e: ToolEvent, updated: boolean): void {
    for (const f of step.fx) this.fx.remove(f);
    step.fx = [];
    // A page showing the dev server's error overlay did not take the change: that earns no ✓.
    const broken = document.querySelector('vite-error-overlay') !== null;
    const exact = this.exact();
    if (!broken && (exact || this.isFocus(step.targets[0]))) {
      // After hot reload the tags carry the new line numbers, which the end event already has.
      const now = exact ? resolveTargets(e, this.o.host, 4) : [];
      const marks = now.length > 0 ? now : step.targets.filter((el) => el.isConnected);
      for (const el of outermost(marks).slice(0, 4)) this.fx.add('check', el, 1500);
      this.ensureLoop();
    }
    const name = fileName(e.file) ?? 'the file';
    if (step.bee.step === step) {
      step.bee.el.classList.remove('building');
      step.bee.el.classList.toggle('done', !broken);
      this.setLabel(step.bee, updated && !broken ? `Updated ${name}` : `Saved ${name}`);
    }
    step.holdUntil = performance.now() + 900;
  }

  /** The step is over: clear its highlights and free its bee. */
  private retire(step: Step): void {
    this.steps.delete(step.id);
    for (const f of step.fx) this.fx.remove(f);
    const bee = step.bee;
    if (bee.step !== step) return;
    if (!this.working) return this.goHome(bee);
    bee.step = null;
    bee.clickArmed = false;
    bee.el.classList.remove('building', 'error', 'done', 'clicking');
    bee.el.classList.toggle('thinking', this.thinking);
    this.setLabel(bee, '');
    this.sendTo(bee, this.spotFor(bee));
  }

  private inFlight(): number {
    let n = 0;
    for (const step of this.steps.values()) if (!step.ended && !step.pinned) n++;
    return n;
  }

  private setThinking(on: boolean): void {
    if (this.thinking === on) return;
    this.thinking = on;
    for (const bee of this.bees) bee.el.classList.toggle('thinking', on && !bee.step);
    if (on) {
      this.o.onActivity('Thinking');
      for (const bee of this.bees) if (!bee.step && bee.flyer) this.sendTo(bee, this.spotFor(bee));
    }
  }

  /** Without source tags: the picked element, or a visible element chosen consistently per file. */
  private approximate(e: ToolEvent): Element[] {
    const focused = this.o.focus();
    if (focused?.isConnected) return [focused];
    const visible = Array.from(document.querySelectorAll(CANDIDATES)).filter((el) => {
      if (el === this.o.host || this.o.host.contains(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 24 && r.height > 12 && isVisible(el);
    });
    return visible.length > 0 ? [visible[hash(e.file ?? e.id) % visible.length]] : [];
  }

  private isFocus(el: Element | undefined): boolean {
    return Boolean(el) && el === this.o.focus();
  }

  // ---- bees ---------------------------------------------------------------

  private spawn(personality: Personality): Bee {
    const el = document.createElement('div');
    el.className = 'bee';
    el.dataset.personality = personality.name;
    el.style.setProperty('--flap', `${personality.flap}s`);
    el.style.setProperty('--size', String(personality.size));
    const body = document.createElement('div');
    body.className = 'body';
    const sprite = document.createElement('div');
    sprite.className = 'sprite';
    sprite.innerHTML = BEE;
    body.append(sprite);
    const label = document.createElement('span');
    label.className = 'label';
    el.append(body, label);
    const { x, y } = this.o.entrance();
    el.style.transform = `translate(${Math.round(x - HALF)}px, ${Math.round(y - HALF)}px)`;
    this.o.layer.append(el);
    // The lowest free place on the ring (bees still finishing an earlier task keep theirs).
    const used = new Set(this.bees.map((b) => b.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const bee: Bee = {
      el,
      svg: sprite.querySelector('svg'),
      label,
      flyer: null,
      personality,
      slot,
      step: null,
      clickArmed: false,
      returning: false,
      leftAt: 0,
    };
    this.bees.push(bee);
    return bee;
  }

  /** The bee leaves the hive and starts flying. */
  private takeOff(bee: Bee): void {
    if (bee.flyer) return;
    const { x, y } = this.o.entrance();
    bee.flyer = new Flyer(bee.personality, x, y);
    bee.el.classList.add('out');
    bee.el.classList.toggle('thinking', this.thinking && !bee.step);
    this.sendTo(bee, this.spotFor(bee));
    this.ensureLoop();
  }

  private sendTo(bee: Bee, p: Point): void {
    if (!bee.flyer) return;
    bee.flyer.setAnchor(p.x, p.y);
    if (reduced()) {
      bee.flyer.x = p.x;
      bee.flyer.y = p.y;
      this.draw(bee);
    }
  }

  /**
   * The next bee to carry a step: an idle one first (taking turns, so
   * different bees carry different steps), then one that is only lingering
   * on a finished step.
   */
  private nextBee(): Bee {
    const n = this.bees.length;
    const pick = (ok: (b: Bee) => boolean) => {
      for (let i = 0; i < n; i++) {
        const bee = this.bees[(this.turn + i) % n];
        if (ok(bee)) {
          this.turn = (this.turn + i + 1) % n;
          return bee;
        }
      }
      return null;
    };
    return (
      pick((b) => !b.step) ??
      pick((b) => Boolean(b.step?.ended && !b.step.pinned)) ??
      pick((b) => !b.step?.pinned) ??
      this.bees[this.turn++ % n]
    );
  }

  private setLabel(bee: Bee, text: string, typing = false): void {
    bee.label.textContent = text;
    if (typing && text) {
      const caret = document.createElement('i');
      caret.className = 'caret';
      bee.label.append(caret);
    }
  }

  // ---- where to fly -----------------------------------------------------------

  private spotFor(bee: Bee): Point {
    const step = bee.step;
    if (step) {
      if (step.bench) return this.benchPoint(bee.slot);
      const problem = step.failed ? step.targets[0] : null;
      if (problem?.isConnected) {
        // Perch just right of the "!" badge on the problem's top-left corner.
        const r = problem.getBoundingClientRect();
        return { x: Math.min(innerWidth - 160, Math.max(24, r.left + 30)), y: Math.min(innerHeight - 24, Math.max(24, r.top - 4)) };
      }
      return this.ringPoint(step.targets[step.hop % Math.max(1, step.targets.length)] ?? null, bee.slot);
    }
    const around = this.area.length > 0 ? this.area[bee.slot % this.area.length] : null;
    return this.ringPoint(around, bee.slot, this.thinking ? 0.7 : 1);
  }

  /**
   * A spot on a loose ring around the element: each bee keeps its own slot on
   * the ring, with some jitter so the swarm still looks alive.
   */
  private ringPoint(el: Element | null, slot: number, tight = 1): Point {
    let cx = innerWidth * 0.45;
    let cy = innerHeight * 0.45;
    let rx = innerWidth * 0.22;
    let ry = innerHeight * 0.2;
    if (el && el.isConnected) {
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      rx = Math.min(r.width / 2 + 30, innerWidth * 0.4);
      ry = Math.min(r.height / 2 + 28, innerHeight * 0.35);
    }
    const n = Math.max(this.bees.length, 3);
    const angle = -Math.PI / 2 + (slot / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const k = (0.8 + Math.random() * 0.3) * tight;
    const pad = 24;
    // Keep room on the right for the label.
    let x = Math.min(innerWidth - pad - 130, Math.max(pad, cx + Math.cos(angle) * rx * k));
    const y = Math.min(innerHeight - pad, Math.max(pad, cy + Math.sin(angle) * ry * k));
    // A spot under the open chat panel would hide the bee: move it to the panel's left.
    const panel = this.o.avoid();
    if (panel && x + 150 > panel.left && x - 20 < panel.right && y + 40 > panel.top && y - 20 < panel.bottom) {
      x = Math.max(pad, panel.left - 160 - Math.random() * 30);
    }
    return { x, y };
  }

  private benchPoint(slot: number): Point {
    const p = this.o.bench();
    return { x: p.x - (slot % 2) * 26 + (Math.random() - 0.5) * 10, y: p.y - (slot % 3) * 16 + (Math.random() - 0.5) * 8 };
  }

  // ---- animation loop -------------------------------------------------------

  private ensureLoop(): void {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const still = reduced();

    for (const step of [...this.steps.values()]) {
      if (step.ended && now >= step.holdUntil) {
        this.retire(step);
        continue;
      }
      // Reads and search results: hop from element to element.
      const touring = step.event.action === 'read' || step.event.action === 'search';
      if (touring && !still && step.targets.length > 1 && now - step.hopAt >= HOP_MS) {
        step.hop = (step.hop + 1) % step.targets.length;
        step.hopAt = now;
        const ripple = step.fx.find((f) => f.kind === 'ripple');
        if (ripple) this.fx.move(ripple, step.targets[step.hop]);
        this.sendTo(step.bee, this.spotFor(step.bee));
      }
    }
    if (this.working && !this.thinking && this.inFlight() === 0 && now - this.quietSince > THINK_AFTER_MS) this.setThinking(true);

    if (!still) {
      for (const bee of this.bees) {
        const f = bee.flyer;
        if (!f) continue;
        if (f.wantsRetarget(now)) {
          const spot = this.spotFor(bee);
          if (bee.personality.hover === 'dart' && !bee.step?.bench) {
            // Darting bees hop between nearby spots instead of drifting.
            spot.x += (Math.random() - 0.5) * 70;
            spot.y += (Math.random() - 0.5) * 50;
          }
          f.setAnchor(spot.x, spot.y);
        }
        f.step(dt);
        if (bee.clickArmed && f.distanceTo(f.ax, f.ay) < 28) {
          bee.clickArmed = false;
          bee.el.classList.add('clicking');
          window.setTimeout(() => bee.el.classList.remove('clicking'), 340);
        }
        this.draw(bee);
      }

      const home = this.o.entrance();
      this.homebound = this.homebound.filter((bee) => {
        const f = bee.flyer!;
        f.setAnchor(home.x, home.y);
        f.step(dt);
        this.draw(bee);
        const d = f.distanceTo(home.x, home.y);
        if (d < 70) bee.el.classList.add('home');
        if (d < 16 || now - bee.leftAt > 3500) {
          bee.el.remove();
          return false;
        }
        return true;
      });
    }

    this.fx.update();

    const flying = !still && (this.bees.some((b) => b.flyer) || this.homebound.length > 0);
    if (flying || this.fx.active || this.steps.size > 0 || this.working) {
      this.raf = requestAnimationFrame(this.frame);
    } else {
      this.raf = 0;
    }
  };

  private draw(bee: Bee): void {
    const f = bee.flyer;
    if (!f) return;
    const { x, y } = f.render();
    bee.el.style.transform = `translate(${(x - HALF).toFixed(1)}px, ${(y - HALF).toFixed(1)}px)`;
    if (bee.svg) bee.svg.style.transform = `scaleX(${f.dir}) rotate(${f.tilt.toFixed(1)}deg)`;
  }

  // ---- workbench tray -----------------------------------------------------------

  private trayAdd(text: string, action: ToolAction, bench: boolean): void {
    window.clearTimeout(this.trayTimer);
    const item = document.createElement('li');
    item.classList.toggle('bench', bench);
    const dot = document.createElement('span');
    dot.className = `dot ${action}`;
    item.append(dot, document.createTextNode(text));
    this.o.tray.append(item);
    while (this.o.tray.children.length > 3) this.o.tray.firstElementChild?.remove();
    this.o.tray.hidden = false;
  }
}
