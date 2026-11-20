import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectInfo } from './project.js';

/**
 * Source tags: a dev-only build step that stamps `data-hivebubble-src="file:line:col"`
 * on page elements, so the picker knows where an element is written and the
 * bees can fly to the exact element the agent is working on.
 *
 * Hivebubble never edits the person's own config to add it. For Vite projects
 * it writes a small config in `.hivebubble/` that loads theirs unchanged, adds
 * the plugin, and starts Vite with `--config` pointing at it. Running `npm run
 * dev` by hand still uses only their own config.
 */

export const HIVEBUBBLE_DIR = '.hivebubble';
export const VITE_WRAPPER = 'vite.config.mjs';

/** Vite's own search order for config files. */
const VITE_CONFIGS = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'];

export type SourceTagsPlan = { on: true; args: string[] } | { on: false; why: string };

export function findViteConfig(dir: string): string | null {
  for (const name of VITE_CONFIGS) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Why this project can't get source tags, or null when it can. */
export function sourceTagsBlocker(info: ProjectInfo, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.HIVEBUBBLE_SOURCE_TAGS === '0') return 'they are turned off (HIVEBUBBLE_SOURCE_TAGS=0)';
  if (info.framework !== 'vite') return 'they only work with Vite projects so far';
  const command = info.devScriptCommand.trim();
  // Only a script that starts Vite directly takes the extra --config reliably.
  if (!/^(?:npx\s+)?vite(?:\s+(?:dev|serve))?(?:\s|$)/.test(command)) {
    return `the "${info.devScript}" script doesn't start Vite directly`;
  }
  if (/(?:^|\s)(?:--config|-c)(?:\s|=|$)/.test(command)) return `the "${info.devScript}" script picks its own Vite config`;
  return null;
}

/** The URL of the Vite plugin module, for the generated config to import. */
export function sourceTagsPluginUrl(): string {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@hivebubble/source-tags/dist/vite.js');
  if (!existsSync(file)) throw new Error('The source-tags plugin is not built yet. Run `pnpm build` in the Hivebubble folder.');
  return pathToFileURL(file).href;
}

/** The generated config: the person's Vite config, unchanged, plus Hivebubble's dev-only plugin. */
export function viteWrapperSource(projectDir: string, userConfig: string | null, pluginUrl: string): string {
  return `// Written by Hivebubble each time it starts this project, and only used then.
// It loads your own Vite config unchanged and adds Hivebubble's dev-only source
// tags (data-hivebubble-src on page elements). Production builds never see it.
// Safe to delete.
import { loadConfigFromFile, mergeConfig } from 'vite';

const projectDir = ${JSON.stringify(projectDir)};
const userConfig = ${JSON.stringify(userConfig)};
const plugin = ${JSON.stringify(pluginUrl)};
// A dynamic import Vite's config bundler leaves alone.
const load = (specifier) => import(specifier);

export default async (env) => {
  const loaded = userConfig ? await loadConfigFromFile(env, userConfig, projectDir) : null;
  const config = loaded ? loaded.config : {};
  try {
    const { sourceTags } = await load(plugin);
    // Hivebubble's plugin goes first, so it sees JSX before anything compiles it.
    return mergeConfig({ plugins: [sourceTags({ projectDir, restartOn: loaded ? loaded.dependencies : [] })] }, config);
  } catch (err) {
    console.warn('[hivebubble] Source tags are off: ' + (err && err.message ? err.message : err));
    return config;
  }
};
`;
}

/**
 * Get a project ready for source tags. Writes `.hivebubble/vite.config.mjs`
 * (and a `.gitignore` so the folder never shows up in git) and returns the
 * extra dev-server arguments, or says why tags are off.
 */
export function planSourceTags(info: ProjectInfo, pluginUrl: () => string = sourceTagsPluginUrl): SourceTagsPlan {
  const blocker = sourceTagsBlocker(info);
  if (blocker) return { on: false, why: blocker };
  try {
    const dir = path.join(info.dir, HIVEBUBBLE_DIR);
    mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '# Hivebubble\'s own files for this project.\n*\n');
    writeFileSync(path.join(dir, VITE_WRAPPER), viteWrapperSource(info.dir, findViteConfig(info.dir), pluginUrl()));
    return { on: true, args: ['--config', `${HIVEBUBBLE_DIR}/${VITE_WRAPPER}`] };
  } catch (err) {
    return { on: false, why: err instanceof Error ? err.message : String(err) };
  }
}
