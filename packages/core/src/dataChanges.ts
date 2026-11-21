import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { begin, DataError, findTable, friendlyDbError, localTimeZone, q, qualified, tableName, withClient, type Schema, type Table } from './db.js';
import { projectDataDir, readJson, writeJson } from './home.js';
import { checkSqlFragment, ident } from './sqlScan.js';

/**
 * Safe changes to someone's data (README §10). Claude only describes a change
 * (which table, which rows, what to set); Hivebubble turns it into a preview,
 * saves a backup of exactly those rows, applies it in one transaction if the
 * rows still look like the preview, and can put them back.
 */

export interface ChangePlan {
  action: 'update' | 'delete' | 'insert';
  /** schema.table */
  table: string;
  /** An SQL condition for the rows to change (update, delete). */
  where: string;
  /** update: new values; insert: the new row. Values are SQL expressions. */
  set: Array<{ column: string; value: string }>;
  /** In words, e.g. "Give Priya the pro plan". */
  summary: string;
}

type Cell = string | null;

export interface Proposal {
  id: string;
  plan: ChangePlan;
  question?: string;
  table: Table;
  /** update: the changed columns; delete: every visible column; insert: the columns being set. */
  columns: string[];
  /** update: a column people recognise rows by (a name or an email), shown instead of the key. */
  label: string | null;
  rows: Array<{ key: Cell[]; label?: Cell; before: Cell[] | null; after: Cell[] | null }>;
  /** A word to type before a bulk delete goes ahead. */
  needsWord: string | null;
  createdAt: number;
}

/** What the bubble shows: no hidden columns. */
export interface ProposalView {
  id: string;
  summary: string;
  table: string;
  action: ChangePlan['action'];
  count: number;
  key: string[];
  columns: string[];
  label: string | null;
  rows: Array<{ key: Cell[]; label?: Cell; before: Cell[] | null; after: Cell[] | null }>;
  needsWord: string | null;
  backupNote: string;
}

/** Columns people recognise a row by, best first. */
const LABEL_COLUMNS = ['full_name', 'name', 'display_name', 'username', 'email', 'title'];

export interface Backup {
  version: 1;
  id: string;
  at: string;
  summary: string;
  question?: string;
  table: string;
  action: ChangePlan['action'];
  key: string[];
  /** Every column the backup holds, with its type for casts. */
  columns: Array<{ name: string; type: string }>;
  /** update: key + the changed columns before and after; delete: whole rows before; insert: whole rows after. */
  rows: Array<{ key: Cell[]; before: Cell[] | null; after: Cell[] | null }>;
  state: 'applied' | 'undone';
  undoneAt?: string;
}

export interface ChangeItem {
  id: string;
  at: string;
  summary: string;
  table: string;
  action: ChangePlan['action'];
  count: number;
  state: Backup['state'];
  undoneAt?: string;
}

export const MAX_CHANGE_ROWS = 1000;

const keyOf = (key: Cell[]) => JSON.stringify(key);
const same = (a: Cell[] | null, b: Cell[] | null) => JSON.stringify(a) === JSON.stringify(b);

/** `(k1, k2) IN (rows from text arrays $first…)`, with each key cast to its type. */
function keyMatch(table: Table, first: number, alias = ''): string {
  const types = new Map(table.columns.map((c) => [c.name, c.type]));
  const cols = table.primaryKey.map((k) => `${alias}${ident(k)}`).join(', ');
  const params = table.primaryKey.map((_, i) => `$${first + i}::text[]`).join(', ');
  const names = table.primaryKey.map((_, i) => `k${i}`).join(', ');
  const casts = table.primaryKey.map((k, i) => `u.k${i}::${types.get(k)}`).join(', ');
  return `(${cols}) IN (SELECT ${casts} FROM unnest(${params}) AS u(${names}))`;
}

/** The key values of these rows as one text array per key column. */
const keyArrays = (table: Table, rows: Array<{ key: Cell[] }>) => table.primaryKey.map((_, i) => rows.map((r) => r.key[i]));

function typeOf(table: Table, column: string): string {
  const col = table.columns.find((c) => c.name === column);
  if (!col) throw new DataError(`${tableName(table)} has no column called ${column}.`);
  return col.type;
}

/** Checks a plan against the schema. Throws a DataError that says what's wrong. */
export function checkPlan(schema: Schema, plan: ChangePlan): Table {
  const table = findTable(schema, plan.table);
  if (!table) throw new DataError(`There’s no table called ${plan.table}.`);
  const name = tableName(table);
  if (table.kind !== 'table') throw new DataError(`${name} is a view, so its rows can’t be changed here.`);
  if (!table.primaryKey.length) throw new DataError(`${name} has no primary key, so Hivebubble couldn’t back up exactly these rows or undo the change. Give the table a primary key first.`);
  if (plan.action === 'delete' && table.dependents.length) {
    throw new DataError(`Deleting rows from ${name} would also delete or change rows in ${[...new Set(table.dependents.map((d) => d.table))].join(', ')}, which Undo couldn’t put back. If you’re sure, do it in your database’s own dashboard.`);
  }
  const seen = new Set<string>();
  for (const s of plan.set) {
    const col = table.columns.find((c) => c.name === s.column);
    if (!col) throw new DataError(`${name} has no column called ${s.column}.`);
    if (seen.has(s.column)) throw new DataError(`The change sets ${s.column} twice.`);
    seen.add(s.column);
    if (col.hidden) throw new DataError('Hivebubble doesn’t change passwords, tokens or secrets.');
    if (col.generated) throw new DataError(`${s.column} is worked out by the database, so it can’t be set.`);
    if (plan.action === 'update' && table.primaryKey.includes(s.column)) throw new DataError(`Hivebubble doesn’t change ${s.column}, because that’s how rows are found.`);
    const bad = checkSqlFragment(s.value, `new value for ${s.column}`);
    if (bad) throw new DataError(bad);
  }
  if (plan.action !== 'delete' && plan.set.length === 0) throw new DataError(plan.action === 'insert' ? 'The new row has no values.' : 'The change doesn’t say what to set.');
  if (plan.action !== 'insert') {
    if (!plan.where.trim()) throw new DataError('The change doesn’t say which rows it’s for.');
    const bad = checkSqlFragment(plan.where, 'condition');
    if (bad) throw new DataError(bad);
  }
  if (plan.action === 'insert') {
    const missing = table.columns.filter((c) => c.notNull && !c.hasDefault && !c.generated && !seen.has(c.name));
    if (missing.length) throw new DataError(`A new row in ${name} needs ${missing.map((c) => c.name).join(', ')}.`);
  }
  return table;
}

/**
 * The preview: which rows match and what each would look like, read in a
 * READ ONLY transaction. New values are worked out now and applied exactly
 * as shown.
 */
export async function prepareChange(url: string, schema: Schema, plan: ChangePlan, opts: { question?: string; timeZone?: string } = {}): Promise<Proposal> {
  const table = checkPlan(schema, plan);
  const key = table.primaryKey;
  const where = `(\n${plan.where}\n)`;
  const cast = (s: { column: string; value: string }) => `((\n${s.value}\n)::${typeOf(table, s.column)})::text`;
  const keySel = key.map((k) => `${ident(k)}::text`);
  const order = key.map(ident).join(', ');
  const label =
    plan.action === 'update'
      ? (LABEL_COLUMNS.find((n) => table.columns.some((c) => c.name === n && !c.hidden) && !key.includes(n) && !plan.set.some((s) => s.column === n)) ?? null)
      : null;
  const make = (columns: string[], rows: Proposal['rows']): Proposal => ({
    id: randomBytes(6).toString('hex'),
    plan,
    question: opts.question,
    table,
    columns,
    label,
    rows,
    needsWord: plan.action === 'delete' && rows.length > 1 ? 'delete' : null,
    createdAt: Date.now(),
  });
  return withClient(url, async (client) => {
    try {
      await begin(client, 'read', opts.timeZone ?? localTimeZone(), 15_000);
      if (plan.action === 'insert') {
        const res = await q(client, `SELECT ${plan.set.map(cast).join(', ')}`);
        return make(plan.set.map((s) => s.column), [{ key: [], before: null, after: res.rows[0] }]);
      }
      const count = Number((await q(client, `SELECT count(*) FROM ${qualified(table)} WHERE ${where}`)).rows[0][0]);
      if (count === 0) throw new DataError('No rows match, so nothing would change.');
      if (count > MAX_CHANGE_ROWS) throw new DataError(`That would change ${count.toLocaleString('en-US')} rows. Hivebubble changes at most ${MAX_CHANGE_ROWS.toLocaleString('en-US')} at a time, so it can back them all up.`);
      const n = key.length;
      if (plan.action === 'update') {
        const m = plan.set.length;
        const l = label ? 1 : 0;
        const labelSel = label ? [`${ident(label)}::text`] : [];
        const res = await q(client, `SELECT ${[...keySel, ...labelSel, ...plan.set.map((s) => `${ident(s.column)}::text`), ...plan.set.map(cast)].join(', ')} FROM ${qualified(table)} WHERE ${where} ORDER BY ${order}`);
        const rows = res.rows
          .map((r) => ({ key: r.slice(0, n), ...(label ? { label: r[n] } : {}), before: r.slice(n + l, n + l + m), after: r.slice(n + l + m) }))
          .filter((r) => !same(r.before, r.after));
        if (!rows.length) throw new DataError(count === 1 ? 'That row already looks like this, so nothing would change.' : 'Those rows already look like this, so nothing would change.');
        return make(plan.set.map((s) => s.column), rows);
      }
      // Generated columns come back by themselves when a row is put back, so they aren't shown or kept.
      const visible = table.columns.filter((c) => !c.hidden && !c.generated).map((c) => c.name);
      const res = await q(client, `SELECT ${[...keySel, ...visible.map((c) => `${ident(c)}::text`)].join(', ')} FROM ${qualified(table)} WHERE ${where} ORDER BY ${order}`);
      return make(visible, res.rows.map((r) => ({ key: r.slice(0, n), before: r.slice(n), after: null })));
    } catch (err) {
      throw friendlyDbError(err, url);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  });
}

export function proposalView(p: Proposal): ProposalView {
  const name = tableName(p.table);
  return {
    id: p.id,
    summary: p.plan.summary,
    table: name,
    action: p.plan.action,
    count: p.rows.length,
    key: p.table.primaryKey,
    columns: p.columns,
    label: p.label,
    rows: p.rows.slice(0, 200),
    needsWord: p.needsWord,
    backupNote:
      p.plan.action === 'insert'
        ? 'Hivebubble notes the new row first, so Undo can take it out again.'
        : `Hivebubble saves a backup of ${p.rows.length === 1 ? 'this row' : `these ${p.rows.length} rows`} first, so Undo can put ${p.rows.length === 1 ? 'it' : 'them'} back.`,
  };
}

export const backupsDir = (projectDir: string) => projectDataDir(projectDir, 'data', 'backups');
const backupFile = (dir: string, id: string) => {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new DataError('That change isn’t in the backups.');
  return path.join(dir, `${id}.json`);
};

/**
 * Applies a previewed change in one transaction: locks the rows, checks they
 * still look like the preview, writes the backup, changes them, and checks
 * the database changed exactly that many rows.
 */
export async function applyChange(url: string, p: Proposal, opts: { dir: string; word?: string; timeZone?: string }): Promise<ChangeItem> {
  if (p.needsWord && (opts.word ?? '').trim().toLowerCase() !== p.needsWord) throw new DataError(`Type “${p.needsWord}” to confirm deleting ${p.rows.length} rows.`);
  const table = p.table;
  const key = table.primaryKey;
  const n = key.length;
  const file = backupFile(opts.dir, p.id);
  const backup: Backup = {
    version: 1,
    id: p.id,
    at: new Date().toISOString(),
    summary: p.plan.summary,
    question: p.question,
    table: tableName(table),
    action: p.plan.action,
    key,
    columns: [],
    rows: [],
    state: 'applied',
  };
  const stale = new DataError('Some of these rows changed since the preview, so nothing was changed. Ask again to see them as they are now.');
  await withClient(url, async (client) => {
    let wrote = false;
    try {
      await begin(client, 'write', opts.timeZone ?? localTimeZone(), 30_000);
      if (p.plan.action === 'update') {
        const changed = p.columns;
        backup.columns = changed.map((c) => ({ name: c, type: typeOf(table, c) }));
        const keys = keyArrays(table, p.rows);
        const now = await q(client, `SELECT ${[...key, ...changed].map((c) => `${ident(c)}::text`).join(', ')} FROM ${qualified(table)} WHERE ${keyMatch(table, 1)} FOR UPDATE`, keys);
        const current = new Map(now.rows.map((r) => [keyOf(r.slice(0, n)), r.slice(n)]));
        if (current.size !== p.rows.length || p.rows.some((r) => !same(current.get(keyOf(r.key)) ?? null, r.before))) throw stale;
        const m = changed.length;
        const sets = changed.map((c, j) => `${ident(c)} = u.v${j}::${typeOf(table, c)}`).join(', ');
        const join = key.map((k, i) => `t.${ident(k)} = u.k${i}::${typeOf(table, k)}`).join(' AND ');
        const params = [...keys, ...changed.map((_, j) => p.rows.map((r) => r.after![j]))];
        const unnest = `unnest(${params.map((_, i) => `$${i + 1}::text[]`).join(', ')}) AS u(${[...key.map((_, i) => `k${i}`), ...changed.map((_, j) => `v${j}`)].join(', ')})`;
        const res = await q(client, `UPDATE ${qualified(table)} AS t SET ${sets} FROM ${unnest} WHERE ${join} RETURNING ${[...key, ...changed].map((c) => `t.${ident(c)}::text`).join(', ')}`, params);
        if (res.rowCount !== p.rows.length) throw new DataError(`The database changed ${res.rowCount} rows instead of ${p.rows.length}, so Hivebubble put everything back.`);
        const after = new Map(res.rows.map((r) => [keyOf(r.slice(0, n)), r.slice(n, n + m)]));
        backup.rows = p.rows.map((r) => ({ key: r.key, before: r.before, after: after.get(keyOf(r.key)) ?? r.after }));
      } else if (p.plan.action === 'delete') {
        const all = table.columns.filter((c) => !c.generated);
        backup.columns = all.map((c) => ({ name: c.name, type: c.type }));
        const keys = keyArrays(table, p.rows);
        const now = await q(client, `SELECT ${[...key, ...all.map((c) => c.name)].map((c) => `${ident(c)}::text`).join(', ')} FROM ${qualified(table)} WHERE ${keyMatch(table, 1)} FOR UPDATE`, keys);
        const visibleIdx = p.columns.map((c) => all.findIndex((a) => a.name === c));
        const current = new Map(now.rows.map((r) => [keyOf(r.slice(0, n)), r.slice(n)]));
        const looksSame = (r: Proposal['rows'][number]) => {
          const row = current.get(keyOf(r.key));
          return row !== undefined && same(visibleIdx.map((i) => (i === -1 ? null : row[i])), r.before);
        };
        if (current.size !== p.rows.length || !p.rows.every(looksSame)) throw stale;
        backup.rows = p.rows.map((r) => ({ key: r.key, before: current.get(keyOf(r.key))!, after: null }));
        const res = await q(client, `DELETE FROM ${qualified(table)} WHERE ${keyMatch(table, 1)}`, keys);
        if (res.rowCount !== p.rows.length) throw new DataError(`The database deleted ${res.rowCount} rows instead of ${p.rows.length}, so Hivebubble put everything back.`);
      } else {
        const all = table.columns.filter((c) => !c.generated);
        backup.columns = all.map((c) => ({ name: c.name, type: c.type }));
        const values = p.rows[0].after!;
        const res = await q(
          client,
          `INSERT INTO ${qualified(table)} (${p.columns.map(ident).join(', ')}) VALUES (${p.columns.map((c, i) => `$${i + 1}::text::${typeOf(table, c)}`).join(', ')}) RETURNING ${[...key, ...all.map((c) => c.name)].map((c) => `${ident(c)}::text`).join(', ')}`,
          values,
        );
        backup.rows = res.rows.map((r) => ({ key: r.slice(0, n), before: null, after: r.slice(n) }));
      }
      // The backup is on disk before the change is.
      writeJson(file, backup);
      wrote = true;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (wrote) rmSync(file, { force: true });
      throw friendlyDbError(err, url);
    }
  });
  return itemOf(backup);
}

function itemOf(b: Backup): ChangeItem {
  return { id: b.id, at: b.at, summary: b.summary, table: b.table, action: b.action, count: b.rows.length, state: b.state, undoneAt: b.undoneAt };
}

export function listChanges(dir: string, limit = 50): ChangeItem[] {
  if (!existsSync(dir)) return [];
  const items: ChangeItem[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^[a-f0-9]{12}\.json$/.test(f)) continue;
    const b = readJson<Backup | null>(path.join(dir, f), null);
    if (b && b.version === 1) items.push(itemOf(b));
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export type UndoResult = { ok: true; item: ChangeItem } | { ok: false; conflict: number; message: string; canForce: boolean };

/**
 * Puts a change back from its backup. If the rows changed again since,
 * nothing happens unless `force` (then the backup wins for the rows that
 * can be put back).
 */
export async function undoChange(url: string, schema: Schema, opts: { dir: string; id: string; force?: boolean; timeZone?: string }): Promise<UndoResult> {
  const file = backupFile(opts.dir, opts.id);
  const backup = readJson<Backup | null>(file, null);
  if (!backup || backup.version !== 1) throw new DataError('That change isn’t in the backups.');
  if (backup.state === 'undone') throw new DataError('That change was already undone.');
  const table = findTable(schema, backup.table);
  if (!table) throw new DataError(`The table ${backup.table} isn’t in the database any more.`);
  const n = backup.key.length;
  if (backup.key.join() !== table.primaryKey.join()) throw new DataError(`The primary key of ${backup.table} changed since, so Hivebubble can’t match the rows safely.`);
  let result = null as UndoResult | null;
  await withClient(url, async (client) => {
    try {
      await begin(client, 'write', opts.timeZone ?? localTimeZone(), 30_000);
      const keys = keyArrays(table, backup.rows);
      if (backup.action === 'update') {
        const cols = backup.columns.map((c) => c.name);
        const now = await q(client, `SELECT ${[...backup.key, ...cols].map((c) => `${ident(c)}::text`).join(', ')} FROM ${qualified(table)} WHERE ${keyMatch(table, 1)} FOR UPDATE`, keys);
        const current = new Map(now.rows.map((r) => [keyOf(r.slice(0, n)), r.slice(n)]));
        const conflicts = backup.rows.filter((r) => !same(current.get(keyOf(r.key)) ?? null, r.after)).length;
        if (conflicts && !opts.force) {
          result = { ok: false, conflict: conflicts, canForce: true, message: `${conflicts === 1 ? 'One row was' : `${conflicts} rows were`} changed again after this. Undo anyway, and put back the values from before?` };
          return;
        }
        const present = backup.rows.filter((r) => current.has(keyOf(r.key)));
        if (present.length) {
          const sets = backup.columns.map((c, j) => `${ident(c.name)} = u.v${j}::${c.type}`).join(', ');
          const join = backup.key.map((k, i) => `t.${ident(k)} = u.k${i}::${typeOf(table, k)}`).join(' AND ');
          const params = [...keyArrays(table, present), ...backup.columns.map((_, j) => present.map((r) => r.before![j]))];
          const unnest = `unnest(${params.map((_, i) => `$${i + 1}::text[]`).join(', ')}) AS u(${[...backup.key.map((_, i) => `k${i}`), ...backup.columns.map((_, j) => `v${j}`)].join(', ')})`;
          await q(client, `UPDATE ${qualified(table)} AS t SET ${sets} FROM ${unnest} WHERE ${join}`, params);
        }
      } else if (backup.action === 'delete') {
        const now = await q(client, `SELECT ${backup.key.map((c) => `${ident(c)}::text`).join(', ')} FROM ${qualified(table)} WHERE ${keyMatch(table, 1)} FOR UPDATE`, keys);
        const taken = new Set(now.rows.map((r) => keyOf(r)));
        if (taken.size && !opts.force) {
          result = { ok: false, conflict: taken.size, canForce: true, message: `${taken.size === 1 ? 'A row with the same key is' : `${taken.size} rows with the same keys are`} back in the table. Put back the others?` };
          return;
        }
        const missing = backup.rows.filter((r) => !taken.has(keyOf(r.key)));
        if (missing.length) {
          const params = backup.columns.map((_, j) => missing.map((r) => r.before![j]));
          await q(
            client,
            `INSERT INTO ${qualified(table)} (${backup.columns.map((c) => ident(c.name)).join(', ')}) OVERRIDING SYSTEM VALUE SELECT ${backup.columns.map((c, j) => `u.c${j}::${c.type}`).join(', ')} FROM unnest(${params.map((_, i) => `$${i + 1}::text[]`).join(', ')}) AS u(${backup.columns.map((_, j) => `c${j}`).join(', ')})`,
            params,
          );
        }
      } else {
        const cols = backup.columns.map((c) => c.name);
        const now = await q(client, `SELECT ${[...backup.key, ...cols].map((c) => `${ident(c)}::text`).join(', ')} FROM ${qualified(table)} WHERE ${keyMatch(table, 1)} FOR UPDATE`, keys);
        const current = new Map(now.rows.map((r) => [keyOf(r.slice(0, n)), r.slice(n)]));
        const conflicts = backup.rows.filter((r) => !same(current.get(keyOf(r.key)) ?? null, r.after)).length;
        if (conflicts && !opts.force) {
          result = { ok: false, conflict: conflicts, canForce: true, message: 'The new row was changed after it was added. Take it out anyway?' };
          return;
        }
        const present = backup.rows.filter((r) => current.has(keyOf(r.key)));
        if (present.length && (await pointedAt(client, table, present))) {
          result = { ok: false, conflict: present.length, canForce: false, message: `Other rows now point at the new row (in ${[...new Set(table.dependents.map((d) => d.table))].join(', ')}), and taking it out would remove or change them too. If you’re sure, remove it in your database’s own dashboard.` };
          return;
        }
        if (present.length) await q(client, `DELETE FROM ${qualified(table)} WHERE ${keyMatch(table, 1)}`, keyArrays(table, present));
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw friendlyDbError(err, url);
    } finally {
      if (result) await client.query('ROLLBACK').catch(() => undefined);
    }
  });
  if (result) return result;
  backup.state = 'undone';
  backup.undoneAt = new Date().toISOString();
  writeJson(file, backup);
  return { ok: true, item: itemOf(backup) };
}

/** True when rows in other tables reference these rows through a cascading foreign key. */
async function pointedAt(client: pg.Client, table: Table, rows: Array<{ key: Cell[] }>): Promise<boolean> {
  for (const dep of table.dependents) {
    const [schema, name] = dep.table.split('.', 2);
    // The referenced columns' values for these rows, read from the table itself.
    const refCols = dep.pairs.map((p) => ident(p.refColumn)).join(', ');
    const fkCols = dep.pairs.map((p) => ident(p.column)).join(', ');
    const res = await q(
      client,
      `SELECT EXISTS (SELECT 1 FROM ${ident(schema)}.${ident(name)} WHERE (${fkCols}) IN (SELECT ${refCols} FROM ${qualified(table)} WHERE ${keyMatch(table, 1)}))::text`,
      keyArrays(table, rows),
    );
    if (res.rows[0]?.[0] === 'true') return true;
  }
  return false;
}
