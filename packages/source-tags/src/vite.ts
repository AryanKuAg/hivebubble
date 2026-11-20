import { realpathSync } from 'node:fs';
import path from 'node:path';
import { tagSource, type TagResult } from './transform.js';

export interface SourceTagsOptions {
  /** The project folder Hivebubble opened. Attribute paths are relative to it. */
  projectDir: string;
  /**
   * Files that should restart the dev server when they change: the person's
   * own Vite config and what it imports. Hivebubble starts Vite with its own
   * small config that loads theirs, so Vite doesn't watch theirs by itself.
   */
  restartOn?: string[];
}

/** The parts of a Vite plugin this one uses, typed locally so the package doesn't depend on Vite. */
export interface SourceTagsPlugin {
  name: string;
  enforce: 'pre';
  apply: 'serve';
  configureServer(server: DevServer): void;
  transform: {
    filter: { id: RegExp };
    handler(code: string, id: string): TagResult | null;
  };
}

interface DevServer {
  watcher: { add(paths: string[]): unknown; on(event: 'change', cb: (file: string) => void): unknown };
  restart(): Promise<void>;
  config: { logger: { info(msg: string, opts?: { timestamp?: boolean }): void } };
}

const SOURCE = /\.(?:jsx|tsx|js)$/;
/** Queries Vite adds to ordinary module requests. Anything else (?raw, ?url, ?worker…) is not page code. */
const PLAIN_QUERY = /^(?:(?:t|v|import)(?:=[\w.-]*)?&?)*$/;

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The project-relative path of a module, with forward slashes, or null when it's not the person's own code. */
export function projectPath(roots: string[], id: string): string | null {
  if (id.startsWith('\0')) return null;
  const [file, query] = id.split('?', 2);
  if (query !== undefined && !PLAIN_QUERY.test(query)) return null;
  if (!SOURCE.test(file) || file.includes('/node_modules/') || file.includes('\\node_modules\\')) return null;
  for (const root of roots) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return null;
}

/**
 * Hivebubble's source tags as a Vite plugin. Dev server only (`apply: 'serve'`),
 * so production builds never contain the tags. It runs before other plugins,
 * while the JSX is still JSX.
 */
export function sourceTags(opts: SourceTagsOptions): SourceTagsPlugin {
  const roots = [...new Set([path.resolve(opts.projectDir), real(opts.projectDir)])];
  const restartOn = new Set((opts.restartOn ?? []).map(real));

  return {
    name: 'hivebubble:source-tags',
    enforce: 'pre',
    apply: 'serve',
    configureServer(server) {
      if (restartOn.size === 0) return;
      server.watcher.add([...restartOn]);
      server.watcher.on('change', (changed) => {
        if (!restartOn.has(real(changed))) return;
        server.config.logger.info(`[hivebubble] ${path.basename(changed)} changed, restarting the dev server…`, { timestamp: true });
        void server.restart();
      });
    },
    transform: {
      filter: { id: /\.(?:jsx|tsx|js)(?:\?|$)/ },
      handler(code, id) {
        const rel = projectPath(roots, id);
        if (!rel) return null;
        return tagSource(code, rel, { typescript: rel.endsWith('.tsx'), sourceName: id.split('?')[0] });
      },
    },
  };
}
