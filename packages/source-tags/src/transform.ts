import { parse, type ParserPlugin } from '@babel/parser';
import MagicString, { type SourceMap } from 'magic-string';

/** The attribute every tagged element gets: `data-hivebubble-src="src/App.jsx:12:7"` (file:line:column). */
export const ATTR = 'data-hivebubble-src';

/**
 * Elements that end up as real DOM nodes. Only these are tagged: a lowercase
 * JSX name is not always a DOM element (react-three-fiber's `<mesh>`, for
 * example), and an unknown prop on one of those can crash its renderer.
 * Document-level and invisible tags are left out on purpose.
 */
const HTML = `a abbr address area article aside audio b bdi bdo big blockquote br button canvas caption center cite code data
datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr
i iframe img input ins kbd label legend li main map mark marquee menu meter nav object ol optgroup option output p picture
pre progress q rp rt ruby s samp search section select slot small span strong sub summary sup table tbody td textarea tfoot
th thead time tr u ul var video`;
const SVG = 'svg g path circle ellipse line polygon polyline rect text tspan textPath image use foreignObject';
const HOST_TAGS = new Set(`${HTML} ${SVG}`.split(/\s+/));

/** Libraries whose lowercase JSX names are not DOM elements. Files importing them are left alone. */
const NON_DOM_RENDERERS = /^(?:three|three\/.*|@react-three\/.*)$/;

export function isHostTag(name: string): boolean {
  // Custom elements (web components) always contain a dash.
  return HOST_TAGS.has(name) || /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(name);
}

export interface TagResult {
  code: string;
  map: SourceMap;
  /** How many elements were tagged. */
  count: number;
}

interface Node {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens']);

function walk(root: unknown, visit: (node: Node) => void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
      continue;
    }
    const node = value as Node;
    if (typeof node.type === 'string') visit(node);
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const child = node[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
}

function parseModule(code: string, typescript: boolean): Node | null {
  const base: ParserPlugin[] = typescript ? ['jsx', 'typescript'] : ['jsx'];
  const attempts: ParserPlugin[][] = [
    [...base, ['decorators', {}]],
    [...base, 'decorators-legacy'],
  ];
  for (const plugins of attempts) {
    try {
      return parse(code, {
        sourceType: 'module',
        plugins,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowUndeclaredExports: true,
      }) as unknown as Node;
    } catch {
      // Try the next decorator flavour; give up quietly after that.
    }
  }
  return null;
}

function importsNonDomRenderer(ast: Node): boolean {
  const program = ast.program as { body?: Node[] } | undefined;
  for (const statement of program?.body ?? []) {
    const source = (statement.source as { value?: unknown } | undefined)?.value;
    if (typeof source === 'string' && NON_DOM_RENDERERS.test(source)) return true;
  }
  return false;
}

/**
 * Add `data-hivebubble-src="<file>:<line>:<column>"` to every DOM element
 * written in JSX in this module. Only inserts text inside existing lines, so
 * line numbers never move, and returns a source map for the column shifts.
 * Returns null when there is nothing to tag or the code can't be parsed (the
 * module is then served exactly as it was).
 *
 * @param file Path shown in the attribute, relative to the project folder, with forward slashes.
 */
export function tagSource(code: string, file: string, opts: { typescript: boolean; sourceName?: string }): TagResult | null {
  if (!code.includes('<')) return null;
  const ast = parseModule(code, opts.typescript);
  if (!ast || importsNonDomRenderer(ast)) return null;

  const s = new MagicString(code);
  let count = 0;
  walk(ast, (node) => {
    if (node.type !== 'JSXOpeningElement') return;
    const name = node.name as Node & { name?: unknown };
    if (name.type !== 'JSXIdentifier' || typeof name.name !== 'string' || !isHostTag(name.name)) return;
    const attributes = (node.attributes ?? []) as Array<Node & { name?: { name?: unknown } }>;
    if (attributes.some((a) => a.type === 'JSXAttribute' && a.name?.name === ATTR)) return;
    if (typeof name.end !== 'number' || !node.loc) return;
    const where = `${file}:${node.loc.start.line}:${node.loc.start.column + 1}`;
    // A JS string in braces, so any character in a file name is safe.
    s.appendLeft(name.end, ` ${ATTR}={${JSON.stringify(where)}}`);
    count++;
  });
  if (count === 0) return null;
  return {
    code: s.toString(),
    map: s.generateMap({ source: opts.sourceName ?? file, includeContent: true, hires: 'boundary' }),
    count,
  };
}
