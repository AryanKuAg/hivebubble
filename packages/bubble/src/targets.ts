/**
 * From an agent step to elements on the page. Projects with source tags carry
 * `data-hivebubble-src="file:line:col"` on every element their JSX draws, so a
 * step on lines 12-14 of Hero.jsx maps to the elements written on those lines.
 * Stylesheet steps come with the selectors of the rules involved.
 */

export const SRC_ATTR = 'data-hivebubble-src';

export interface SrcTag {
  file: string;
  line: number;
  col: number;
}

export interface Tagged {
  el: Element;
  tag: SrcTag;
}

export interface Where {
  file?: string;
  lines?: [number, number];
  selectors?: string[];
}

export function parseSrc(value: string | null | undefined): SrcTag | null {
  const m = value?.match(/^(.+?):(\d+)(?::(\d+))?$/);
  return m ? { file: m[1], line: Number(m[2]), col: Number(m[3] ?? 1) } : null;
}

/** "Hero.jsx:12" for showing a tag to people. */
export function shortSrc(value: string | undefined): string | undefined {
  const tag = parseSrc(value);
  return tag ? `${tag.file.split('/').pop()}:${tag.line}` : undefined;
}

/**
 * Which tagged elements a line range refers to: the ones written on those
 * lines, else the nearest one written above them (usually the element the
 * lines sit inside), else everything from the file. No range means the whole
 * file. Pure, so it can be tested without a page.
 */
export function pickByLines<T extends { tag: SrcTag }>(entries: T[], lines?: [number, number]): T[] {
  if (!lines || entries.length === 0) return entries;
  const [a, b] = lines;
  const inside = entries.filter((e) => e.tag.line >= a && e.tag.line <= b);
  if (inside.length > 0) return inside;
  let nearest = -1;
  for (const e of entries) if (e.tag.line <= a && e.tag.line > nearest) nearest = e.tag.line;
  return nearest === -1 ? entries : entries.filter((e) => e.tag.line === nearest);
}

/** Drop elements that sit inside another element of the list. */
export function outermost(els: Element[]): Element[] {
  return els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
}

export function pageHasTags(): boolean {
  return document.querySelector(`[${SRC_ATTR}]`) !== null;
}

function allTagged(): Tagged[] {
  const out: Tagged[] = [];
  for (const el of Array.from(document.querySelectorAll(`[${SRC_ATTR}]`))) {
    const tag = parseSrc(el.getAttribute(SRC_ATTR));
    if (tag) out.push({ el, tag });
  }
  return out;
}

export function taggedIn(file: string): Tagged[] {
  return allTagged().filter((t) => t.tag.file === file);
}

/** A folder rather than a file: a search or glob over `src`, or `.` for the whole project. */
export function isFolder(path: string): boolean {
  return path === '' || path === '.' || !/\.[^/.]+$/.test(path.replace(/\/+$/, ''));
}

/** Tagged elements drawn by any file inside a folder (`.` for the whole project). */
export function taggedUnder(folder: string): Tagged[] {
  const clean = folder.replace(/\/+$/, '');
  const prefix = clean === '' || clean === '.' ? '' : `${clean}/`;
  return allTagged().filter((t) => t.tag.file.startsWith(prefix));
}

export function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

function bySelectors(selectors: string[], host: Element): Element[] {
  const found: Element[] = [];
  for (const selector of selectors) {
    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      continue; // Not a selector the browser understands (Sass-only syntax and the like).
    }
    for (const el of matches) {
      const target = el === document.documentElement ? document.body : el;
      if (target && target !== host && !host.contains(target) && !found.includes(target)) found.push(target);
    }
  }
  return found;
}

/**
 * Up to `limit` evenly spread items, keeping their order: a quick tour of a
 * file's elements instead of every one of them.
 */
export function spread<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, i) => items[Math.round((i * (items.length - 1)) / (limit - 1))]);
}

/**
 * The elements a step is about, visible ones first. Empty when the code it
 * touches draws nothing on this page (config, data files, API routes): that
 * work goes to the workbench tray instead.
 */
export function resolveTargets(where: Where, host: Element, limit = 6): Element[] {
  let els: Element[] = [];
  if (where.selectors && where.selectors.length > 0) {
    els = outermost(bySelectors(where.selectors, host));
  } else if (where.file) {
    // A step on a folder (a search over src/) covers everything drawn from inside it.
    const folder = isFolder(where.file);
    const entries = folder ? taggedUnder(where.file) : taggedIn(where.file);
    const picked = pickByLines(entries, folder ? undefined : where.lines).map((t) => t.el);
    if (where.lines && !folder) {
      els = outermost(picked);
    } else {
      // The whole file: tour the elements it draws, skipping wrappers as big as the page.
      const area = innerWidth * innerHeight;
      const sized = picked.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width * r.height < area * 0.6;
      });
      els = sized.length > 0 ? sized : outermost(picked);
    }
  }
  const visible = els.filter(isVisible);
  return spread(visible.length > 0 ? visible : els, limit);
}
