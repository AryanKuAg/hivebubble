import { SRC_ATTR } from './targets';

/**
 * Overlays drawn over page elements while the hive works on them:
 * - ripple: the element's code is being read (or a search found it);
 * - shimmer: its code is being edited;
 * - check: the edit reached the page through hot reload;
 * - alert: something went wrong here.
 * They live in the bubble's own layer and follow their element every frame
 * (scrolling, layout shifts, React re-mounting it after an edit).
 */

export type FxKind = 'ripple' | 'shimmer' | 'check' | 'alert';

export interface Fx {
  kind: FxKind;
  node: HTMLElement;
  el: Element;
  /** The element's source tag and its index among elements with that tag, to find it again after a re-render. */
  src: string | null;
  nth: number;
  gone: boolean;
}

/** Elements drawn by the same line of code (a list's items), in page order. */
function sameSrc(src: string): Element[] {
  return Array.from(document.querySelectorAll(`[${SRC_ATTR}]`)).filter((e) => e.getAttribute(SRC_ATTR) === src);
}

/** How to find an element again after hot reload replaces it: its tag and its index among same-tag elements. */
function whereIs(el: Element): { src: string | null; nth: number } {
  const src = el.getAttribute(SRC_ATTR);
  return { src, nth: src ? Math.max(0, sameSrc(src).indexOf(el)) : 0 };
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class Effects {
  private list: Fx[] = [];

  constructor(private readonly layer: HTMLElement) {}

  get active(): boolean {
    return this.list.length > 0;
  }

  add(kind: FxKind, el: Element, ttlMs?: number): Fx {
    const node = document.createElement('div');
    node.className = `fx ${kind}`;
    if (kind === 'shimmer') node.innerHTML = '<i class="band"></i>';
    if (kind === 'check') node.innerHTML = CHECK_SVG;
    if (kind === 'alert') node.innerHTML = '<b>!</b>';
    const fx: Fx = { kind, node, el, ...whereIs(el), gone: false };
    this.layer.append(node);
    this.list.push(fx);
    this.place(fx);
    if (ttlMs) window.setTimeout(() => this.remove(fx), ttlMs);
    return fx;
  }

  /** Point an overlay at another element (a reading ripple moving along the file). */
  move(fx: Fx, el: Element): void {
    if (fx.gone || fx.el === el) return;
    Object.assign(fx, { el, ...whereIs(el) });
    // A fresh node restarts the ripple's animation on the new element.
    const fresh = fx.node.cloneNode(true) as HTMLElement;
    fx.node.replaceWith(fresh);
    fx.node = fresh;
    this.place(fx);
  }

  remove(fx: Fx | null | undefined, fade = true): void {
    if (!fx || fx.gone) return;
    fx.gone = true;
    this.list = this.list.filter((f) => f !== fx);
    if (!fade) return fx.node.remove();
    fx.node.classList.add('fade');
    window.setTimeout(() => fx.node.remove(), 450);
  }

  /** Remove everything except ✓ marks that are still showing (they leave on their own) and `keep`. */
  clear(keep: Fx[] = []): void {
    for (const fx of [...this.list]) if (fx.kind !== 'check' && !keep.includes(fx)) this.remove(fx);
  }

  /** Keep every overlay on its element. Called each animation frame. */
  update(): void {
    for (const fx of [...this.list]) this.place(fx);
  }

  private place(fx: Fx): void {
    if (!fx.el.isConnected) {
      const again = fx.src ? sameSrc(fx.src)[fx.nth] : undefined;
      if (!again) {
        fx.node.style.opacity = '0';
        return;
      }
      fx.el = again;
    }
    const r = fx.el.getBoundingClientRect();
    const hidden = r.width < 1 && r.height < 1;
    fx.node.style.opacity = hidden ? '0' : '';
    if (hidden) return;
    if (fx.kind === 'check') {
      // A badge on the element's top-right corner, kept on screen.
      const x = Math.min(innerWidth - 30, Math.max(6, r.right - 12));
      const y = Math.min(innerHeight - 30, Math.max(6, r.top - 12));
      fx.node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      return;
    }
    // Outline boxes are clipped to the viewport, so a section taller than the screen still shows its edges.
    const pad = 4;
    const left = Math.max(2, r.left - pad);
    const top = Math.max(2, r.top - pad);
    const w = Math.max(0, Math.min(innerWidth - 2, r.right + pad) - left);
    const h = Math.max(0, Math.min(innerHeight - 2, r.bottom + pad) - top);
    fx.node.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
    const width = `${w.toFixed(1)}px`;
    const height = `${h.toFixed(1)}px`;
    if (fx.node.style.width !== width) fx.node.style.width = width;
    if (fx.node.style.height !== height) fx.node.style.height = height;
  }
}
