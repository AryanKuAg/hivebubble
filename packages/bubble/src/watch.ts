import { SRC_ATTR } from './targets';

interface Waiter {
  file: string;
  style: boolean;
  done: (updated: boolean) => void;
}

const OVERLAY = 'VITE-ERROR-OVERLAY';

/**
 * Watches the page for two things:
 * - an edited file reaching the page through hot reload (elements drawn by
 *   that file change, or its stylesheet is swapped), so a ✓ only appears once
 *   the change is really there;
 * - the dev server's error overlay, so a bee can point at the problem.
 */
export class PageWatcher {
  private readonly waiters = new Set<Waiter>();
  private overlay: Element | null = null;

  constructor(
    private readonly host: Element,
    private readonly onOverlay: (overlay: Element | null) => void,
  ) {
    new MutationObserver((records) => this.check(records)).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }

  /** Resolves true once the page shows a change from `file`, or false after the timeout. */
  afterUpdate(file: string, style: boolean, timeoutMs = 2500): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        file,
        style,
        done: (updated) => {
          if (!this.waiters.delete(waiter)) return;
          window.clearTimeout(timer);
          // Let the framework finish rendering and the browser lay it out first.
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(updated)));
        },
      };
      const timer = window.setTimeout(() => waiter.done(false), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  private check(records: MutationRecord[]): void {
    let overlayChanged = false;
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
          if (node.nodeName === OVERLAY) overlayChanged = true;
        }
      }
      if (this.waiters.size === 0) continue;
      const target = record.target;
      if (target === document.documentElement || target === this.host || this.host.contains(target)) continue;
      const el = target.nodeType === Node.ELEMENT_NODE ? (target as Element) : target.parentElement;
      if (!el) continue;
      for (const waiter of [...this.waiters]) {
        if (this.matches(waiter, el, record)) waiter.done(true);
      }
    }
    if (overlayChanged) {
      const overlay = document.querySelector('vite-error-overlay');
      if (overlay !== this.overlay) {
        this.overlay = overlay;
        this.onOverlay(overlay);
      }
    }
  }

  private matches(waiter: Waiter, el: Element, record: MutationRecord): boolean {
    if (waiter.style) {
      // Vite swaps a stylesheet's text in a <style data-vite-dev-id="/abs/path/App.css">.
      const style = el.closest('style[data-vite-dev-id]');
      const id = style?.getAttribute('data-vite-dev-id') ?? '';
      if (id === waiter.file || id.endsWith(`/${waiter.file}`)) return true;
      const href = el.closest('link[rel~="stylesheet"]')?.getAttribute('href') ?? '';
      return href.includes(waiter.file.split('/').pop() ?? '\0');
    }
    const prefix = `${waiter.file}:`;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttribute(SRC_ATTR)?.startsWith(prefix)) return true;
    }
    for (const added of Array.from(record.addedNodes)) {
      if (added.nodeType !== Node.ELEMENT_NODE) continue;
      const a = added as Element;
      if (a.getAttribute(SRC_ATTR)?.startsWith(prefix)) return true;
      for (const inner of Array.from(a.querySelectorAll(`[${SRC_ATTR}]`))) {
        if (inner.getAttribute(SRC_ATTR)!.startsWith(prefix)) return true;
      }
    }
    return false;
  }
}
