/**
 * Bee flight. Each bee has a personality: how fast it flies, how sharply it
 * turns, how much it sways, how it hovers once it arrives, how often it picks
 * a new spot, how fast its wings beat and how big it is. Flight is simple
 * steering: every frame the bee turns its velocity toward a moving target
 * (its spot plus its hover pattern), so no two bees trace the same path.
 */

export type HoverStyle = 'orbit' | 'figure8' | 'bob' | 'dart' | 'drift' | 'jitter' | 'swoop';

export interface Personality {
  name: string;
  /** Top speed in px/s. */
  maxSpeed: number;
  /** How quickly velocity turns toward where it wants to go (per second). Low values overshoot and swoop. */
  agility: number;
  /** Sideways sway while flying, in px, and its rate in rad/s. */
  wobbleAmp: number;
  wobbleFreq: number;
  hover: HoverStyle;
  hoverRadius: number;
  hoverSpeed: number;
  /** How often it picks a new spot to work at, in ms (min, max). */
  retargetMs: [number, number];
  /** Wingbeat half-period in seconds. */
  flap: number;
  size: number;
}

export const PERSONALITIES: Personality[] = [
  { name: 'Zippy', maxSpeed: 950, agility: 9, wobbleAmp: 3, wobbleFreq: 22, hover: 'dart', hoverRadius: 0, hoverSpeed: 0, retargetMs: [350, 650], flap: 0.05, size: 0.88 },
  { name: 'Bumble', maxSpeed: 310, agility: 2.6, wobbleAmp: 9, wobbleFreq: 3.5, hover: 'drift', hoverRadius: 22, hoverSpeed: 0.9, retargetMs: [2600, 3800], flap: 0.14, size: 1.14 },
  { name: 'Loopy', maxSpeed: 480, agility: 4.5, wobbleAmp: 2, wobbleFreq: 8, hover: 'orbit', hoverRadius: 26, hoverSpeed: 3.4, retargetMs: [1500, 2400], flap: 0.08, size: 1 },
  { name: 'Glide', maxSpeed: 520, agility: 2.8, wobbleAmp: 2, wobbleFreq: 5, hover: 'figure8', hoverRadius: 20, hoverSpeed: 2, retargetMs: [1800, 2800], flap: 0.11, size: 0.98 },
  { name: 'Jitters', maxSpeed: 640, agility: 7, wobbleAmp: 6, wobbleFreq: 14, hover: 'jitter', hoverRadius: 8, hoverSpeed: 0, retargetMs: [700, 1200], flap: 0.06, size: 0.9 },
  { name: 'Steady', maxSpeed: 380, agility: 5.5, wobbleAmp: 3, wobbleFreq: 6, hover: 'bob', hoverRadius: 10, hoverSpeed: 4, retargetMs: [1300, 2000], flap: 0.09, size: 1.05 },
  { name: 'Swoop', maxSpeed: 780, agility: 2.4, wobbleAmp: 4, wobbleFreq: 4.5, hover: 'swoop', hoverRadius: 34, hoverSpeed: 1.6, retargetMs: [1600, 2600], flap: 0.075, size: 0.95 },
];

/** A shuffled cast, so the first bee out of the hive isn't always the same character. */
export function castOf(size: number): Personality[] {
  const pool = [...PERSONALITIES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return Array.from({ length: size }, (_, i) => pool[i % pool.length]);
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Flyer {
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  /** The spot it is working at. */
  ax: number;
  ay: number;
  dir = 1;
  tilt = 0;
  /** Flying home: no hovering or dawdling, just a quick, direct trip into the hive. */
  homing = false;
  private t = 0;
  private readonly phase = Math.random() * Math.PI * 2;
  private nextRetarget = 0;

  constructor(readonly p: Personality, x: number, y: number) {
    this.x = x;
    this.y = y;
    this.ax = x;
    this.ay = y;
    // Leave the hive with a little upward push, each at its own angle.
    const angle = -Math.PI / 2 + rand(-0.9, 0.9);
    this.vx = Math.cos(angle) * p.maxSpeed * 0.35;
    this.vy = Math.sin(angle) * p.maxSpeed * 0.35;
  }

  setAnchor(x: number, y: number): void {
    this.ax = x;
    this.ay = y;
  }

  /** True when it's this bee's time to pick a new spot. */
  wantsRetarget(nowMs: number): boolean {
    if (nowMs < this.nextRetarget) return false;
    this.nextRetarget = nowMs + rand(...this.p.retargetMs);
    return true;
  }

  private hoverOffset(): [number, number] {
    const { hover, hoverRadius: r, hoverSpeed: s } = this.p;
    const a = this.t * s + this.phase;
    switch (hover) {
      case 'orbit':
        return [Math.cos(a) * r, Math.sin(a) * r * 0.7];
      case 'figure8':
        return [Math.sin(a) * r, Math.sin(2 * a) * r * 0.5];
      case 'bob':
        return [Math.sin(a * 0.5) * r * 0.4, Math.sin(a) * r];
      case 'drift':
        return [Math.cos(a) * r, Math.sin(a * 0.7) * r * 0.6];
      case 'swoop':
        return [Math.sin(a) * r * 1.4, Math.abs(Math.cos(a)) * r * 0.6];
      case 'jitter':
        return [rand(-r, r), rand(-r, r)];
      case 'dart':
      default:
        return [0, 0];
    }
  }

  step(dt: number): void {
    this.t += dt;
    const p = this.p;
    const [hx, hy] = this.homing ? [0, 0] : this.hoverOffset();
    const dx = this.ax + hx - this.x;
    const dy = this.ay + hy - this.y;
    const dist = Math.hypot(dx, dy);
    // Arrive: slow down near the spot instead of overshooting... unless agility is low.
    const top = this.homing ? Math.max(600, p.maxSpeed * 1.4) : p.maxSpeed;
    const speed = top * Math.min(1, dist / (this.homing ? 60 : 140));
    const wantX = dist > 0.01 ? (dx / dist) * speed : 0;
    const wantY = dist > 0.01 ? (dy / dist) * speed : 0;
    const k = Math.min(1, (this.homing ? Math.max(6, p.agility) : p.agility) * dt);
    this.vx += (wantX - this.vx) * k;
    this.vy += (wantY - this.vy) * k;
    if (p.hover === 'jitter' && !this.homing) {
      this.vx += rand(-1, 1) * p.maxSpeed * 2.2 * dt;
      this.vy += rand(-1, 1) * p.maxSpeed * 2.2 * dt;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.vx > 25) this.dir = 1;
    else if (this.vx < -25) this.dir = -1;
    const nose = (Math.atan2(this.vy, Math.abs(this.vx) + 1) * 180) / Math.PI;
    // Ease the bank so it doesn't snap.
    this.tilt += (Math.max(-35, Math.min(35, nose * 0.6)) - this.tilt) * Math.min(1, 10 * dt);
  }

  /** Where to draw it: its position plus a sideways sway that grows with speed. */
  render(): { x: number; y: number } {
    const speed = Math.hypot(this.vx, this.vy);
    if (speed < 1) return { x: this.x, y: this.y };
    const sway = Math.sin(this.t * this.p.wobbleFreq + this.phase) * this.p.wobbleAmp * (0.35 + 0.65 * Math.min(1, speed / this.p.maxSpeed));
    return { x: this.x + (-this.vy / speed) * sway, y: this.y + (this.vx / speed) * sway };
  }

  distanceTo(x: number, y: number): number {
    return Math.hypot(x - this.x, y - this.y);
  }
}
