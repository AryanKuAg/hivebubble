import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { SpendLedger } from './cost.js';
import { askPrompt, demoAsker, fillHeadline, type AskInput, type Asker, type DataAnswer } from './dataAsk.js';
import { applyChange, backupsDir, listChanges, prepareChange, undoChange, type ChangePlan } from './dataChanges.js';
import { clientConfig, DataError, describeDatabase, findDatabase, loadSchema, runReadOnly, schemaText, type Schema } from './db.js';
import { DevErrorCatcher, ErrorLog, authActivity, codeLocation, groupErrors, plainEnglish } from './logs.js';
import { Session } from './session.js';
import { checkReadSql, checkSqlFragment } from './sqlScan.js';
import type { ServerEvent } from './types.js';

const PRIYA = '11111111-1111-1111-1111-111111111111';
const SAM = '22222222-2222-2222-2222-222222222222';
const ANA = '33333333-3333-3333-3333-333333333333';

const SETUP = `
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  phone text,
  encrypted_password text,
  confirmation_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz
);
CREATE TABLE auth.audit_log_entries (instance_id uuid, id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payload json, created_at timestamptz DEFAULT now(), ip_address varchar(64) NOT NULL DEFAULT '');
CREATE TABLE auth.identities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  name_upper text GENERATED ALWAYS AS (upper(full_name)) STORED
);
CREATE TABLE public.orders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES public.profiles(id),
  total numeric(10,2) NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.events (kind text, at timestamptz DEFAULT now());
CREATE TABLE public.newsletter (email text PRIMARY KEY, created_at timestamptz DEFAULT now());
CREATE VIEW public.pro_users AS SELECT id, full_name FROM public.profiles WHERE plan = 'pro';
CREATE TABLE public.big AS SELECT g AS id, 0 AS n FROM generate_series(1, 1001) g;
ALTER TABLE public.big ADD PRIMARY KEY (id);

INSERT INTO auth.users (id, email, phone, encrypted_password, confirmation_token, created_at, last_sign_in_at) VALUES
  ('${PRIYA}', 'priya@example.com', '+44 7700 900123', '$2a$10$secret1', 'tok-1', now() - interval '2 days', now() - interval '1 day'),
  ('${SAM}', 'sam@example.com', NULL, '$2a$10$secret2', '', now() - interval '3 days', NULL),
  ('${ANA}', 'ana@example.com', NULL, '$2a$10$secret3', '', now() - interval '40 days', now() - interval '20 days'),
  ('44444444-4444-4444-4444-444444444444', 'old@example.com', NULL, 'x', '', now() - interval '90 days', NULL);
INSERT INTO public.profiles (id, full_name, plan, created_at) VALUES
  ('${PRIYA}', 'Priya Shah', 'free', now() - interval '2 days'),
  ('${SAM}', 'Sam Lee', 'free', now() - interval '3 days'),
  ('${ANA}', 'Ana Ruiz', 'pro', now() - interval '40 days');
INSERT INTO public.orders (profile_id, total, note) VALUES ('${PRIYA}', 12.50, 'Sourdough'), ('${PRIYA}', 6.00, NULL), ('${ANA}', 8.00, 'Rye');
INSERT INTO auth.audit_log_entries (payload, created_at) VALUES
  ('{"action":"user_signedup","actor_username":"priya@example.com"}', now() - interval '2 days'),
  ('{"action":"user_signedup","actor_username":"sam@example.com"}', now() - interval '3 days'),
  ('{"action":"login","actor_username":"priya@example.com"}', now() - interval '1 day'),
  ('{"action":"token_refreshed","actor_username":"priya@example.com"}', now() - interval '1 hour');
INSERT INTO public.newsletter (email) VALUES ('a@news.test'), ('b@news.test'), ('c@news.test');
INSERT INTO public.events (kind) VALUES ('visit');
`;

let db: PGlite;
let server: PGLiteSocketServer;
let url = '';
let schema: Schema;
const tz = 'UTC';
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'hivebubble-m6-'));
  dirs.push(d);
  return d;
};
const one = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows[0];

before(async () => {
  db = await PGlite.create();
  await db.exec(SETUP);
  server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 50 });
  await server.start();
  url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
  schema = await loadSchema(url);
});

after(async () => {
  await server?.stop();
  await db?.close();
});

describe('finding and describing the database', () => {
  it('prefers the saved connection, then the project’s own DATABASE_URL, by name only', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://u:p@db.example.com:5432/app\nSECRET=x\n');
    writeFileSync(path.join(dir, '.env.local'), 'DATABASE_URL=mysql://nope\nPOSTGRES_URL="postgresql://u:p@pg.example.com/main"\n');
    assert.deepEqual(findDatabase(dir, {}), { url: 'postgresql://u:p@pg.example.com/main', from: 'POSTGRES_URL in .env.local' });
    assert.deepEqual(findDatabase(dir, { HIVEBUBBLE_DATABASE_URL: 'postgres://me@saved.example.com/x' })?.from, 'Hivebubble’s settings');
    assert.equal(findDatabase(tempDir(), {}), null);
    assert.equal(process.env.SECRET, undefined, 'project files are never loaded into the environment');
  });

  it('names the database without its password, and follows sslmode like psql', () => {
    const supa = 'postgresql://postgres.abcd:s3cret@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require';
    assert.deepEqual(describeDatabase(supa), { kind: 'Supabase', host: 'aws-0-eu-west-2.pooler.supabase.com', database: 'postgres' });
    assert.doesNotMatch(JSON.stringify(describeDatabase(supa)), /s3cret/);
    const c = clientConfig(supa);
    assert.deepEqual(c.ssl, { rejectUnauthorized: false });
    assert.doesNotMatch(String(c.connectionString), /sslmode/);
    assert.equal(clientConfig('postgres://u@localhost/app').ssl, false);
    assert.deepEqual(clientConfig('postgres://u@db.example.com/app').ssl, { rejectUnauthorized: false });
    assert.deepEqual(clientConfig('postgres://u@db.example.com/app?sslmode=verify-full').ssl, { rejectUnauthorized: true });
    assert.equal(clientConfig('postgres://u@db.example.com/app?sslmode=disable').ssl, false);
  });
});

describe('the SQL checks', () => {
  it('lets one reading query through', () => {
    for (const sql of ['SELECT 1', 'with x as (select 1) select * from x', "select ';' as semi", 'select $$;$$', 'SELECT 1;', 'select 1 -- ; drop table x', "select E'\\'; drop table x'", 'TABLE public.profiles']) {
      assert.equal(checkReadSql(sql), null, sql);
    }
  });

  it('stops anything else before it reaches the database', () => {
    const cases: Array<[string, RegExp]> = [
      ['SELECT 1; DROP TABLE x', /one query/],
      ['DELETE FROM x', /only read/],
      ['select pg_sleep(10)', /pg_sleep/],
      ['select pg_catalog.pg_terminate_backend(1)', /pg_terminate_backend/],
      ['select * into t2 from t', /INTO/],
      ["select 'unterminated", /never ends/],
      ['select (1', /brackets/],
      ['', /no query/],
    ];
    for (const [sql, why] of cases) assert.match(checkReadSql(sql) ?? 'allowed', why, sql);
  });

  it('accepts only single expressions inside a change', () => {
    for (const ok of ["lower(email) = lower('priya@example.com')", "'pro'", 'now()', '(select 1)', "'a;b'"]) assert.equal(checkSqlFragment(ok, 'condition'), null, ok);
    for (const bad of ['1=1; drop table x', '1=1) or (1=1', 'pg_sleep(1) is null', '1=1 /* x', "'abc"]) assert.notEqual(checkSqlFragment(bad, 'condition'), null, bad);
  });
});

describe('reading the database', () => {
  it('reads the schema: tables, keys, links, and keeps secrets out of what Claude sees', () => {
    const names = schema.tables.map((t) => `${t.schema}.${t.name}`);
    for (const n of ['public.profiles', 'public.orders', 'public.pro_users', 'auth.users']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('auth.audit_log_entries') && !names.includes('auth.identities'), 'Supabase’s own tables stay out');
    const users = schema.tables.find((t) => t.name === 'users')!;
    assert.deepEqual(users.columns.filter((c) => c.hidden).map((c) => c.name), ['encrypted_password', 'confirmation_token']);
    assert.deepEqual(users.dependents.map((d) => d.table).sort(), ['auth.identities', 'public.profiles']);
    const text = schemaText(schema);
    assert.match(text, /public\.profiles: id uuid \(primary key, → auth\.users\.id\), full_name text/);
    assert.match(text, /public\.pro_users \[view\]/);
    assert.doesNotMatch(text, /encrypted_password|confirmation_token|priya|Priya/);
  });

  it('answers a question as exact text, in the person’s time zone', async () => {
    const r = await runReadOnly(url, "SELECT full_name, plan FROM public.profiles ORDER BY full_name", { timeZone: tz });
    assert.deepEqual(r.columns, [{ name: 'full_name', kind: 'text' }, { name: 'plan', kind: 'text' }]);
    assert.deepEqual(r.rows, [['Ana Ruiz', 'pro'], ['Priya Shah', 'free'], ['Sam Lee', 'free']]);
    const t = await runReadOnly(url, "SELECT '2026-11-20 10:00:00+00'::timestamptz AS at, 12.5::numeric(10,2) AS total", { timeZone: 'Asia/Kolkata' });
    assert.deepEqual(t.rows, [['2026-11-20 15:30:00+05:30', '12.50']]);
    assert.deepEqual(t.columns.map((c) => c.kind), ['time', 'number']);
  });

  it('never shows passwords or tokens, and stops at the row limit', async () => {
    const r = await runReadOnly(url, 'SELECT email, encrypted_password, confirmation_token FROM auth.users ORDER BY email LIMIT 1', { timeZone: tz });
    assert.deepEqual(r.rows, [['ana@example.com', 'hidden', 'hidden']]);
    const many = await runReadOnly(url, 'SELECT generate_series(1, 20) AS n', { limit: 5, timeZone: tz });
    assert.equal(many.rows.length, 5);
    assert.equal(many.truncated, true);
  });

  it('can’t write, even through a WITH that deletes', async () => {
    await assert.rejects(runReadOnly(url, 'WITH gone AS (DELETE FROM public.newsletter RETURNING *) SELECT count(*) FROM gone', { timeZone: tz }), /questions only read/);
    assert.equal((await one('SELECT count(*)::int AS n FROM public.newsletter')).n, 3);
    await assert.rejects(runReadOnly(url, 'SELECT nope FROM public.profiles', { timeZone: tz }), /isn’t in the database/);
  });
});

describe('changing data safely', () => {
  const plan = (p: Partial<ChangePlan>): ChangePlan => ({ action: 'update', table: 'public.profiles', where: '', set: [], summary: 'A change', ...p });
  const givePriyaPro = plan({ where: "lower(full_name) = lower('priya shah')", set: [{ column: 'plan', value: "'pro'" }], summary: 'Give Priya Shah the pro plan' });
  const planOf = async (id: string) => (await one(`SELECT plan FROM public.profiles WHERE id = '${id}'`)).plan;

  it('previews, backs up, applies and undoes an update', async () => {
    const dir = backupsDir(tempDir());
    const p = await prepareChange(url, schema, givePriyaPro, { question: 'give priya pro', timeZone: tz });
    assert.deepEqual(p.rows, [{ key: [PRIYA], label: 'Priya Shah', before: ['free'], after: ['pro'] }]);
    assert.equal(p.label, 'full_name', 'rows are shown by a name people know, not the key');
    assert.equal(p.needsWord, null);
    assert.equal(await planOf(PRIYA), 'free', 'the preview changes nothing');
    const item = await applyChange(url, p, { dir, timeZone: tz });
    assert.deepEqual([item.state, item.count, item.table], ['applied', 1, 'public.profiles']);
    assert.equal(await planOf(PRIYA), 'pro');
    assert.ok(existsSync(path.join(dir, `${p.id}.json`)), 'the backup is on disk');
    assert.deepEqual(listChanges(dir).map((c) => c.summary), ['Give Priya Shah the pro plan']);
    const undone = await undoChange(url, await loadSchema(url), { dir, id: p.id, timeZone: tz });
    assert.equal(undone.ok, true);
    assert.equal(await planOf(PRIYA), 'free');
    assert.equal(listChanges(dir)[0].state, 'undone');
    await assert.rejects(undoChange(url, schema, { dir, id: p.id, timeZone: tz }), /already undone/);
  });

  it('changes nothing if the rows changed since the preview', async () => {
    const dir = backupsDir(tempDir());
    const p = await prepareChange(url, schema, givePriyaPro, { timeZone: tz });
    await db.query(`UPDATE public.profiles SET plan = 'team' WHERE id = '${PRIYA}'`);
    await assert.rejects(applyChange(url, p, { dir, timeZone: tz }), /changed since the preview/);
    assert.equal(await planOf(PRIYA), 'team');
    assert.deepEqual(readdirSync(dir), [], 'no backup for a change that didn’t happen');
    await db.query(`UPDATE public.profiles SET plan = 'free' WHERE id = '${PRIYA}'`);
  });

  it('asks before undoing over later edits, and can undo anyway', async () => {
    const dir = backupsDir(tempDir());
    const p = await prepareChange(url, schema, givePriyaPro, { timeZone: tz });
    await applyChange(url, p, { dir, timeZone: tz });
    await db.query(`UPDATE public.profiles SET plan = 'team' WHERE id = '${PRIYA}'`);
    const first = await undoChange(url, schema, { dir, id: p.id, timeZone: tz });
    assert.equal(first.ok, false);
    assert.equal(first.ok === false && first.canForce, true);
    assert.equal(await planOf(PRIYA), 'team', 'nothing happens without a yes');
    assert.equal((await undoChange(url, schema, { dir, id: p.id, force: true, timeZone: tz })).ok, true);
    assert.equal(await planOf(PRIYA), 'free');
  });

  it('needs a typed word for a bulk delete, and puts every row back exactly', async () => {
    const dir = backupsDir(tempDir());
    const before = (await db.query<{ email: string; created_at: string }>('SELECT email, created_at::text FROM public.newsletter ORDER BY email')).rows;
    const p = await prepareChange(url, schema, plan({ action: 'delete', table: 'newsletter', where: "email LIKE '%@news.test'", summary: 'Remove the test sign-ups' }), { timeZone: tz });
    assert.equal(p.rows.length, 3);
    assert.equal(p.needsWord, 'delete');
    await assert.rejects(applyChange(url, p, { dir, timeZone: tz }), /Type “delete”/);
    await assert.rejects(applyChange(url, p, { dir, word: 'yes', timeZone: tz }), /Type “delete”/);
    await applyChange(url, p, { dir, word: ' Delete ', timeZone: tz });
    assert.equal((await one('SELECT count(*)::int AS n FROM public.newsletter')).n, 0);
    assert.equal((await undoChange(url, schema, { dir, id: p.id, timeZone: tz })).ok, true);
    assert.deepEqual((await db.query('SELECT email, created_at::text FROM public.newsletter ORDER BY email')).rows, before);
  });

  it('puts back rows with identity and generated columns', async () => {
    const dir = backupsDir(tempDir());
    const order = await one("SELECT id, total::text FROM public.orders WHERE note = 'Rye'");
    const p = await prepareChange(url, schema, plan({ action: 'delete', table: 'public.orders', where: `id = ${order.id}` }), { timeZone: tz });
    assert.equal(p.needsWord, null, 'one row needs no typed word');
    await applyChange(url, p, { dir, timeZone: tz });
    assert.equal((await undoChange(url, schema, { dir, id: p.id, timeZone: tz })).ok, true);
    assert.deepEqual(await one("SELECT id, total::text FROM public.orders WHERE note = 'Rye'"), order);

    const sam = await prepareChange(url, schema, plan({ action: 'delete', where: "full_name = 'Sam Lee'" }), { timeZone: tz });
    assert.ok(!sam.columns.includes('name_upper'), 'generated columns aren’t kept: the database works them out again');
    await applyChange(url, sam, { dir, timeZone: tz });
    await undoChange(url, schema, { dir, id: sam.id, timeZone: tz });
    assert.deepEqual(await one(`SELECT full_name, name_upper FROM public.profiles WHERE id = '${SAM}'`), { full_name: 'Sam Lee', name_upper: 'SAM LEE' });
  });

  it('adds a row and takes it out again', async () => {
    const dir = backupsDir(tempDir());
    const p = await prepareChange(url, schema, plan({ action: 'insert', table: 'public.newsletter', set: [{ column: 'email', value: "'new@news.test'" }] }), { timeZone: tz });
    assert.deepEqual(p.rows[0].after, ['new@news.test']);
    await applyChange(url, p, { dir, timeZone: tz });
    assert.equal((await one("SELECT count(*)::int AS n FROM public.newsletter WHERE email = 'new@news.test'")).n, 1);
    await undoChange(url, schema, { dir, id: p.id, timeZone: tz });
    assert.equal((await one("SELECT count(*)::int AS n FROM public.newsletter WHERE email = 'new@news.test'")).n, 0);
  });

  it('refuses changes it couldn’t back up or undo', async () => {
    const tries: Array<[Partial<ChangePlan>, RegExp]> = [
      [{ action: 'delete', table: 'auth.users', where: "email = 'old@example.com'" }, /also delete or change rows in .*public\.profiles/],
      [{ table: 'public.events', where: 'true', set: [{ column: 'kind', value: "'x'" }] }, /no primary key/],
      [{ table: 'public.pro_users', where: 'true', set: [{ column: 'full_name', value: "'x'" }] }, /is a view/],
      [{ table: 'auth.users', where: 'true', set: [{ column: 'encrypted_password', value: "'x'" }] }, /passwords, tokens or secrets/],
      [{ where: 'true', set: [{ column: 'id', value: 'gen_random_uuid()' }] }, /how rows are found/],
      [{ where: "1=1); DROP TABLE public.orders; --", set: [{ column: 'plan', value: "'pro'" }] }, /single expression|brackets/],
      [{ where: "full_name = 'Nobody'", set: [{ column: 'plan', value: "'pro'" }] }, /No rows match/],
      [{ where: "full_name = 'Ana Ruiz'", set: [{ column: 'plan', value: "'pro'" }] }, /already looks like this/],
      [{ table: 'public.big', where: 'true', set: [{ column: 'n', value: '1' }] }, /at most 1,000/],
      [{ table: 'public.nope', where: 'true', set: [{ column: 'n', value: '1' }] }, /no table called/],
      [{ action: 'insert', table: 'public.orders', set: [{ column: 'note', value: "'x'" }] }, /needs profile_id, total/],
    ];
    for (const [p, why] of tries) await assert.rejects(prepareChange(url, schema, plan(p), { timeZone: tz }), why, JSON.stringify(p));
    assert.equal((await one('SELECT count(*)::int AS n FROM public.orders')).n, 3, 'nothing was dropped');
  });
});

describe('logs', () => {
  it('keeps errors once per burst and reads them back', () => {
    const dir = tempDir();
    const log = new ErrorLog(dir);
    log.add('page', 'Boom');
    log.add('page', 'Boom');
    log.add('dev', '\x1b[31mError: red\x1b[0m');
    assert.deepEqual(log.read().map((e) => [e.source, e.message]), [['page', 'Boom'], ['dev', 'Error: red']]);
  });

  it('turns the dev server’s error block into one entry, linked to the file', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src/App.jsx'), 'export default 1\n');
    const log = new ErrorLog(dir);
    const catcher = new DevErrorCatcher(log);
    for (const line of [
      '2:30:46 AM [vite] Internal server error: Failed to resolve import "./Nope" from "src/App.jsx". Does the file exist?',
      '  Plugin: vite:import-analysis',
      `  File: ${dir}/src/App.jsx:3:17`,
      '',
      '  VITE v8.3.8  ready in 257 ms',
    ]) catcher.line(line);
    catcher.flush();
    const entries = log.read();
    assert.equal(entries.length, 1);
    assert.match(entries[0].detail ?? '', /Plugin: vite:import-analysis/);
    const [g] = groupErrors(entries, dir);
    assert.deepEqual([g.file, g.line], ['src/App.jsx', 3]);
    assert.match(g.plain, /imports “\.\/Nope”, which can’t be found/);
  });

  it('groups the same page error and finds its file in the stack', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'src/components'), { recursive: true });
    writeFileSync(path.join(dir, 'src/components/Menu.jsx'), 'export default 1\n');
    const entries = [1, 2].map((i) => ({
      at: `2026-11-21T0${i}:00:00.000Z`,
      source: 'page' as const,
      message: "Cannot read properties of undefined (reading 'map')",
      detail: `TypeError: Cannot read properties of undefined (reading 'map')\n    at Menu (http://localhost:4321/src/components/Menu.jsx?t=17000${i}:12:15)\n    at renderWithHooks (http://localhost:4321/node_modules/.vite/deps/react-dom.js:1:1)`,
    }));
    const [g, ...rest] = groupErrors(entries, dir);
    assert.equal(rest.length, 0);
    assert.deepEqual([g.count, g.file, g.line, g.last], [2, 'src/components/Menu.jsx', 12, '2026-11-21T02:00:00.000Z']);
    assert.match(g.plain, /use “map” on something that wasn’t there/);
    assert.equal(codeLocation('at x (http://localhost:4321/node_modules/react/index.js:1:1)', dir), null);
    assert.match(plainEnglish('page', 'ReferenceError: bakeBread is not defined'), /“bakeBread”, but nothing by that name/);
  });

  it('summarises sign-ups and sign-ins from Supabase Auth', async () => {
    const a = await authActivity(url, tz);
    assert.ok(a);
    assert.deepEqual(a.users, { total: 4, today: 0, week: 2 });
    assert.deepEqual(a.actions.map((x) => [x.label, x.count]), [['Signed up', 2], ['Signed in', 1]]);
    assert.equal(a.recent.length, 3, 'token refreshes are left out');
    assert.match(a.recent[0].at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(a.recent[0].who, 'priya@example.com');
  });
});

describe('Users & Data in the bubble', () => {
  function session(opts: { asker?: Asker; env?: NodeJS.ProcessEnv; agent?: 'claude' | 'mock' } = {}) {
    const dir = tempDir();
    const events: ServerEvent[] = [];
    const s = new Session({
      cwd: dir,
      project: { name: 'bakery', framework: 'Vite' },
      agent: opts.agent ?? 'claude',
      log: () => undefined,
      ledger: new SpendLedger(path.join(dir, 'spend.json')),
      data: { asker: opts.asker, env: opts.env ?? { HIVEBUBBLE_DATABASE_URL: url }, timeZone: tz },
    });
    s.attach({ readyState: 1, OPEN: 1, send: (d: string) => events.push(JSON.parse(d)), on: () => undefined } as never);
    const last = <T extends ServerEvent['type']>(type: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type).at(-1);
    return { s, dir, events, last };
  }

  it('says which database is connected', async () => {
    const { s, last } = session();
    await s.handle({ type: 'data-info' });
    const info = last('data-info')!;
    assert.deepEqual([info.connected, info.db?.kind, info.from, info.canAsk, info.app], [true, 'Postgres', 'Hivebubble’s settings', true, false]);
    assert.ok((info.tables ?? 0) >= 6);
    const none = session({ env: {} });
    await none.s.handle({ type: 'data-info' });
    assert.equal(none.last('data-info')!.connected, false);
    await none.s.handle({ type: 'data-ask', question: 'how many users?' });
    assert.match(none.last('data-error')!.message, /Connect a database first/);
  });

  it('asks Claude with the question and table shapes only, and shows the answer', async () => {
    const seen: AskInput[] = [];
    const asker: Asker = async (input) => {
      seen.push(input);
      const answer: DataAnswer = { kind: 'read', sql: "SELECT u.email, p.full_name FROM auth.users u JOIN public.profiles p ON p.id = u.id WHERE u.created_at >= now() - interval '7 days' ORDER BY u.created_at DESC", headline: '{count} people signed up this week', explanation: 'Looked at accounts made in the last 7 days.' };
      return { answer, costUsd: 0.012 };
    };
    const { s, last } = session({ asker });
    await s.handle({ type: 'data-ask', question: 'Who signed up this week?' });
    const result = last('data-result')!;
    assert.equal(result.headline, '2 people signed up this week');
    assert.deepEqual(result.table.rows, [['priya@example.com', 'Priya Shah'], ['sam@example.com', 'Sam Lee']]);
    assert.equal(result.costUsd, 0.012);
    const prompt = askPrompt(seen[0]);
    assert.match(prompt, /public\.profiles: id uuid/);
    assert.match(prompt, /Who signed up this week\?/);
    assert.doesNotMatch(prompt, /priya@example\.com|Priya Shah|secret|tok-1/, 'no rows ever go to Claude');
    assert.equal(seen[0].timeZone, tz);
  });

  it('previews a change, makes it on a yes, and undoes it from the Changes list', async () => {
    const asker: Asker = async () => ({ answer: { kind: 'change', explanation: 'Matched Priya by name.', plan: { action: 'update', table: 'public.profiles', where: "full_name ILIKE 'priya%'", set: [{ column: 'plan', value: "'pro'" }], summary: 'Give Priya the pro plan' } }, costUsd: 0 });
    const { s, last, dir } = session({ asker });
    await s.handle({ type: 'data-ask', question: 'Give Priya pro access' });
    const { proposal } = last('data-proposal')!;
    assert.deepEqual([proposal.count, proposal.rows[0].before, proposal.rows[0].after, proposal.needsWord], [1, ['free'], ['pro'], null]);
    assert.match(proposal.backupNote, /backup of this row/);
    await s.handle({ type: 'data-apply', id: proposal.id });
    assert.equal(last('data-applied')!.change.summary, 'Give Priya the pro plan');
    assert.equal((await one(`SELECT plan FROM public.profiles WHERE id = '${PRIYA}'`)).plan, 'pro');
    await s.handle({ type: 'data-apply', id: proposal.id });
    assert.match(last('data-error')!.message, /too old/, 'a preview is used once');
    await s.handle({ type: 'data-changes' });
    assert.equal(last('data-changes')!.changes[0].state, 'applied');
    await s.handle({ type: 'data-undo', id: proposal.id });
    assert.equal(last('data-undo-result')!.ok, true);
    assert.equal((await one(`SELECT plan FROM public.profiles WHERE id = '${PRIYA}'`)).plan, 'free');
    assert.equal(listChanges(backupsDir(dir))[0].state, 'undone');
  });

  it('records what Claude cost, says when it can’t tell, and only reads from typed SQL', async () => {
    const asker: Asker = async () => ({ answer: { kind: 'unclear', reply: 'Which table holds your bookings?' }, costUsd: 0.004 });
    const { s, last, events } = session({ asker });
    await s.handle({ type: 'data-ask', question: 'how are bookings going' });
    assert.equal(last('data-reply')!.text, 'Which table holds your bookings?');
    assert.equal(last('spend')!.spend.todayUsd, 0.004);
    await s.handle({ type: 'data-run', sql: 'DELETE FROM public.orders' });
    assert.match(last('data-error')!.message, /only read/);
    await s.handle({ type: 'data-run', sql: 'SELECT count(*) AS n FROM public.orders' });
    assert.equal(last('data-result')!.table.rows[0][0], '3');
    assert.ok(events.some((e) => e.type === 'data-working'));
  });

  it('answers a few questions in demo mode without Claude', async () => {
    const { s, last } = session({ agent: 'mock' });
    await s.handle({ type: 'data-ask', question: 'How many users are there?' });
    assert.equal(last('data-result')!.headline, '4 users in total');
    await s.handle({ type: 'data-ask', question: 'Who signed up this week?' });
    assert.equal(last('data-result')!.headline, '2 signed up in the last 7 days');
    await s.handle({ type: 'data-ask', question: 'Give Sam pro' });
    assert.match(last('data-reply')!.text, /only reads/);
  });

  it('logs page errors and summarises them with sign-in activity', async () => {
    const { s, last } = session();
    await s.handle({ type: 'page-error', message: 'Uncaught TypeError: x is not a function', source: 'http://localhost:4321/src/main.jsx:3:1' });
    await s.handle({ type: 'data-logs' });
    const logs = last('data-logs')!;
    assert.equal(logs.groups.length, 1);
    assert.match(logs.groups[0].plain, /calls “x” as if it were a function/);
    assert.equal(logs.auth?.users?.total, 4);
  });

  it('fills headlines from what came back', () => {
    const r = (rows: string[][], truncated = false) => ({ columns: rows[0]?.map((_, i) => ({ name: `c${i}`, kind: 'text' as const })) ?? [], rows, truncated, ms: 1 });
    assert.equal(fillHeadline('{value} orders today', r([['7']])), '7 orders today');
    assert.equal(fillHeadline('{count} people', r([['a'], ['b']], true)), '2+ people');
    assert.equal(fillHeadline('{value} orders', r([['a', 'b']])), 'Here’s the answer.');
    assert.ok(demoAsker(() => schema));
    assert.ok(DataError);
  });
});

after(() => {
  // Temp folders are small; leave them for the OS, but never leave a test server running.
  void dirs;
});
