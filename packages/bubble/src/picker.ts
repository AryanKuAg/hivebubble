import type { PickedElement } from '../../core/src/types';

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

/** A short, stable-ish CSS path to the element (at most five levels). */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 5) {
    if (node.id && !/^\d/.test(node.id)) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const classes = Array.from(node.classList)
      .filter((c) => /^[a-zA-Z][\w-]*$/.test(c) && c.length < 40)
      .slice(0, 2);
    if (classes.length) part += classes.map((c) => `.${c}`).join('');
    const parent: Element | null = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (node.tagName === 'BODY') break;
    node = parent;
  }
  return parts.join(' > ');
}

export function describeElement(el: Element): PickedElement {
  const raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return {
    tag: el.tagName.toLowerCase(),
    selector: cssPath(el),
    text: raw.trim().replace(/\s+/g, ' ').slice(0, 200),
    html: el.outerHTML.slice(0, 600),
    src: el.closest('[data-hivebubble-src]')?.getAttribute('data-hivebubble-src') ?? undefined,
  };
}

/**
 * Hover to highlight, click to pick, Esc to cancel. Returns a function that
 * cancels picking.
 */
export function startPicker(
  host: Element,
  box: HTMLElement,
  onPick: (el: Element) => void,
  onCancel: () => void,
): () => void {
  let current: Element | null = null;
  const html = document.documentElement;
  const prevCursor = html.style.cursor;
  html.style.cursor = 'crosshair';

  const targetAt = (x: number, y: number): Element | null => {
    const el = document.elementFromPoint(x, y);
    if (!el || el === host || host.contains(el) || el === html || el === document.body) return null;
    return el;
  };
  const show = (el: Element | null) => {
    current = el;
    if (!el) {
      box.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    box.hidden = false;
    box.style.transform = `translate(${r.left}px, ${r.top}px)`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    box.dataset.tag = el.tagName.toLowerCase();
  };
  const onMove = (e: MouseEvent) => show(targetAt(e.clientX, e.clientY));
  const onClick = (e: MouseEvent) => {
    const el = targetAt(e.clientX, e.clientY);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
    onPick(el);
  };
  const block = (e: Event) => {
    if (current && e.target !== host) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      stop();
      onCancel();
    }
  };
  function stop() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('mousedown', block, true);
    document.removeEventListener('mouseup', block, true);
    document.removeEventListener('keydown', onKey, true);
    html.style.cursor = prevCursor;
    box.hidden = true;
  }
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('mousedown', block, true);
  document.addEventListener('mouseup', block, true);
  document.addEventListener('keydown', onKey, true);
  return stop;
}
