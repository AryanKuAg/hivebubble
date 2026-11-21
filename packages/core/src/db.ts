import path from 'node:path';
import pg from 'pg';
import { readEnvFile } from './env.js';
import { checkReadSql, ident, stripTrailingSemicolons } from './sqlScan.js';

/**
 * The person's database (README §10): Supabase or any Postgres. Hivebubble
 * reads it only inside READ ONLY transactions; changes go through
 * dataChanges.ts, with a preview, a backup and Undo.
 */

export interface DbSource {
  url: string;
  /** Where the connection string came from, in words. */
  from: string;
}

export interface DbLabel {
  kind: 'Supabase' | 'Postgres';
  host: string;
  database: string;
}

const PROJECT_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_DB_URL'];
const PROJECT_FILES = ['.env.local', '.env.development.local', '.env', '.env.development'];
const isPostgresUrl = (v: string | undefined): v is string => Boolean(v && /^postgres(?:ql)?:\/\/\S+$/.test(v.trim()));

/**
 * The connection string to use: the one saved in Hivebubble (the Mac app
 * passes it from the Keychain), else the project's own DATABASE_URL. Project
 * files are read for these names only and never loaded into the environment.
 */
export function findDatabase(projectDir: string, env: NodeJS.ProcessEnv = process.env): DbSource | null {
  const own = env.HIVEBUBBLE_DATABASE_URL?.trim();
  if (isPostgresUrl(own)) return { url: own, from: 'Hivebubble’s settings' };
  for (const file of PROJECT_FILES) {
    const vars = readEnvFile(path.join(projectDir, file));
    for (const key of PROJECT_KEYS) if (isPostgresUrl(vars[key])) return { url: vars[key].trim(), from: `${key} in ${file}` };
  }
  return null;
}

/** What to call the database on screen. Never includes the password. */
export function describeDatabase(url: string): DbLabel {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return {
    kind: /(?:^|\.)supabase\.(?:co|com)$/.test(host) ? 'Supabase' : 'Postgres',
    host,
    database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Client settings that follow the connection string's sslmode the way psql
 * does: "require" (what Supabase hands out) encrypts without checking the
 * certificate, "verify-full" checks it, "disable" turns TLS off. Without
 * one, remote databases get TLS and local ones don't.
 */
export function clientConfig(url: string): pg.ClientConfig {
  const u = new URL(url);
  const mode = u.searchParams.get('sslmode') ?? (u.searchParams.get('ssl') === 'true' ? 'require' : null);
  for (const k of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'uselibpqcompat']) u.searchParams.delete(k);
  const local = LOCAL_HOSTS.has(u.hostname);
  let ssl: pg.ClientConfig['ssl'];
  if (mode === 'disable' || (mode === null && local)) ssl = false;
  else if (mode === 'verify-full' || mode === 'verify-ca') ssl = { rejectUnauthorized: true };
  else ssl = { rejectUnauthorized: false };
  // query_timeout: a stalled network can't leave a request waiting forever (the server's own limit is statement_timeout).
  return { connectionString: u.toString(), ssl, connectionTimeoutMillis: 10_000, query_timeout: 60_000, application_name: 'hivebubble' };
}

/** An error to show as it is: it's already in plain words. */
export class DataError extends Error {}

/** Database errors in plain words. */
export function friendlyDbError(err: unknown, url?: string): DataError {
  if (err instanceof DataError) return err;
  const e = err as { code?: string; message?: string };
  const where = url ? describeDatabase(url).host : 'the database';
  const message = String(e?.message ?? err);
  // A WITH that writes is refused before the read-only check even runs.
  const code = /data-modifying statements/.test(message) ? '25006' : e?.code;
  switch (code) {
    case 'ECONNREFUSED':
      return new DataError(`Couldn’t reach the database at ${where}. Is it running?`);
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new DataError(`Couldn’t find the database server ${where}. Check the connection string, or your internet connection.`);
    case 'ETIMEDOUT':
      return new DataError(`The database at ${where} didn’t answer in time.`);
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return new DataError('The database’s certificate couldn’t be checked. With sslmode=require in the connection string, the connection is encrypted without checking it.');
    case '28P01':
      return new DataError('The database refused the password in the connection string.');
    case '28000':
      return new DataError(`The database refused this user: ${message}`);
    case '3D000':
      return new DataError(`That database doesn’t exist: ${message}`);
    case '25006':
      return new DataError('That would change data, and questions only read. Ask for the change in words instead, and Hivebubble shows you what it would do first.');
    case '57014':
      return new DataError('That took too long, so Hivebubble stopped it.');
    case '42P01':
    case '42703':
    case '42883':
      return new DataError(`The query used something that isn’t in the database: ${message}`);
    case '42501':
      return new DataError(`This database user isn’t allowed to do that: ${message}`);
    case '23505':
      return new DataError(`Another row already has that value, so the database said no: ${message}`);
    case '23503':
      return new DataError(`Other rows point at these, so the database said no: ${message}`);
    case '23502':
    case '23514':
    case '22P02':
    case '22007':
    case '22008':
      return new DataError(`The database didn’t accept a value: ${message}`);
  }
  if (/timeout expired|Connection terminated due to connection timeout/i.test(message)) return new DataError(`The database at ${where} didn’t answer within 10 seconds.`);
  if (/password authentication failed/i.test(message)) return new DataError('The database refused the password in the connection string.');
  return new DataError(`The database said: ${message}`);
}

/** Runs fn with a fresh connection, always closed after. */
export async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(clientConfig(url));
  // A dropped connection must never take the engine down.
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => undefined);
    throw friendlyDbError(err, url);
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Every value comes back as PostgreSQL's own text: no time-zone or big-number surprises. */
const AS_TEXT = { getTypeParser: () => (value: string) => value } as unknown as pg.CustomTypesConfig;

/**
 * One statement through the extended protocol, which refuses a second
 * statement outright, with values as text.
 */
export async function q(client: pg.Client, text: string, values: unknown[] = []): Promise<pg.QueryArrayResult<Array<string | null>>> {
  const config = { text, values, rowMode: 'array', types: AS_TEXT, queryMode: 'extended' };
  return client.query(config as unknown as pg.QueryArrayConfig<unknown[]>) as Promise<pg.QueryArrayResult<Array<string | null>>>;
}

/** Opens a transaction in the person's time zone, so "today" means their today. */
export async function begin(client: pg.Client, mode: 'read' | 'write', timeZone: string, timeoutMs: number): Promise<void> {
  await client.query(mode === 'read' ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
  await q(client, 'SELECT set_config($1, $2, true), set_config($3, $4, true)', ['statement_timeout', String(Math.round(timeoutMs)), 'TimeZone', timeZone]);
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// ---- schema -------------------------------------------------------------------------

export interface Column {
  name: string;
  /** As format_type() writes it, so it can be used in a cast. */
  type: string;
  notNull: boolean;
  /** GENERATED ALWAYS AS (…) STORED: can't be written. */
  generated: boolean;
  hasDefault: boolean;
  /** Passwords, tokens and secrets: never shown, never sent to Claude. */
  hidden: boolean;
}

/** A foreign key in another table that deletes or rewrites its rows when a row here goes (CASCADE, SET NULL, SET DEFAULT). */
export interface Dependent {
  table: string;
  constraint: string;
  pairs: Array<{ column: string; refColumn: string }>;
}

export interface Table {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: Column[];
  primaryKey: string[];
  references: Array<{ column: string; table: string; refColumn: string }>;
  dependents: Dependent[];
}

export interface Schema {
  tables: Table[];
}

/** Supabase's own schemas. auth.users is the exception: it's where the users are. */
const INTERNAL_SCHEMAS = new Set([
  'auth', 'storage', 'realtime', '_realtime', 'extensions', 'graphql', 'graphql_public', 'net', 'pgsodium', 'pgsodium_masks', 'vault',
  'supabase_functions', 'supabase_migrations', '_analytics', 'cron', 'pgbouncer', 'pgtle', 'information_schema', 'pg_catalog', 'pg_toast',
]);
const KEPT_INTERNAL = new Set(['auth.users']);

const HIDDEN_COLUMN = /(?:^|_)(?:password|passwd|secret|token|api_?key|private_?key|salt)(?:_(?:new|current|hash|digest|encrypted))?$|(?:^|_)(?:encrypted|hashed)_\w+$|_hash$/i;
export const isHiddenColumn = (name: string) => HIDDEN_COLUMN.test(name);

export const tableName = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`;
export const qualified = (t: { schema: string; name: string }) => `${ident(t.schema)}.${ident(t.name)}`;

export async function readSchema(client: pg.Client): Promise<Schema> {
  const cols = await q(
    client,
    `SELECT n.nspname, c.relname, c.relkind::text, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull::text,
            (a.attgenerated <> '')::text, (a.atthasdef OR a.attidentity <> '')::text
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
        AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
        AND has_table_privilege(c.oid, 'SELECT')
      ORDER BY n.nspname, c.relname, a.attnum`,
  );
  const tables = new Map<string, Table>();
  for (const [schema, name, kind, col, type, notNull, generated, hasDefault] of cols.rows as string[][]) {
    const key = `${schema}.${name}`;
    if (INTERNAL_SCHEMAS.has(schema) && !KEPT_INTERNAL.has(key)) continue;
    let t = tables.get(key);
    if (!t) {
      t = { schema, name, kind: kind === 'r' || kind === 'p' ? 'table' : 'view', columns: [], primaryKey: [], references: [], dependents: [] };
      tables.set(key, t);
    }
    t.columns.push({ name: col, type, notNull: notNull === 'true', generated: generated === 'true', hasDefault: hasDefault === 'true', hidden: isHiddenColumn(col) });
  }
  const pks = await q(
    client,
    `SELECT n.nspname, c.relname, a.attname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary
      ORDER BY n.nspname, c.relname, array_position(i.indkey::int2[], a.attnum)`,
  );
  for (const [schema, name, col] of pks.rows as string[][]) tables.get(`${schema}.${name}`)?.primaryKey.push(col);
  const fks = await q(
    client,
    `SELECT cn.nspname, cl.relname, a.attname, rn.nspname, rl.relname, ra.attname, con.confdeltype::text, con.conname
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace cn ON cn.oid = cl.relnamespace
       JOIN pg_class rl ON rl.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rl.relnamespace
       JOIN LATERAL unnest(con.conkey, con.confkey) AS k(col, refcol) ON true
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col
       JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refcol
      WHERE con.contype = 'f'`,
  );
  for (const [schema, name, col, refSchema, refName, refCol, onDelete, constraint] of fks.rows as string[][]) {
    tables.get(`${schema}.${name}`)?.references.push({ column: col, table: `${refSchema}.${refName}`, refColumn: refCol });
    const target = tables.get(`${refSchema}.${refName}`);
    // c = cascade, n = set null, d = set default: deleting a row there changes rows here.
    if (!target || !['c', 'n', 'd'].includes(onDelete)) continue;
    const from = `${schema}.${name}`;
    let dep = target.dependents.find((d) => d.table === from && d.constraint === constraint);
    if (!dep) target.dependents.push((dep = { table: from, constraint, pairs: [] }));
    dep.pairs.push({ column: col, refColumn: refCol });
  }
  return { tables: [...tables.values()] };
}

/**
 * The schema as Claude sees it: table and column names and types, keys and
 * links. No rows, and no hidden columns.
 */
export function schemaText(schema: Schema, maxTables = 150): string {
  const lines = schema.tables.slice(0, maxTables).map((t) => {
    const cols = t.columns
      .filter((c) => !c.hidden)
      .map((c) => {
        const ref = t.references.find((r) => r.column === c.name);
        const marks = [t.primaryKey.includes(c.name) && t.primaryKey.length === 1 ? 'primary key' : '', ref ? `→ ${ref.table}.${ref.refColumn}` : '', c.generated ? 'generated' : '']
          .filter(Boolean)
          .join(', ');
        return `${c.name} ${c.type}${marks ? ` (${marks})` : ''}`;
      });
    const pk = t.primaryKey.length > 1 ? `; primary key (${t.primaryKey.join(', ')})` : '';
    return `${tableName(t)}${t.kind === 'view' ? ' [view]' : ''}: ${cols.join(', ')}${pk}`;
  });
  if (schema.tables.length > maxTables) lines.push(`(and ${schema.tables.length - maxTables} more tables)`);
  return lines.join('\n');
}

export function findTable(schema: Schema, name: string): Table | undefined {
  const clean = name.replace(/"/g, '').trim();
  const [a, b] = clean.includes('.') ? clean.split('.', 2) : ['', clean];
  return (
    schema.tables.find((t) => t.schema === a && t.name === b) ??
    (a ? undefined : (schema.tables.find((t) => t.schema === 'public' && t.name === b) ?? schema.tables.find((t) => t.name === b)))
  );
}

// ---- questions ------------------------------------------------------------------------

export type ColumnKind = 'number' | 'date' | 'time' | 'bool' | 'json' | 'text';

export interface ReadResult {
  columns: Array<{ name: string; kind: ColumnKind }>;
  rows: Array<Array<string | null>>;
  truncated: boolean;
  ms: number;
}

const KIND_BY_OID: Record<number, ColumnKind> = {
  20: 'number', 21: 'number', 23: 'number', 26: 'number', 700: 'number', 701: 'number', 790: 'number', 1700: 'number',
  16: 'bool', 1082: 'date', 1114: 'time', 1184: 'time', 114: 'json', 3802: 'json',
};

const MAX_CELL = 400;

/**
 * Runs one query that only reads, in a READ ONLY transaction, through a
 * cursor so the SQL runs exactly as written while only the first rows come
 * back. Hidden columns come back as "hidden".
 */
export async function runReadOnly(url: string, sql: string, opts: { limit?: number; timeoutMs?: number; timeZone?: string } = {}): Promise<ReadResult> {
  const problem = checkReadSql(sql);
  if (problem) throw new DataError(problem);
  const limit = opts.limit ?? 500;
  return withClient(url, async (client) => {
    const started = Date.now();
    try {
      await begin(client, 'read', opts.timeZone ?? localTimeZone(), opts.timeoutMs ?? 15_000);
      await q(client, `DECLARE hivebubble_question NO SCROLL CURSOR FOR\n${stripTrailingSemicolons(sql)}\n`);
      const res = await q(client, `FETCH FORWARD ${limit + 1} FROM hivebubble_question`);
      const hidden = res.fields.map((f) => isHiddenColumn(f.name));
      const rows = res.rows.slice(0, limit).map((row) =>
        row.map((v, i) => (v === null ? null : hidden[i] ? 'hidden' : v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : v)),
      );
      return {
        columns: res.fields.map((f) => ({ name: f.name, kind: KIND_BY_OID[f.dataTypeID] ?? 'text' })),
        rows,
        truncated: res.rows.length > limit,
        ms: Date.now() - started,
      };
    } catch (err) {
      throw friendlyDbError(err, url);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  });
}

/** Reads the schema in a read-only transaction. */
export async function loadSchema(url: string): Promise<Schema> {
  return withClient(url, async (client) => {
    try {
      await begin(client, 'read', 'UTC', 15_000);
      return await readSchema(client);
    } catch (err) {
      throw friendlyDbError(err, url);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  });
}
