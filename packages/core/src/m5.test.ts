import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.HIVEBUBBLE_HOME = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-home-'));

const { deployCloudflare, deployNetlify, deployVercel, siteSlug } = await import('./hosts.js');
const { deploySite, envNeeds, hostCards, readDeployState } = await import('./deploy.js');
const { Session } = await import('./session.js');
type ServerEvent = import('./types.js').ServerEvent;
type DeployEvent = Extract<ServerEvent, { type: 'deploy' }>;
type ProjectInfo = import('./project.js').ProjectInfo;

const sha1 = (b: Buffer | string) => createHash('sha1').update(b).digest('hex');
const file = (p: string, text: string) => ({ path: p, body: Buffer.from(text), sha1: sha1(text) });
const SITE = [file('index.html', '<!doctype html><title>Hi</title>'), file('assets/app.js', 'console.log(1)'), file('assets/copy.js', 'console.log(1)')];

function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-m5-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

// ---- fake hosts, following the documented flows ----

const vercel = { uploads: new Map<string, Buffer>(), deployments: [] as Array<Record<string, unknown>>, polls: 0 };
const netlify = { sites: [] as Array<{ id: string; name: string }>, deploys: new Map<string, { files: Record<string, string>; uploaded: Set<string>; known: Set<string> }>, takenOnce: false };

function body(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
  });
}
const json = (res: http.ServerResponse, status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const data = await body(req);
  if (req.headers.authorization !== 'Bearer good-token') return json(res, 403, { error: { message: 'Not authorized' } });
  // Vercel
  if (req.method === 'POST' && url.pathname === '/vercel/v2/files') {
    const digest = String(req.headers['x-vercel-digest']);
    if (digest !== sha1(data)) return json(res, 400, { error: { code: 'invalid_digest', message: 'Digest is not valid' } });
    vercel.uploads.set(digest, data);
    return json(res, 200, {});
  }
  if (req.method === 'POST' && url.pathname === '/vercel/v13/deployments') {
    const body = JSON.parse(data.toString());
    const missing = (body.files as Array<{ sha: string }>).filter((f) => !vercel.uploads.has(f.sha));
    if (missing.length) return json(res, 400, { error: { code: 'missing_files', missing: missing.map((m) => m.sha) } });
    vercel.deployments.push({ ...body, query: url.search });
    return json(res, 200, { id: 'dpl_1', url: `${body.name}-abc123.vercel.app`, readyState: 'QUEUED', alias: [] });
  }
  if (req.method === 'GET' && url.pathname === '/vercel/v13/deployments/dpl_1') {
    vercel.polls++;
    const name = String(vercel.deployments.at(-1)?.name);
    return json(res, 200, vercel.polls < 2 ? { id: 'dpl_1', url: 'x', readyState: 'BUILDING' } : { id: 'dpl_1', url: `${name}-abc123.vercel.app`, readyState: 'READY', alias: [`${name}.vercel.app`] });
  }
  // Netlify
  if (req.method === 'POST' && url.pathname === '/netlify/sites') {
    const { name } = JSON.parse(data.toString());
    if (!netlify.takenOnce) {
      netlify.takenOnce = true;
      return json(res, 422, { message: 'subdomain must be unique' });
    }
    const site = { id: `site_${netlify.sites.length + 1}`, name };
    netlify.sites.push(site);
    return json(res, 201, { ...site, ssl_url: `https://${name}.netlify.app`, admin_url: `https://app.netlify.com/sites/${name}` });
  }
  const siteGet = url.pathname.match(/^\/netlify\/sites\/(site_\d+)$/);
  if (req.method === 'GET' && siteGet) {
    const site = netlify.sites.find((s) => s.id === siteGet[1]);
    return site ? json(res, 200, { ...site, ssl_url: `https://${site.name}.netlify.app` }) : json(res, 404, {});
  }
  const deployNew = url.pathname.match(/^\/netlify\/sites\/(site_\d+)\/deploys$/);
  if (req.method === 'POST' && deployNew) {
    const files = JSON.parse(data.toString()).files as Record<string, string>;
    const id = `deploy_${netlify.deploys.size + 1}`;
    // Netlify already "has" files from earlier deploys of the same site.
    const known = new Set([...netlify.deploys.values()].flatMap((d) => [...d.uploaded]));
    netlify.deploys.set(id, { files, uploaded: new Set(), known });
    const required = [...new Set(Object.values(files))].filter((h) => !known.has(h));
    return json(res, 200, { id, state: 'uploading', required });
  }
  const upload = url.pathname.match(/^\/netlify\/deploys\/(deploy_\d+)\/files\/(.+)$/);
  if (req.method === 'PUT' && upload) {
    const d = netlify.deploys.get(upload[1])!;
    const p = `/${decodeURIComponent(upload[2])}`;
    if (d.files[p] !== sha1(data)) return json(res, 422, { message: `content does not match ${p}` });
    d.uploaded.add(sha1(data));
    return json(res, 200, { id: upload[1], path: p, sha: sha1(data) });
  }
  const deployGet = url.pathname.match(/^\/netlify\/deploys\/(deploy_\d+)$/);
  if (req.method === 'GET' && deployGet) {
    const d = netlify.deploys.get(deployGet[1])!;
    const all = new Set(Object.values(d.files));
    const ready = [...all].every((h) => d.uploaded.has(h) || d.known.has(h));
    return json(res, 200, { id: deployGet[1], state: ready ? 'ready' : 'uploading', ssl_url: 'https://x.netlify.app' });
  }
  json(res, 404, { error: { message: `no route ${req.method} ${url.pathname}` } });
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  process.env.HIVEBUBBLE_VERCEL_API = `http://127.0.0.1:${port}/vercel`;
  process.env.HIVEBUBBLE_NETLIFY_API = `http://127.0.0.1:${port}/netlify`;
});
after(() => server.close());

describe('hosts', () => {
  it('Vercel: uploads each distinct file by SHA-1, creates a production deployment and waits for it', async () => {
    const steps: string[] = [];
    const out = await deployVercel(SITE, { token: 'good-token', name: 'honey-and-crumb', pollMs: 5 }, (p) => steps.push(`${p.phase}:${p.done ?? ''}/${p.total ?? ''}`));
    assert.equal(out.url, 'https://honey-and-crumb.vercel.app');
    assert.equal(vercel.uploads.size, 2); // two files share one content
    const dep = vercel.deployments[0] as { target: string; files: Array<{ file: string }>; projectSettings: { framework: null }; query: string };
    assert.deepEqual([dep.target, dep.files.map((f) => f.file).sort(), dep.projectSettings.framework], ['production', ['assets/app.js', 'assets/copy.js', 'index.html'], null]);
    assert.match(dep.query, /skipAutoDetectionConfirmation=1/);
    assert.ok(steps.includes('upload:2/2'));
  });
  it('Vercel: explains a rejected token', async () => {
    await assert.rejects(deployVercel(SITE, { token: 'bad', name: 'x', pollMs: 5 }, () => undefined), /refused the token/);
  });
  it('Netlify: makes a site once (retrying a taken name), uploads only what it lacks, and reuses the site next time', async () => {
    const first = await deployNetlify(SITE, { token: 'good-token', name: 'Honey & Crumb', pollMs: 5 }, () => undefined);
    assert.match(first.url, /^https:\/\/honey-crumb-[a-z0-9]{4}\.netlify\.app$/);
    assert.equal(netlify.sites.length, 1);
    const sent: string[] = [];
    const second = await deployNetlify(SITE, { token: 'good-token', name: 'Honey & Crumb', siteId: first.state.siteId, pollMs: 5 }, (p) => p.file && sent.push(p.file));
    assert.equal(second.state.siteId, first.state.siteId);
    assert.equal(netlify.sites.length, 1);
    assert.deepEqual(sent, []); // nothing changed, nothing re-sent
  });
  it('Cloudflare: deploys an assets-only Worker with Wrangler and reads the address it reports', async () => {
    const dir = tempDir({ 'index.html': '<p>hi</p>' });
    let seen: { args: string[]; config: Record<string, unknown>; env: Record<string, string> } | null = null;
    const out = await deployCloudflare(dir, {
      token: 'cf-token', accountId: 'acc123', name: 'Honey & Crumb', today: '2026-11-21',
      run: async (cmd, args, env, onLine) => {
        const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
        seen = { args, config, env };
        onLine('Uploaded honey-crumb');
        writeFileSync(env.WRANGLER_OUTPUT_FILE_PATH, `${JSON.stringify({ type: 'deploy', targets: ['https://honey-crumb.acme.workers.dev'] })}\n`);
        return 0;
      },
    }, () => undefined);
    assert.equal(out.url, 'https://honey-crumb.acme.workers.dev');
    assert.deepEqual(seen!.args.slice(0, 3), ['--yes', 'wrangler@4.158.0', 'deploy']);
    assert.deepEqual(seen!.config, { name: 'honey-crumb', compatibility_date: '2026-11-21', assets: { directory: dir, not_found_handling: 'single-page-application' } });
    assert.deepEqual([seen!.env.CLOUDFLARE_API_TOKEN, seen!.env.CLOUDFLARE_ACCOUNT_ID], ['cf-token', 'acc123']);
    await assert.rejects(deployCloudflare(dir, { token: 't', accountId: 'a', name: 'x', run: async (_c, _a, _e, onLine) => (onLine('Authentication error [code: 10000]'), 1) }, () => undefined), /exit code 1[\s\S]*Authentication error/);
  });
  it('makes host-safe names', () => {
    assert.equal(siteSlug('@acme/Honey & Crumb!'), 'honey-crumb');
    assert.equal(siteSlug('---'), 'my-site');
  });
});

describe('the wizard', () => {
  const info = (dir: string, framework: ProjectInfo['framework'] = 'vite'): ProjectInfo => ({ dir, name: 'honey-and-crumb', framework, packageManager: 'npm', devScript: 'dev', devScriptCommand: 'vite', needsInstall: false });

  it('lists the hosts, which are connected, and recommends the last one used', () => {
    const dir = tempDir();
    const cards = hostCards(info(dir), { VERCEL_TOKEN: 'x', CLOUDFLARE_API_TOKEN: 'y' });
    assert.deepEqual(cards.map((c) => [c.id, c.connected, c.recommended]), [['vercel', true, true], ['netlify', false, false], ['cloudflare', false, false]]);
    mkdirSync(path.join(dir, '.hivebubble'));
    writeFileSync(path.join(dir, '.hivebubble/deploy.json'), JSON.stringify({ last: { host: 'netlify', url: 'https://a.netlify.app', at: '' } }));
    const again = hostCards(info(dir), {});
    assert.deepEqual([again[1].recommended, again[1].lastUrl], [true, 'https://a.netlify.app']);
  });
  it('finds the environment variables the app reads, without reading their values', () => {
    const dir = tempDir({
      'src/db.js': 'const url = import.meta.env.VITE_SUPABASE_URL; const k = import.meta.env.VITE_STRIPE_KEY; const m = import.meta.env.MODE;',
      'src/api.ts': 'fetch(process.env.API_URL)',
      '.env': 'VITE_SUPABASE_URL=https://x.supabase.co\nEMPTY=\n',
    });
    assert.deepEqual(envNeeds(dir), [
      { name: 'API_URL', set: false, usedIn: ['src/api.ts'] },
      { name: 'VITE_STRIPE_KEY', set: false, usedIn: ['src/db.js'] },
      { name: 'VITE_SUPABASE_URL', set: true, usedIn: ['src/db.js'] },
    ]);
  });
  it('stops before building when the account is not connected, or the project is not Vite', async () => {
    const events: DeployEvent[] = [];
    await assert.rejects(deploySite(info(tempDir()), 'vercel', (e) => events.push(e), { env: {}, signal: new AbortController().signal }));
    assert.equal(events.at(-1)?.phase, 'failed');
    await assert.rejects(deploySite(info(tempDir(), 'next'), 'vercel', (e) => events.push(e), { env: { VERCEL_TOKEN: 'x' }, signal: new AbortController().signal }), /Vite projects/);
  });

  const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/vite-react');
  it('builds the real example with Vite and puts it online, end to end', { skip: !existsSync(path.join(example, 'node_modules/.bin/vite')) && 'the example is not installed' }, async () => {
    const copy = tempDir();
    for (const f of ['index.html', 'package.json', 'vite.config.js', 'src/App.jsx', 'src/App.css', 'src/main.jsx', 'src/components/Hero.jsx', 'src/components/Menu.jsx']) {
      mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
      writeFileSync(path.join(copy, f), readFileSync(path.join(example, f)));
    }
    const { symlinkSync } = await import('node:fs');
    symlinkSync(path.join(example, 'node_modules'), path.join(copy, 'node_modules'));
    const session = new Session({
      cwd: copy, project: { name: 'honey-and-crumb', framework: 'Vite' }, agent: 'mock', log: () => undefined,
      info: info(copy), deploy: { env: { VERCEL_TOKEN: 'good-token' }, pollMs: 5 },
    });
    const events: ServerEvent[] = [];
    session.attach({ readyState: 1, OPEN: 1, send: (d: string) => events.push(JSON.parse(d)), on: () => undefined } as never);
    await session.handle({ type: 'deploy-info' });
    const card = (events.find((e) => e.type === 'deploy-info') as Extract<ServerEvent, { type: 'deploy-info' }>);
    assert.deepEqual([card.supported, card.hosts.find((h) => h.recommended)?.id], [true, 'vercel']);
    vercel.uploads.clear();
    await session.handle({ type: 'deploy', host: 'vercel' });
    const steps = events.filter((e): e is DeployEvent => e.type === 'deploy');
    const live = steps.at(-1)!;
    assert.equal(live.phase, 'live', live.message);
    assert.equal(live.url, 'https://honey-and-crumb.vercel.app');
    assert.match(live.qrSvg ?? '', /^<svg/);
    assert.ok(steps.some((s) => s.phase === 'build' && /Built \d+ files/.test(s.message)));
    assert.ok([...vercel.uploads.values()].some((b) => b.toString().includes('<div id="root">')), 'the built index.html was uploaded');
    assert.deepEqual(readDeployState(copy).last?.url, 'https://honey-and-crumb.vercel.app');
    assert.ok(events.some((e) => e.type === 'status' && e.state === 'working') && events.at(-1)?.type === 'status');
  });
});
