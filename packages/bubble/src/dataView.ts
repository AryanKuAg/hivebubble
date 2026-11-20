import type { ClientMessage, DataCell, DataChange, DataInfo, DataProposal, DataTable, ServerEvent } from '../../core/src/types';
import { ago, button, el } from './dom';

type Ev<T extends ServerEvent['type']> = Extract<ServerEvent, { type: T }>;
type Tab = 'ask' | 'changes' | 'logs';

const EXAMPLES = ['How many users are there?', 'Who signed up this week?', 'Which users never signed in?', 'Show the 10 newest sign-ups'];
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const PHONE_COLUMN = /phone|mobile|^tel$|telephone|whatsapp/i;

export const maskEmails = (text: string) => text.replace(EMAIL, (_m, first: string, domain: string) => `${first}•••@${domain}`);
const maskDigits = (text: string) => text.replace(/\d(?=(?:\D*\d){2})/g, '•');
const money = (usd: number) => `$${usd > 0 && usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`;

const saved = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`hivebubble:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(`hivebubble:${key}`, value);
    } catch {
      // Blocked storage: the setting lasts until the page reloads.
    }
  },
};

/**
 * Users & Data inside the bubble (README §10): ask about the data in plain
 * words, preview and confirm changes, undo them, and read the logs summary.
 * Everything shown is set as text, never as HTML.
 */
export class DataView {
  private info: DataInfo | null = null;
  private tab: Tab = 'ask';
  private mask = saved.get('mask') === '1';
  private changes: DataChange[] = [];
  private logs: Ev<'data-logs'> | null = null;
  private asking = false;
  private applying: { id: string; status: HTMLElement; actions: HTMLElement } | null = null;
  private readonly raw = new WeakMap<HTMLElement, { text: string; phone: boolean }>();
  private readonly proposals = new Map<string, { status: HTMLElement; actions: HTMLElement }>();
  private readonly undoHandlers = new Map<string, (r: Ev<'data-undo-result'>) => void>();

  private readonly status: HTMLElement;
  private readonly connect: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly working: HTMLElement;
  private readonly panes: Record<Tab, HTMLElement>;
  private readonly input: HTMLTextAreaElement;
  private readonly askBtn: HTMLButtonElement;
  private readonly examples: HTMLElement;
  private readonly modeNote: HTMLElement;
  private readonly cards: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly send: (msg: ClientMessage) => void,
    private readonly askHive: (text: string) => void,
    onBack: () => void,
  ) {
    const head = el('div', 'deploy-head');
    head.append(button('← Back to the chat', 'link', onBack), el('h2', '', 'Users & Data'));
    this.status = el('p', 'data-status muted', 'Checking for a database…');
    this.connect = el('div', 'data-connect');
    this.connect.hidden = true;

    this.tabs = el('div', 'data-tabs');
    this.tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['ask', 'Ask'], ['changes', 'Changes'], ['logs', 'Logs']] as Array<[Tab, string]>) {
      const t = button(label, 'data-tab', () => this.show(id));
      t.dataset.tab = id;
      t.setAttribute('role', 'tab');
      this.tabs.append(t);
    }
    this.working = el('p', 'data-working');
    this.working.hidden = true;

    // Ask
    const form = el('form', 'data-ask');
    this.input = el('textarea');
    this.input.rows = 2;
    this.input.placeholder = 'Ask about your users or data, or ask for a change…';
    this.input.setAttribute('aria-label', 'Question about your data');
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    this.askBtn = el('button', 'primary', 'Ask');
    this.askBtn.type = 'submit';
    form.append(this.input, this.askBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.ask(this.input.value);
    });
    this.examples = el('div', 'data-examples');
    for (const q of EXAMPLES) this.examples.append(button(q, 'chip-btn', () => this.ask(q)));
    this.modeNote = el('p', 'note small');
    this.modeNote.hidden = true;
    this.cards = el('div', 'data-cards');
    const ask = el('div', 'data-pane');
    ask.append(form, this.modeNote, this.examples, this.cards);

    this.panes = { ask, changes: el('div', 'data-pane'), logs: el('div', 'data-pane') };
    const body = el('div', 'data-body');
    body.append(this.panes.ask, this.panes.changes, this.panes.logs);

    const foot = el('div', 'data-foot');
    const privacy = el('p', 'small muted', 'Claude sees your question and the names of your tables and columns, never the rows. Answers and backups stay on this computer.');
    const label = el('label', 'mask');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = this.mask;
    box.addEventListener('change', () => {
      this.mask = box.checked;
      saved.set('mask', this.mask ? '1' : '0');
      this.remask();
    });
    label.append(box, ' Hide emails and phone numbers');
    foot.append(privacy, label);

    root.append(head, this.status, this.connect, this.tabs, this.working, body, foot);
    this.show('ask');
  }

  open(): void {
    this.send({ type: 'data-info' });
    if (this.tab !== 'ask') this.refresh(this.tab);
  }

  event(e: ServerEvent): void {
    switch (e.type) {
      case 'data-info':
        return this.setInfo(e);
      case 'data-working':
        return this.setWorking(e.message);
      case 'data-result':
        this.done();
        return this.addCard(this.resultCard(e));
      case 'data-proposal':
        this.done();
        return this.addCard(this.proposalCard(e));
      case 'data-reply': {
        this.done();
        const card = el('div', 'card reply');
        card.append(el('p', 'q', e.question));
        const text = el('p', '');
        this.setText(text, e.text);
        card.append(text);
        if (e.costUsd) card.append(el('p', 'meta', `Claude: ${money(e.costUsd)}`));
        return this.addCard(card);
      }
      case 'data-error':
        return this.error(e.message);
      case 'data-applied':
        return this.applied(e.change);
      case 'data-changes':
        this.changes = e.changes;
        return this.renderChanges();
      case 'data-undo-result':
        this.setWorking(null);
        this.undoHandlers.get(e.id)?.(e);
        this.undoHandlers.delete(e.id);
        return;
      case 'data-logs':
        this.setWorking(null);
        this.logs = e;
        return this.renderLogs();
    }
  }

  // ---- connection ---------------------------------------------------------

  private setInfo(info: DataInfo): void {
    this.info = info;
    this.status.replaceChildren();
    const again = button('Check again', 'link', () => {
      this.status.replaceChildren(el('span', '', 'Checking…'));
      this.send({ type: 'data-info' });
    });
    if (info.connected && info.db) {
      const dot = el('span', 'dot ok');
      const what = el('span', '', `${info.db.kind} · ${info.db.host} · ${info.db.database}`);
      const ro = el('span', 'badge', 'Read-only');
      ro.title = 'Hivebubble only reads, unless you ask for a change and confirm it.';
      this.status.append(dot, what, ro, again);
      if (info.from) this.status.title = `From ${info.from}`;
    } else {
      this.status.append(el('span', 'dot'), el('span', '', info.problem ? 'Couldn’t connect' : 'No database connected'), again);
    }
    this.status.className = 'data-status';
    const connected = info.connected;
    this.connect.hidden = connected;
    this.tabs.hidden = !connected;
    for (const p of Object.values(this.panes)) p.hidden = true;
    if (!connected) {
      this.renderConnect(info);
      return;
    }
    this.modeNote.hidden = info.canAsk && !info.demo;
    this.modeNote.textContent = !info.canAsk
      ? 'Questions in words need your Anthropic API key. You can still run SQL from “How I got this” on any answer.'
      : 'Demo mode: a few questions about users, answered without Claude. Nothing can be changed.';
    this.show(this.tab);
    this.send({ type: 'data-changes' });
  }

  private renderConnect(info: DataInfo): void {
    const box = this.connect;
    box.replaceChildren();
    if (info.problem) {
      const p = el('p', 'note error-note');
      p.textContent = info.problem;
      box.append(p);
      if (info.from) box.append(el('p', 'small muted', `The connection string came from ${info.from}.`));
      return;
    }
    box.append(el('h3', '', 'Connect your database'));
    const steps = el('ol', 'mini');
    steps.append(
      el('li', '', 'Supabase: open your project, press Connect, and copy the “Session pooler” connection string. Put your database password in place of [YOUR-PASSWORD].'),
      el('li', '', 'Any other Postgres: use its connection string, the one that starts with postgres://.'),
      el('li', '', info.app
        ? 'In the Hivebubble app, paste it under Users & Data for this project. The app keeps it in your computer’s secure storage (the Keychain on a Mac, Credential Manager on Windows) and restarts the project with it.'
        : 'Put it in your project’s .env.local as DATABASE_URL=postgres://… and press Check again.'),
    );
    box.append(steps, el('p', 'small muted', 'Hivebubble only reads your data, unless you ask for a change and confirm it after seeing exactly which rows it touches.'));
  }

  private show(tab: Tab): void {
    this.tab = tab;
    for (const t of Array.from(this.tabs.querySelectorAll<HTMLElement>('.data-tab'))) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    const connected = Boolean(this.info?.connected);
    for (const [id, pane] of Object.entries(this.panes)) pane.hidden = !connected || id !== tab;
    if (connected && tab !== 'ask') this.refresh(tab);
    if (connected && tab === 'ask') this.input.focus();
  }

  private refresh(tab: 'changes' | 'logs'): void {
    if (tab === 'changes') this.send({ type: 'data-changes' });
    else {
      this.setWorking('Reading the logs…');
      this.send({ type: 'data-logs' });
    }
  }

  private setWorking(message: string | null): void {
    this.working.hidden = !message;
    this.working.textContent = message ?? '';
  }

  private done(): void {
    this.asking = false;
    this.askBtn.disabled = false;
    this.setWorking(null);
  }

  private error(message: string): void {
    this.done();
    if (this.applying) {
      const { status, actions } = this.applying;
      this.applying = null;
      status.className = 'status error-text';
      status.textContent = message;
      for (const b of Array.from(actions.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input'))) b.disabled = false;
      return;
    }
    if (this.tab === 'ask') {
      const card = el('div', 'card failure-card');
      const p = el('p', '');
      this.setText(p, message);
      card.append(p);
      this.addCard(card);
    } else {
      const pane = this.panes[this.tab];
      pane.querySelector('.data-notice')?.remove();
      const note = el('p', 'note error-note data-notice', message);
      pane.prepend(note);
    }
  }

  // ---- asking -------------------------------------------------------------

  private ask(text: string): void {
    const question = text.trim();
    if (!question || this.asking || !this.info?.connected) return;
    this.asking = true;
    this.askBtn.disabled = true;
    this.examples.hidden = true;
    this.input.value = '';
    this.setWorking('Reading your tables…');
    this.send({ type: 'data-ask', question });
  }

  private addCard(card: HTMLElement): void {
    this.examples.hidden = true;
    this.cards.prepend(card);
    while (this.cards.children.length > 12) this.cards.lastElementChild?.remove();
    if (this.tab !== 'ask') this.show('ask');
    card.scrollIntoView?.({ block: 'nearest' });
  }

  /** Sets text that may hold personal data, masked when the switch is on. */
  private setText(node: HTMLElement, text: string, phone = false): void {
    this.raw.set(node, { text, phone });
    node.dataset.m = '';
    node.textContent = this.masked(text, phone);
  }

  private masked(text: string, phone: boolean): string {
    if (!this.mask) return text;
    return phone ? maskDigits(text) : maskEmails(text);
  }

  private remask(): void {
    for (const node of Array.from(this.root.querySelectorAll<HTMLElement>('[data-m]'))) {
      const r = this.raw.get(node);
      if (r) node.textContent = this.masked(r.text, r.phone);
    }
  }

  private cell(td: HTMLElement, value: DataCell, column: string): void {
    if (value === null) {
      td.textContent = '—';
      td.classList.add('null');
      return;
    }
    this.setText(td, value, PHONE_COLUMN.test(column));
    if (value.length > 40) td.title = this.masked(value, PHONE_COLUMN.test(column));
  }

  private table(t: DataTable): HTMLElement {
    const wrap = el('div', 'dtable');
    const table = el('table');
    const head = el('tr');
    for (const c of t.columns) head.append(el('th', c.kind === 'number' ? 'num' : '', c.name));
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    for (const row of t.rows) {
      const tr = el('tr');
      row.forEach((v, i) => {
        const td = el('td', t.columns[i]?.kind === 'number' ? 'num' : '');
        this.cell(td, v, t.columns[i]?.name ?? '');
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  /** Two columns, a label and a number, a few rows: bars read faster than a table. */
  private bars(t: DataTable): HTMLElement | null {
    if (t.columns.length !== 2 || t.columns[1].kind !== 'number' || t.rows.length < 2 || t.rows.length > 31) return null;
    const values = t.rows.map((r) => Number(r[1] ?? 0));
    if (values.some((v) => !Number.isFinite(v) || v < 0)) return null;
    const max = Math.max(...values, 1);
    const box = el('div', 'bars');
    t.rows.forEach((r, i) => {
      const row = el('div', 'bar-row');
      const label = el('span', 'label');
      this.cell(label, r[0], t.columns[0].name);
      const track = el('span', 'track');
      const fill = el('i');
      fill.style.width = `${Math.max(2, (values[i] / max) * 100)}%`;
      track.append(fill);
      row.append(label, track, el('span', 'val', r[1] ?? '0'));
      box.append(row);
    });
    return box;
  }

  private resultCard(e: Ev<'data-result'>): HTMLElement {
    const card = el('div', 'card answer');
    card.append(el('p', 'q', e.question ?? 'Your SQL'));
    const headline = el('h3', 'headline');
    this.setText(headline, e.headline);
    card.append(headline);
    const single = e.table.rows.length === 1 && e.table.columns.length === 1;
    if (!single && e.table.rows.length) {
      const bars = this.bars(e.table);
      if (bars) {
        const asTable = el('details', 'how');
        asTable.append(el('summary', '', 'As a table'), this.table(e.table));
        card.append(bars, asTable);
      } else card.append(this.table(e.table));
    }
    const meta = [`${e.table.rows.length}${e.table.truncated ? '+' : ''} row${e.table.rows.length === 1 ? '' : 's'}`, `${e.ms} ms`];
    if (e.table.truncated) meta.push('showing the first 500');
    if (e.costUsd) meta.push(`Claude: ${money(e.costUsd)}`);
    card.append(el('p', 'meta', meta.join(' · ')));
    card.append(this.how(e.sql, e.explanation));
    return card;
  }

  /** "How I got this": the plain explanation and the SQL, which can be edited and run (read-only). */
  private how(sql: string, explanation?: string): HTMLElement {
    const details = el('details', 'how');
    details.append(el('summary', '', 'How I got this'));
    if (explanation) details.append(el('p', 'small', explanation));
    const box = el('textarea', 'sql');
    box.value = sql;
    box.rows = Math.min(8, sql.split('\n').length + 1);
    box.spellcheck = false;
    box.setAttribute('aria-label', 'SQL');
    details.append(box, button('Run this SQL', 'link', () => {
      this.setWorking('Asking the database…');
      this.send({ type: 'data-run', sql: box.value });
    }));
    return details;
  }

  // ---- changes ------------------------------------------------------------

  private proposalCard(e: Ev<'data-proposal'>): HTMLElement {
    const p = e.proposal;
    const card = el('div', 'card proposal');
    card.append(el('p', 'q', e.question));
    const title = el('h3', 'headline');
    this.setText(title, p.summary);
    card.append(title);
    const verb = p.action === 'update' ? 'change' : p.action === 'delete' ? 'be deleted' : 'be added';
    card.append(el('p', 'meta', `In ${p.table} · ${p.count} row${p.count === 1 ? '' : 's'} will ${verb}`));
    card.append(this.diff(p));
    if (p.count > p.rows.length) card.append(el('p', 'meta', `…and ${p.count - p.rows.length} more.`));
    card.append(el('p', 'note small', p.backupNote));
    if (e.explanation) card.append(el('p', 'small muted', e.explanation));
    if (e.costUsd) card.append(el('p', 'meta', `Claude: ${money(e.costUsd)}`));

    const actions = el('div', 'actions');
    let word: HTMLInputElement | null = null;
    if (p.needsWord) {
      word = el('input', 'word');
      word.placeholder = `Type “${p.needsWord}” to confirm`;
      word.setAttribute('aria-label', `Type ${p.needsWord} to confirm`);
      word.autocomplete = 'off';
      actions.append(word);
    }
    const status = el('p', 'status');
    const go = button(p.action === 'delete' ? `Delete ${p.count === 1 ? 'it' : `${p.count} rows`}` : 'Make this change', 'primary', () => {
      for (const b of Array.from(actions.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input'))) b.disabled = true;
      status.className = 'status';
      status.textContent = 'Saving a backup, then making the change…';
      this.applying = { id: p.id, status, actions };
      this.send({ type: 'data-apply', id: p.id, word: word?.value });
    });
    if (p.action === 'delete') go.classList.add('danger');
    const cancel = button('Cancel', 'link', () => {
      this.send({ type: 'data-cancel', id: p.id });
      actions.remove();
      status.textContent = 'Cancelled. Nothing changed.';
    });
    actions.append(go, cancel);
    card.append(actions, status);
    this.proposals.set(p.id, { status, actions });
    return card;
  }

  private diff(p: DataProposal): HTMLElement {
    const wrap = el('div', 'dtable diff');
    const table = el('table');
    const head = el('tr');
    const ids = p.label ? [p.label] : p.key;
    const cols = p.action === 'update' ? [...ids, ...p.columns] : p.columns;
    for (const c of cols) head.append(el('th', '', c));
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    for (const r of p.rows) {
      const tr = el('tr', p.action === 'delete' ? 'gone' : p.action === 'insert' ? 'added' : '');
      if (p.action === 'update') {
        if (p.label) {
          const td = el('td');
          this.cell(td, r.label ?? null, p.label);
          tr.append(td);
        } else {
          r.key.forEach((v, i) => {
            const td = el('td', 'key');
            this.cell(td, v, p.key[i]);
            tr.append(td);
          });
        }
        p.columns.forEach((c, j) => {
          const td = el('td', 'change');
          const before = el('s', 'old');
          this.cell(before, r.before?.[j] ?? null, c);
          const after = el('span', 'new');
          this.cell(after, r.after?.[j] ?? null, c);
          td.append(before, ' → ', after);
          tr.append(td);
        });
      } else {
        const values = (p.action === 'delete' ? r.before : r.after) ?? [];
        p.columns.forEach((c, j) => {
          const td = el('td');
          this.cell(td, values[j] ?? null, c);
          tr.append(td);
        });
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }

  private applied(change: DataChange): void {
    this.done();
    const card = this.proposals.get(change.id);
    if (this.applying?.id === change.id) this.applying = null;
    if (!card) return;
    card.actions.remove();
    card.status.className = 'status ok-text';
    card.status.replaceChildren(el('span', '', `✓ Done. ${change.count === 1 ? 'One row' : `${change.count} rows`} changed, and the backup is saved. `));
    card.status.append(button('Undo', 'link', () => this.undo(change.id, card.status)));
  }

  private undo(id: string, status: HTMLElement, force = false): void {
    status.className = 'status';
    status.textContent = 'Putting the rows back…';
    this.undoHandlers.set(id, (r) => {
      status.replaceChildren();
      if (r.ok) {
        status.className = 'status ok-text';
        status.textContent = '✓ Undone. The rows are back as they were.';
        return;
      }
      status.className = 'status';
      status.append(el('span', '', `${r.message} `));
      if (r.canForce) status.append(button('Undo anyway', 'link', () => this.undo(id, status, true)), ' ', button('Keep it', 'link', () => (status.textContent = 'Kept as it is.')));
    });
    this.send({ type: 'data-undo', id, force });
  }

  private renderChanges(): void {
    const pane = this.panes.changes;
    pane.replaceChildren();
    if (!this.changes.length) {
      pane.append(el('p', 'muted small', 'Changes you make here show up in this list, each with a backup of the rows from before. Undo puts them back.'));
      return;
    }
    const list = el('ul', 'changes');
    for (const c of this.changes) {
      const li = el('li', c.state);
      const title = el('strong', '');
      this.setText(title, c.summary);
      li.append(title, el('span', 'meta', `${c.table} · ${c.count} row${c.count === 1 ? '' : 's'} ${c.action === 'update' ? 'changed' : c.action === 'delete' ? 'deleted' : 'added'} · ${ago(c.at)}`));
      const status = el('p', 'status');
      if (c.state === 'undone') status.append(el('span', 'badge', c.undoneAt ? `Undone ${ago(c.undoneAt)}` : 'Undone'));
      else status.append(button('Undo', 'link', () => this.undo(c.id, status)));
      li.append(status);
      list.append(li);
    }
    pane.append(list);
  }

  // ---- logs ---------------------------------------------------------------

  private renderLogs(): void {
    const pane = this.panes.logs;
    const logs = this.logs;
    pane.replaceChildren();
    if (!logs) return;
    const top = el('div', 'logs-head');
    top.append(el('h3', '', 'Errors'), button('Refresh', 'link', () => this.refresh('logs')));
    pane.append(top);
    this.renderErrors(pane, logs);
    pane.append(el('h3', '', 'Sign-ups and sign-ins'));
    if (logs.auth) {
      const a = logs.auth;
      if (a.users) {
        const stats = el('div', 'stats');
        for (const [n, label] of [[a.users.total, 'users'], [a.users.today, 'new today'], [a.users.week, 'new this week']] as Array<[number, string]>) {
          const s = el('div', 'stat');
          s.append(el('strong', '', n.toLocaleString()), el('span', '', label));
          stats.append(s);
        }
        pane.append(stats);
      }
      if (a.actions.length) {
        const chips = el('p', 'chips');
        for (const x of a.actions) chips.append(el('span', 'badge', `${x.label}: ${x.count}`));
        pane.append(el('p', 'small muted', 'The last 7 days:'), chips);
      }
      if (a.recent.length) {
        const list = el('ul', 'recent');
        for (const r of a.recent.slice(0, 8)) {
          const li = el('li');
          const who = el('span', 'who');
          this.setText(who, r.who || 'someone');
          li.append(el('span', 'when', ago(r.at)), who, el('span', '', r.label.toLowerCase()));
          list.append(li);
        }
        pane.append(list);
      }
    } else {
      pane.append(el('p', 'small muted', logs.authProblem ?? 'Sign-up and sign-in activity shows here for Supabase projects.'));
    }
  }

  private renderErrors(pane: HTMLElement, logs: Ev<'data-logs'>): void {
    if (!logs.groups.length) {
      pane.append(el('p', 'small muted', 'No errors so far. Errors from the page, the dev server and production builds show up here.'));
      return;
    }
    const list = el('ul', 'errors');
    const source = { page: 'On the page', dev: 'Dev server', deploy: 'Production build' } as const;
    for (const g of logs.groups) {
      const li = el('li');
      li.append(el('strong', 'plain', g.plain));
      const msg = el('code', 'msg');
      this.setText(msg, g.message.split('\n')[0].slice(0, 200));
      li.append(msg);
      const where = g.file ? ` · ${g.file}${g.line ? `, near line ${g.line}` : ''}` : '';
      li.append(el('span', 'meta', `${g.count}× · ${ago(g.last)} · ${source[g.source]}${where}`));
      if (g.detail) {
        const more = el('details', 'how');
        more.append(el('summary', '', 'Details'));
        const pre = el('pre');
        this.setText(pre, g.detail);
        more.append(pre);
        li.append(more);
      }
      li.append(button('Fix it', 'primary small-btn', () => {
        const at = g.file ? `\nIt points at ${g.file}${g.line ? `, near line ${g.line}` : ''}.` : '';
        const text = `Please fix this error (${source[g.source].toLowerCase()}, seen ${g.count}×): ${g.message.split('\n')[0]}${at}${g.detail ? `\n\n${g.detail.slice(0, 1500)}` : ''}`;
        this.askHive(this.mask ? maskEmails(text) : text);
      }));
      list.append(li);
    }
    pane.append(list);
  }
}
