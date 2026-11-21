import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { usageCost } from './cost.js';
import type { ChangePlan } from './dataChanges.js';
import { DataError, type ReadResult, type Schema, type Table } from './db.js';
import { ident } from './sqlScan.js';

/**
 * Plain English to SQL (README §10). Claude gets the question and the shape of
 * the tables (names, types, keys), never any rows. A question becomes one
 * SELECT; a change becomes a plan that Hivebubble previews before anything
 * happens.
 */

export type DataAnswer =
  | { kind: 'read'; sql: string; headline: string; explanation: string }
  | { kind: 'change'; plan: ChangePlan; explanation: string }
  | { kind: 'unclear'; reply: string };

export interface AskInput {
  question: string;
  /** schemaText(): tables and columns, no data. */
  schema: string;
  /** e.g. "Saturday, 21 November 2026" */
  today: string;
  timeZone: string;
}

export type Asker = (input: AskInput, signal?: AbortSignal) => Promise<{ answer: DataAnswer; costUsd: number }>;

export const DATA_MODEL = 'claude-opus-5-5';

const SYSTEM = `You turn a person's request about their app's PostgreSQL database into SQL. You see the table definitions only, never the data, and the person can't read SQL, so your words must make sense without it.

Reading data (who, how many, which, list, show, find):
- kind "read". In "sql", one SELECT (or WITH … SELECT) that answers it, using only the tables and columns listed.
- Return readable columns (names, emails, dates) rather than ids, give computed columns short clear names, and order rows usefully. Add a LIMIT only if the person asks for a number of rows.
- The database session runs in the person's time zone, so current_date and now() are their local today and now.
- "headline": a short sentence that answers the question, with {count} standing for the number of rows returned, or {value} for the single value when the query returns one row with one column. For example "{count} people signed up this week" or "{value} orders today".
- "explanation": one plain sentence on what you looked at, e.g. "Counted the accounts in users created since Monday."

Changing data (give, set, mark, rename, add, remove, delete):
- kind "change", "sql" empty, and "change" filled in:
  - "table": the schema-qualified table, e.g. public.profiles.
  - "action": update, delete or insert.
  - "where": for update and delete, an SQL condition that matches exactly the rows meant, e.g. lower(email) = lower('priya@example.com'). Match people by email when given, otherwise by name, case-insensitively. Empty for insert.
  - "set": for update, each column to change with its new value as an SQL expression ('pro', true, now()); for insert, every value the new row needs.
  - "summary": the change in plain words, e.g. "Give Priya Shah the pro plan".
- Never change primary keys, passwords, tokens or secrets.
- "explanation": one plain sentence on how you picked the rows.

Anything else, or when you can't tell what's meant: kind "unclear", and "reply" says plainly what you need, or why it can't be done here (for example creating tables, deleting tables or changing permissions).

Fields that don't apply are empty strings, and "change" is null unless kind is "change".`;

const AnswerSchema = z.object({
  kind: z.enum(['read', 'change', 'unclear']),
  sql: z.string(),
  headline: z.string(),
  explanation: z.string(),
  change: z
    .object({
      table: z.string(),
      action: z.enum(['update', 'delete', 'insert']),
      where: z.string(),
      set: z.array(z.object({ column: z.string(), value: z.string() })),
      summary: z.string(),
    })
    .nullable(),
  reply: z.string(),
});

export type RawAnswer = z.infer<typeof AnswerSchema>;

export function toAnswer(out: RawAnswer): DataAnswer {
  if (out.kind === 'read' && out.sql.trim()) return { kind: 'read', sql: out.sql.trim(), headline: out.headline.trim(), explanation: out.explanation.trim() };
  if (out.kind === 'change' && out.change) {
    const c = out.change;
    return { kind: 'change', explanation: out.explanation.trim(), plan: { action: c.action, table: c.table.trim(), where: c.where.trim(), set: c.set.map((s) => ({ column: s.column.trim(), value: s.value.trim() })), summary: c.summary.trim() } };
  }
  return { kind: 'unclear', reply: out.reply.trim() || 'I couldn’t tell what you meant. Could you say it another way?' };
}

export function askPrompt(input: AskInput): string {
  return `Tables:\n${input.schema}\n\nToday is ${input.today} (time zone ${input.timeZone}).\n\nThe person asks: ${input.question}`;
}

/** The real one: one structured-output call to Claude at low effort. */
export function claudeAsker(apiKey: string): Asker {
  const client = new Anthropic({ apiKey, authToken: null, maxRetries: 2, timeout: 90_000 });
  return async (input, signal) => {
    const response = await client.messages.parse(
      {
        model: DATA_MODEL,
        max_tokens: 8000,
        system: SYSTEM,
        messages: [{ role: 'user', content: askPrompt(input) }],
        output_config: { effort: 'low', format: zodOutputFormat(AnswerSchema) },
      },
      { signal },
    );
    const costUsd = usageCost(DATA_MODEL, response.usage);
    if (response.stop_reason === 'refusal') return { answer: { kind: 'unclear', reply: 'Claude won’t help with that request.' }, costUsd };
    if (!response.parsed_output) throw new DataError('Claude’s answer came back incomplete. Try asking again.');
    return { answer: toAnswer(response.parsed_output), costUsd };
  };
}

/** Fills {count} and {value} in a headline from what the query returned. */
export function fillHeadline(headline: string, result: ReadResult): string {
  const count = result.truncated ? `${result.rows.length}+` : String(result.rows.length);
  const single = result.rows.length === 1 && result.columns.length === 1 ? (result.rows[0][0] ?? 'nothing') : null;
  let text = headline.replace(/\{count\}/g, count);
  if (text.includes('{value}')) text = single !== null ? text.replace(/\{value\}/g, single) : '';
  if (!text.trim()) return result.rows.length === 1 ? 'Here’s the answer.' : `${count} rows.`;
  return text;
}

// ---- demo mode: a few questions about users, without Claude ---------------------------

function usersTable(schema: Schema): { table: Table; created?: string; label: string[]; lastSignIn?: string } | null {
  const order = ['auth.users', 'public.users', 'public.profiles', 'public.customers', 'public.members', 'public.accounts'];
  const table = order.map((n) => schema.tables.find((t) => `${t.schema}.${t.name}` === n)).find(Boolean);
  if (!table) return null;
  const has = (n: string) => table.columns.some((c) => c.name === n && !c.hidden);
  const created = ['created_at', 'createdAt', 'inserted_at', 'signed_up_at', 'joined_at'].find(has);
  const label = ['email', 'full_name', 'name', 'display_name', 'username'].filter(has).slice(0, 2);
  const lastSignIn = ['last_sign_in_at', 'last_login_at', 'last_seen_at'].find(has);
  return { table, created, label: label.length ? label : [table.primaryKey[0] ?? table.columns[0].name], lastSignIn };
}

/**
 * Demo mode answers a few questions about users with fixed SQL, so the
 * Users & Data screen can be tried without an API key. It never changes data.
 */
export function demoAsker(schemaOf: () => Schema): Asker {
  return async (input) => {
    const q = input.question.toLowerCase();
    const users = usersTable(schemaOf());
    const unclear = (reply: string) => ({ answer: { kind: 'unclear' as const, reply }, costUsd: 0 });
    if (/\b(give|set|make|mark|change|rename|delete|remove|add|update)\b/.test(q)) return unclear('Demo mode only reads. Add your Anthropic API key to make changes, which you see and confirm before they happen.');
    if (!users) return unclear('Demo mode answers questions about users, and there’s no users table here. Add your Anthropic API key to ask about anything.');
    const from = `${ident(users.table.schema)}.${ident(users.table.name)}`;
    const created = users.created ? ident(users.created) : null;
    const cols = [...users.label.map(ident), ...(created ? [created] : [])].join(', ');
    const recent = created ? ` ORDER BY ${created} DESC` : '';
    const read = (sql: string, headline: string, explanation: string) => ({ answer: { kind: 'read' as const, sql, headline, explanation }, costUsd: 0 });
    if (/\bhow many\b|\bnumber of\b|\bcount\b|\btotal\b/.test(q) && !/today|week|month|7 days|30 days/.test(q)) return read(`SELECT count(*) AS users FROM ${from}`, '{value} users in total', `Counted the rows in ${users.table.name}.`);
    if (created && /today/.test(q)) return read(`SELECT ${cols} FROM ${from} WHERE ${created} >= current_date${recent}`, '{count} signed up today', `Looked for ${users.table.name} created since midnight.`);
    if (created && /week|7 days/.test(q)) return read(`SELECT ${cols} FROM ${from} WHERE ${created} >= now() - interval '7 days'${recent}`, '{count} signed up in the last 7 days', `Looked for ${users.table.name} created in the last 7 days.`);
    if (created && /month|30 days/.test(q)) return read(`SELECT ${cols} FROM ${from} WHERE ${created} >= now() - interval '30 days'${recent}`, '{count} signed up in the last 30 days', `Looked for ${users.table.name} created in the last 30 days.`);
    if (users.lastSignIn && /never (?:logged|signed) in|never (?:came|come) back/.test(q)) return read(`SELECT ${cols} FROM ${from} WHERE ${ident(users.lastSignIn)} IS NULL${recent}`, '{count} never signed in', `Looked for ${users.table.name} with no sign-in yet.`);
    if (/latest|newest|recent|last/.test(q)) return read(`SELECT ${cols} FROM ${from}${recent} LIMIT 10`, 'The {count} newest', `Took the 10 newest from ${users.table.name}.`);
    if (/\bwho\b|\blist\b|\bshow\b|\ball\b|\busers\b/.test(q)) return read(`SELECT ${cols} FROM ${from}${recent}`, '{count} users', `Listed ${users.table.name}.`);
    return unclear('Demo mode answers a few questions about users, like “How many users are there?” or “Who signed up this week?”. Add your Anthropic API key to ask anything.');
  };
}
