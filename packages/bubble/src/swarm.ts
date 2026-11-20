import type { Effort, ServerEvent, ToolAction } from '../../core/src/types';
import { Flyer, castOf, type Personality } from './flight';
import { BEE } from './icons';

type ToolEvent = Extract<ServerEvent, { type: 'tool' }>;
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

interface Bee {
  el: HTMLElement;
  sprite: HTMLElement;
  svg: SVGElement | null;
  label: HTMLElement;
  flyer: Flyer | null;
  personality: Personality;
  /** Its place in the ring around the element being worked on, so bees and labels don't pile up. */
  slot: number;
  tool: string | null;
  target: Element | null;
  glow: HTMLElement | null;
  returning: boolean;
  leftAt: number;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function describeTool(e: ToolEvent): string {
  const name = e.file ? e.file.split('/').pop() : e.action === 'search' ? 'the project' : e.tool;
  return `${VERB[e.action]} ${name}`;
}

/**
 * The swarm. When a task starts, a stream of bees flies out of the hive (more
 * for bigger tasks), each with its own way of flying, and works around the
 * part of the page being changed. Every real step the agent takes (each file
 * it reads, searches or edits) is handed to the next bee in turn, which flies
 * to it and carries its label, so the labels always show real work. When the
 * task ends the bees fly home.
 *
 * Until projects have source tags (data-hivebubble-src, milestone M2), bees fly
 * to the picked element, or to a visible element chosen consistently per file,
 * so positions on the page are approximate.
 */
export class Swarm {
  private bees: Bee[] = [];
  private homebound: Bee[] = [];
  private area: Element | null = null;
  private turn = 0;
  private timers: number[] = [];
  private trayTimer = 0;
  private raf = 0;
  private last = 0;

  constructor(
    private readonly layer: HTMLElement,
    private readonly tray: HTMLElement,
    private readonly entrance: () => Point,
    private readonly focus: () => Element | null,
  ) {}

  /** Send bees out of the hive until there are `size` of them. */
  launch(size: number): void {
    const wanted = reduced() ? 1 : size;
    const focused = this.focus();
    if (!this.area && focused?.isConnected) this.area = focused;
    const missing = wanted - this.bees.length;
    if (missing <= 0) return;
    const taken = new Set(this.bees.map((b) => b.personality.name));
    const cast = castOf(missing + taken.size).filter((p) => !taken.has(p.name)).slice(0, missing);
    cast.forEach((personality, n) => {
      const bee = this.spawn(personality);
      this.timers.push(window.setTimeout(() => this.release(bee), n * STAGGER_MS));
    });
  }

  tool(e: ToolEvent): void {
    if (this.bees.length === 0) this.launch(SWARM_SIZE.medium);
    if (e.phase === 'start') this.start(e);
    else this.end(e);
  }

  private start(e: ToolEvent): void {
    const bee = this.nextBee();
    bee.tool = e.id;
    bee.label.textContent = describeTool(e);
    const building = e.action === 'edit' || e.action === 'write';
    bee.el.classList.toggle('building', building);
    bee.target = this.target(e.file ?? e.id);
    this.area = bee.target ?? this.area;
    bee.glow?.remove();
    bee.glow = building && bee.target ? this.glowAround(bee.target) : null;
    if (!bee.flyer) this.release(bee);
    this.sendTo(bee, this.ringPoint(bee.target, bee.slot));
    // Idle bees regroup around whatever is being worked on now, like a team converging on a task.
    for (const helper of this.bees) {
      if (helper !== bee && helper.tool === null && helper.flyer) this.sendTo(helper, this.ringPoint(bee.target, helper.slot));
    }
    this.trayAdd(describeTool(e), e.action);
  }

  private end(e: ToolEvent): void {
    const bee = this.bees.find((b) => b.tool === e.id);
    if (!bee) return;
    bee.tool = null;
    const glow = bee.glow;
    bee.glow = null;
    window.setTimeout(() => {
      if (glow) {
        glow.classList.add('fade');
        window.setTimeout(() => glow.remove(), 500);
      }
      if (bee.tool === null) {
        bee.el.classList.remove('building');
        bee.label.textContent = '';
      }
    }, 500);
  }

  /** The task finished: the bees fly back into the hive, each in its own time. */
  finish(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    const home = this.entrance();
    this.bees.forEach((bee, i) => {
      bee.glow?.remove();
      bee.glow = null;
      bee.label.textContent = '';
      bee.el.classList.remove('building');
      if (!bee.flyer || reduced()) {
        bee.el.remove();
        return;
      }
      window.setTimeout(() => {
        bee.returning = true;
        bee.leftAt = performance.now();
        if (bee.flyer) bee.flyer.homing = true;
        bee.flyer?.setAnchor(home.x, home.y);
        this.homebound.push(bee);
        this.ensureLoop();
      }, i * 120);
    });
    this.bees = [];
    this.area = null;
    window.clearTimeout(this.trayTimer);
    this.trayTimer = window.setTimeout(() => {
      this.tray.replaceChildren();
      this.tray.hidden = true;
    }, 2500);
  }

  // ---- bees ---------------------------------------------------------------

  private spawn(personality: Personality): Bee {
    const el = document.createElement('div');
    el.className = 'bee';
    el.dataset.personality = personality.name;
    el.style.setProperty('--flap', `${personality.flap}s`);
    el.style.setProperty('--size', String(personality.size));
    const sprite = document.createElement('div');
    sprite.className = 'sprite';
    sprite.innerHTML = BEE;
    const label = document.createElement('span');
    label.className = 'label';
    el.append(sprite, label);
    const { x, y } = this.entrance();
    el.style.transform = `translate(${Math.round(x - HALF)}px, ${Math.round(y - HALF)}px)`;
    this.layer.append(el);
    const bee: Bee = {
      el,
      sprite,
      svg: sprite.querySelector('svg'),
      label,
      flyer: null,
      personality,
      slot: this.bees.length,
      tool: null,
      target: null,
      glow: null,
      returning: false,
      leftAt: 0,
    };
    this.bees.push(bee);
    return bee;
  }

  /** The bee leaves the hive and starts flying. */
  private release(bee: Bee): void {
    if (bee.flyer) return;
    const { x, y } = this.entrance();
    bee.flyer = new Flyer(bee.personality, x, y);
    bee.el.classList.add('out');
    this.sendTo(bee, this.ringPoint(bee.target ?? this.area, bee.slot));
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

  /** The next idle bee, taking turns so different bees carry different steps. */
  private nextBee(): Bee {
    for (let i = 0; i < this.bees.length; i++) {
      const bee = this.bees[(this.turn + i) % this.bees.length];
      if (bee.tool === null) {
        this.turn = (this.turn + i + 1) % this.bees.length;
        return bee;
      }
    }
    const bee = this.bees[this.turn % this.bees.length];
    this.turn = (this.turn + 1) % this.bees.length;
    return bee;
  }

  // ---- animation loop -------------------------------------------------------

  private ensureLoop(): void {
    if (this.raf || reduced()) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    for (const bee of this.bees) {
      const f = bee.flyer;
      if (!f) continue;
      if (f.wantsRetarget(now)) {
        const around = bee.tool ? bee.target : this.area;
        const spot = this.ringPoint(around, bee.slot);
        if (bee.personality.hover === 'dart') {
          // Darting bees hop between nearby spots instead of drifting.
          spot.x += (Math.random() - 0.5) * 70;
          spot.y += (Math.random() - 0.5) * 50;
        }
        f.setAnchor(spot.x, spot.y);
      }
      f.step(dt);
      this.draw(bee);
    }

    const home = this.entrance();
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

    if (this.bees.some((b) => b.flyer) || this.homebound.length > 0) {
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

  // ---- where to fly -----------------------------------------------------------

  private target(key: string): Element | null {
    for (const el of Array.from(document.querySelectorAll('[data-hivebubble-src]'))) {
      const src = el.getAttribute('data-hivebubble-src') ?? '';
      if (src && key.endsWith(src.split(':')[0])) return el;
    }
    const focused = this.focus();
    if (focused && focused.isConnected) return focused;
    const visible = Array.from(document.querySelectorAll(CANDIDATES)).filter((el) => {
      if (el.closest('hivebubble-root')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 24 && r.height > 12 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    });
    if (visible.length === 0) return null;
    return visible[hash(key) % visible.length];
  }

  /**
   * A spot on a loose ring around the element: each bee keeps its own slot on
   * the ring, with some jitter so the swarm still looks alive.
   */
  private ringPoint(el: Element | null, slot: number): Point {
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
    const k = 0.8 + Math.random() * 0.3;
    const pad = 24;
    // Keep room on the right for the label.
    const x = Math.min(innerWidth - pad - 130, Math.max(pad, cx + Math.cos(angle) * rx * k));
    const y = Math.min(innerHeight - pad, Math.max(pad, cy + Math.sin(angle) * ry * k));
    return { x, y };
  }

  private glowAround(el: Element): HTMLElement {
    const r = el.getBoundingClientRect();
    const glow = document.createElement('div');
    glow.className = 'glow';
    glow.style.transform = `translate(${r.left - 4}px, ${r.top - 4}px)`;
    glow.style.width = `${r.width + 8}px`;
    glow.style.height = `${r.height + 8}px`;
    this.layer.append(glow);
    return glow;
  }

  private trayAdd(text: string, action: ToolAction): void {
    window.clearTimeout(this.trayTimer);
    const item = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${action}`;
    item.append(dot, document.createTextNode(text));
    this.tray.append(item);
    while (this.tray.children.length > 3) this.tray.firstElementChild?.remove();
    this.tray.hidden = false;
  }
}
