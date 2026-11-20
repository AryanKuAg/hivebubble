import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { begin, friendlyDbError, q, withClient } from './db.js';
import { projectDataDir } from './home.js';

/**
 * The logs summary (README §10): errors from the page, the dev server and
 * production builds, kept in .hivebubble/logs, grouped, said in plain words
 * and linked to the file that caused them; plus sign-in activity from a
 * Supabase database.
 */

export type ErrorSource = 'page' | 'dev' | 'deploy';

export interface LoggedError {
  at: string;
  source: ErrorSource;
  message: string;
  detail?: string;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const clean = (s: string) => s.replace(ANSI, '').trim();
const MAX_BYTES = 512 * 1024;

export class ErrorLog {
  private readonly recent = new Map<string, number>();
  constructor(private readonly projectDir: string) {}

  private file(): string {
    return path.join(projectDataDir(this.projectDir, 'logs'), 'errors.jsonl');
  }

  /** Records an error. The same one within 10 seconds is recorded once. Never throws. */
  add(source: ErrorSource, message: string, detail?: string): void {
    const msg = clean(message).slice(0, 1000);
    if (!msg) return;
    const key = `${source}\n${msg}`;
    const now = Date.now();
    if ((this.recent.get(key) ?? 0) > now - 10_000) return;
    if (this.recent.size > 500) this.recent.clear();
    this.recent.set(key, now);
    const entry: LoggedError = { at: new Date(now).toISOString(), source, message: msg };
    const extra = detail ? clean(detail).slice(0, 4000) : '';
    if (extra) entry.detail = extra;
    try {
      const file = this.file();
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
      }
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch {
      // Logging must never get in the way.
    }
  }

  read(limit = 2000): LoggedError[] {
    const file = path.join(this.projectDir, '.hivebubble', 'logs', 'errors.jsonl');
    if (!existsSync(file)) return [];
    const out: LoggedError[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n').slice(-limit)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LoggedError;
        if (e && typeof e.message === 'string' && typeof e.at === 'string') out.push(e);
      } catch {
        // A half-written line: skip it.
      }
    }
    return out;
  }
}

const DEV_ERROR = /\b(?:error|failed to|cannot find module|unexpected token|exception)\b/i;
const NOT_ERROR = /\b0 errors?\b|\bno errors?\b|\berrors?: 0\b/i;

/**
 * Picks errors out of the dev server's output. An error line and the lines
 * right after it (Vite's "File:", "Plugin:" and code frame) become one entry.
 */
export class DevErrorCatcher {
  private pending: { message: string; detail: string[] } | null = null;
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly log: ErrorLog) {}

  line(raw: string): void {
    const text = clean(raw);
    const isError = Boolean(text) && DEV_ERROR.test(text) && !NOT_ERROR.test(text);
    if (this.pending && text && !isError && this.pending.detail.length < 12) {
      this.pending.detail.push(text);
      this.arm();
      return;
    }
    if (this.pending) this.flush();
    if (isError) {
      this.pending = { message: text, detail: [] };
      this.arm();
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    if (p) this.log.add('dev', p.message, p.detail.join('\n'));
  }
}

export interface ErrorGroup {
  id: string;
  source: ErrorSource;
  message: string;
  plain: string;
  count: number;
  first: string;
  last: string;
  /** The project file it points at, relative, and the line (near it, for page errors). */
  file?: string;
  line?: number;
  detail?: string;
}

function normalize(message: string): string {
  return message
    .replace(/^\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?\s*/i, '')
    .replace(/https?:\/\/[^/\s]+/g, '')
    .replace(/\?t=\d+/g, '')
    .replace(/:\d+(?::\d+)?/g, ':N')
    .replace(/\b\d+\b/g, 'N')
    .slice(0, 300);
}

const LOCATION = /(?:https?:\/\/[^/\s)]+)?(\/[^\s:?()'"]+?\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|html))(?:\?[^\s:)]*)?:(\d+)(?::\d+)?/g;
const RELATIVE = /["'(\s]((?:src|app|pages|components|lib)\/[^\s"'():]+\.(?:[cm]?[jt]sx?|vue|svelte|astro|css))(?::(\d+))?/g;

/** The first place in the project an error points at. */
export function codeLocation(text: string, projectDir: string): { file: string; line?: number } | null {
  const root = path.resolve(projectDir);
  const inProject = (abs: string) => abs.startsWith(root + path.sep) && !abs.includes(`${path.sep}node_modules${path.sep}`) && !abs.includes(`${path.sep}.hivebubble${path.sep}`) && existsSync(abs);
  for (const m of text.matchAll(LOCATION)) {
    let p = m[1];
    if (p.startsWith('/@fs/')) p = p.slice(4);
    else if (p.startsWith('/@') || p.includes('/node_modules/')) continue;
    const abs = p.startsWith(root + '/') ? p : path.join(root, p);
    if (inProject(abs)) return { file: path.relative(root, abs).split(path.sep).join('/'), line: Number(m[2]) };
  }
  for (const m of text.matchAll(RELATIVE)) {
    const abs = path.join(root, m[1]);
    if (inProject(abs)) return { file: m[1], line: m[2] ? Number(m[2]) : undefined };
  }
  return null;
}

/** What the error means, for someone who doesn't read code. */
export function plainEnglish(source: ErrorSource, message: string): string {
  const m = message;
  let r: RegExpMatchArray | null;
  if ((r = m.match(/Cannot read propert(?:y|ies) of (undefined|null)(?: \(reading '([^']+)'\))?/))) {
    return `The page tried to use ${r[2] ? `“${r[2]}” on ` : ''}something that ${r[1] === 'null' ? 'was empty' : 'wasn’t there'}. Usually the data hadn’t loaded yet, or a name is misspelled.`;
  }
  if ((r = m.match(/(?:ReferenceError: )?([\w$]+) is not defined/))) return `The code uses “${r[1]}”, but nothing by that name exists there. It may be misspelled, or missing an import.`;
  if ((r = m.match(/([\w$.]+) is not a function/))) return `The code calls “${r[1]}” as if it were a function, but it isn’t one there.`;
  if ((r = m.match(/Failed to resolve import "([^"]+)"/))) return `A file imports “${r[1]}”, which can’t be found. The file may have moved, or a package isn’t installed.`;
  if (/Cannot find module|Module not found/i.test(m)) return 'The code needs a file or package that can’t be found.';
  if (/Unexpected token|SyntaxError|Transform failed|PARSE_ERROR|Expected .* but found/i.test(m)) return 'A file has a typo that stops the code from being read (a syntax error).';
  if (/Failed to fetch|NetworkError|ERR_CONNECTION_REFUSED|Load failed|ECONNREFUSED/i.test(m)) return 'The page couldn’t reach a server it asked for data. That server may be down, or the address is wrong.';
  if (/Objects are not valid as a React child/.test(m)) return 'The page tried to show a whole object as text.';
  if (/Maximum update depth exceeded|Too many re-renders/.test(m)) return 'Part of the page keeps updating itself in a loop.';
  if (/Hydration|did not match/i.test(m)) return 'The page looked different when it was first sent than after it loaded (a hydration mismatch).';
  if ((r = m.match(/\b(401|403|404|500|502|503)\b/))) {
    const what: Record<string, string> = { '401': 'needed a sign-in', '403': 'wasn’t allowed', '404': 'asked for something that doesn’t exist', '500': 'broke on the server', '502': 'got no answer from the server', '503': 'found the server unavailable' };
    return `A request ${what[r[1]]} (${r[1]}).`;
  }
  if (source === 'deploy' || /build failed/i.test(m)) return 'The production build failed, so the site couldn’t go online.';
  const first = clean(m).split('\n')[0].replace(/^\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?\s*/i, '').slice(0, 160);
  return `${source === 'page' ? 'The page' : source === 'dev' ? 'The dev server' : 'The build'} reported: ${first}`;
}

export function groupErrors(entries: LoggedError[], projectDir: string, limit = 50): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const e of entries) {
    const key = `${e.source}\n${normalize(e.message)}`;
    const g = groups.get(key);
    if (g) {
      g.count++;
      if (e.at < g.first) g.first = e.at;
      if (e.at >= g.last) {
        g.last = e.at;
        g.message = e.message;
        g.detail = e.detail;
      }
      continue;
    }
    groups.set(key, {
      id: createHash('sha1').update(key).digest('hex').slice(0, 10),
      source: e.source,
      message: e.message,
      plain: plainEnglish(e.source, e.message),
      count: 1,
      first: e.at,
      last: e.at,
      detail: e.detail,
    });
  }
  const list = [...groups.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, limit);
  for (const g of list) {
    const at = codeLocation(`${g.message}\n${g.detail ?? ''}`, projectDir);
    if (at) {
      g.file = at.file;
      g.line = at.line;
    }
  }
  return list;
}

// ---- sign-in activity (Supabase Auth) -----------------------------------------------

export interface AuthActivity {
  users: { total: number; today: number; week: number } | null;
  /** The last 7 days, by kind. */
  actions: Array<{ action: string; label: string; count: number }>;
  recent: Array<{ at: string; label: string; who: string }>;
}

const AUTH_ACTIONS: Record<string, string> = {
  user_signedup: 'Signed up',
  login: 'Signed in',
  logout: 'Signed out',
  user_invited: 'Was invited',
  user_deleted: 'Was deleted',
  user_modified: 'Changed their account',
  user_recovery_requested: 'Asked to reset their password',
  user_updated_password: 'Changed their password',
  user_confirmation_requested: 'Was sent a confirmation email',
  user_repeated_signup: 'Tried to sign up again',
  token_revoked: 'Was signed out everywhere',
  user_reauthenticate_requested: 'Was asked to sign in again',
};
const authLabel = (action: string) => AUTH_ACTIONS[action] ?? action.replace(/_/g, ' ');

/** Supabase keeps sign-ups and sign-ins in auth.audit_log_entries. Null for other databases. */
export async function authActivity(url: string, timeZone: string): Promise<AuthActivity | null> {
  return withClient(url, async (client) => {
    try {
      await begin(client, 'read', timeZone, 10_000);
      const has = await q(client, `SELECT (to_regclass('auth.audit_log_entries') IS NOT NULL)::text, (to_regclass('auth.users') IS NOT NULL)::text`);
      const [audit, users] = has.rows[0].map((v) => v === 'true');
      if (!audit && !users) return null;
      const out: AuthActivity = { users: null, actions: [], recent: [] };
      if (users) {
        const r = await q(
          client,
          `SELECT count(*)::text, (count(*) FILTER (WHERE created_at >= current_date))::text, (count(*) FILTER (WHERE created_at >= now() - interval '7 days'))::text FROM auth.users`,
        );
        const [total, today, week] = r.rows[0].map(Number);
        out.users = { total, today, week };
      }
      if (audit) {
        const counts = await q(
          client,
          `SELECT payload->>'action', count(*)::text FROM auth.audit_log_entries
            WHERE created_at >= now() - interval '7 days' AND coalesce(payload->>'action', '') NOT IN ('', 'token_refreshed')
            GROUP BY 1 ORDER BY count(*) DESC`,
        );
        out.actions = counts.rows.map(([action, n]) => ({ action: action ?? '', label: authLabel(action ?? ''), count: Number(n) }));
        const recent = await q(
          client,
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), payload->>'action', coalesce(payload->>'actor_username', '')
             FROM auth.audit_log_entries WHERE coalesce(payload->>'action', '') NOT IN ('', 'token_refreshed')
            ORDER BY created_at DESC LIMIT 12`,
        );
        out.recent = recent.rows.map(([at, action, who]) => ({ at: at ?? '', label: authLabel(action ?? ''), who: who ?? '' }));
      }
      return out;
    } catch (err) {
      throw friendlyDbError(err, url);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  });
}
