import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type Framework =
  | 'next'
  | 'vite'
  | 'astro'
  | 'sveltekit'
  | 'remix'
  | 'nuxt'
  | 'create-react-app'
  | 'unknown';

export interface ProjectInfo {
  dir: string;
  name: string;
  framework: Framework;
  packageManager: PackageManager;
  /** The package.json script that starts the dev server ("dev" or "start"). */
  devScript: string;
  /** What that script runs, e.g. "vite" or "next dev". */
  devScriptCommand: string;
  needsInstall: boolean;
}

export class ProjectError extends Error {}

const FRAMEWORK_LABELS: Record<Framework, string> = {
  next: 'Next.js',
  vite: 'Vite',
  astro: 'Astro',
  sveltekit: 'SvelteKit',
  remix: 'Remix',
  nuxt: 'Nuxt',
  'create-react-app': 'Create React App',
  unknown: 'Web app',
};

export function frameworkLabel(f: Framework): string {
  return FRAMEWORK_LABELS[f];
}

function detectFramework(deps: Record<string, string>): Framework {
  if (deps.next) return 'next';
  if (deps.nuxt) return 'nuxt';
  if (deps.astro) return 'astro';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps['@remix-run/dev']) return 'remix';
  if (deps['react-scripts']) return 'create-react-app';
  if (deps.vite) return 'vite';
  return 'unknown';
}

function detectPackageManager(dir: string): PackageManager {
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(dir, 'bun.lockb')) || existsSync(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

export function detectProject(dirInput: string): ProjectInfo {
  const dir = path.resolve(dirInput);
  const pkgPath = path.join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new ProjectError(`No package.json in ${dir}. Open the folder of a JavaScript web project (Next.js, Vite, Astro, …).`);
  }
  let pkg: { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    throw new ProjectError(`package.json in ${dir} is not valid JSON.`);
  }
  const scripts = pkg.scripts ?? {};
  const devScript = scripts.dev ? 'dev' : scripts.start ? 'start' : '';
  if (!devScript) {
    throw new ProjectError('This project has no "dev" or "start" script in package.json, so Hivebubble cannot start it.');
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return {
    dir,
    name: pkg.name || path.basename(dir),
    framework: detectFramework(deps),
    packageManager: detectPackageManager(dir),
    devScript,
    devScriptCommand: scripts[devScript] ?? '',
    needsInstall: !existsSync(path.join(dir, 'node_modules')),
  };
}

export interface CommandSpec {
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

export function installCommand(info: ProjectInfo): CommandSpec {
  return { cmd: info.packageManager, args: ['install'], env: {} };
}

/**
 * The command that starts the project's dev server on a given port. `extra`
 * arguments go to the dev server itself (for Vite: Hivebubble's config).
 */
export function devCommand(info: ProjectInfo, port: number, extra: string[] = []): CommandSpec {
  const p = String(port);
  let portArgs: string[];
  switch (info.framework) {
    case 'vite':
    case 'sveltekit':
    case 'remix':
      portArgs = ['--port', p, '--strictPort'];
      break;
    case 'next':
    case 'astro':
    case 'nuxt':
      portArgs = ['--port', p];
      break;
    default:
      // create-react-app and unknown setups read PORT from the environment.
      portArgs = [];
  }
  const args = ['run', info.devScript];
  const passed = [...extra, ...portArgs];
  if (passed.length > 0) {
    if (info.packageManager === 'npm') args.push('--');
    args.push(...passed);
  }
  return { cmd: info.packageManager, args, env: { PORT: p, BROWSER: 'none' } };
}
