/**
 * A small scanner for SQL that Hivebubble runs on someone's database. It
 * knows strings, quoted names, dollar quotes and comments, so a ';' or a
 * function name inside them doesn't count. It is the second line of defence:
 * questions run in a READ ONLY transaction, so the database itself refuses
 * to write, and changes never run SQL from Claude as a statement.
 */
export interface SqlScan {
  /** Non-empty statements, split on top-level semicolons. */
  statements: number;
  /** The first word of the first statement, uppercased. */
  firstWord: string;
  /** Words outside strings and comments, lowercased. */
  words: string[];
  /** Names followed by '(' outside strings and comments, lowercased. */
  calls: string[];
  /** Parentheses never close before they open, and all of them close. */
  balanced: boolean;
  /** A string, quoted name or comment is never closed. */
  unterminated: boolean;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

export function scanSql(sql: string): SqlScan {
  const words: string[] = [];
  const calls: string[] = [];
  let statements = 0;
  let content = false;
  let firstWord = '';
  let depth = 0;
  let balanced = true;
  let unterminated = false;
  let backslashString = false;
  const n = sql.length;
  let i = 0;

  const nextNonSpace = (from: number) => {
    let j = from;
    while (j < n && /\s/.test(sql[j])) j++;
    return sql[j];
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      // Block comments nest in PostgreSQL.
      let level = 1;
      i += 2;
      while (i < n && level > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          level++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          level--;
          i += 2;
        } else i++;
      }
      if (level > 0) unterminated = true;
      continue;
    }
    if (c === "'") {
      const escapes = backslashString;
      backslashString = false;
      content = true;
      i++;
      let closed = false;
      while (i < n) {
        if (escapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (!closed) unterminated = true;
      continue;
    }
    backslashString = false;
    if (c === '"') {
      content = true;
      let name = '';
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            name += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        name += sql[i++];
      }
      if (!closed) unterminated = true;
      words.push(name.toLowerCase());
      if (nextNonSpace(i) === '(') calls.push(name.toLowerCase());
      continue;
    }
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i));
      if (tag) {
        content = true;
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) {
          unterminated = true;
          i = n;
        } else i = end + tag[0].length;
        continue;
      }
    }
    if (c === ';') {
      if (content) statements++;
      content = false;
      i++;
      continue;
    }
    if (WORD_START.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(sql[j])) j++;
      const word = sql.slice(i, j);
      i = j;
      content = true;
      if (!firstWord) firstWord = word.toUpperCase();
      words.push(word.toLowerCase());
      // E'...' strings treat backslashes as escapes.
      if ((word === 'E' || word === 'e') && sql[i] === "'") backslashString = true;
      else if (nextNonSpace(i) === '(') calls.push(word.toLowerCase());
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth < 0) balanced = false;
    }
    if (!/\s/.test(c)) content = true;
    i++;
  }
  if (content) statements++;
  return { statements, firstWord, words, calls, balanced: balanced && depth === 0, unterminated };
}

/** Functions a question or a change must never call: they act on the server, its files or other connections. */
const BLOCKED_CALL = /^(?:pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|set_config|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|lo_\w+|dblink\w*|pg_logical_emit_message|pg_create_restore_point|pg_switch_wal|pg_promote|pg_backup_\w+|pg_notify|http\w*|pg_file_\w+|copy)$/;

export function blockedCalls(scan: SqlScan): string[] {
  return [...new Set(scan.calls.filter((c) => BLOCKED_CALL.test(c)))];
}

/** Why this SQL can't be run as a question, or null when it can. */
export function checkReadSql(sql: string): string | null {
  const scan = scanSql(sql);
  if (scan.unterminated) return 'The query has a quote or comment that never ends.';
  if (scan.statements === 0) return 'There is no query to run.';
  if (scan.statements > 1) return 'Only one query can run at a time.';
  if (!['SELECT', 'WITH', 'VALUES', 'TABLE'].includes(scan.firstWord)) return 'Questions can only read data: the query has to start with SELECT or WITH.';
  if (!scan.balanced) return 'The query’s brackets don’t match.';
  const blocked = blockedCalls(scan);
  if (blocked.length) return `The query calls ${blocked.join(', ')}, which Hivebubble doesn’t run.`;
  if (scan.words.includes('into') && scan.firstWord === 'SELECT') return 'SELECT … INTO makes a new table, and questions only read.';
  return null;
}

/**
 * Why this piece of SQL (a condition, or a new value) can't go into a change,
 * or null when it can. It must be one expression: no semicolons, brackets
 * that stay inside it, nothing left open, and no blocked functions.
 */
export function checkSqlFragment(fragment: string, what: string): string | null {
  const scan = scanSql(fragment);
  if (scan.unterminated) return `The ${what} has a quote or comment that never ends.`;
  if (scan.statements !== 1 || /;/.test(fragment.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, ''))) return `The ${what} must be a single expression.`;
  if (!scan.balanced) return `The ${what}’s brackets don’t match.`;
  const blocked = blockedCalls(scan);
  if (blocked.length) return `The ${what} calls ${blocked.join(', ')}, which Hivebubble doesn’t run.`;
  return null;
}

/** A name quoted for PostgreSQL: "my ""odd"" name". */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Without trailing semicolons and space, so it can sit inside a cursor. */
export function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/[\s;]+$/, '');
}
