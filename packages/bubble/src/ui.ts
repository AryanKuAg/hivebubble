import type { AgentKind, ChatEntry, CheckResult, Effort, Mode, PickedElement, Route, ServerEvent, SpendSummary } from '../../core/src/types';
import { Connection } from './connection';
import { DeployView } from './deployView';
import { BEE, BULB, CLOSE, GLOBE, HIVE, HIVE_ENTRANCE, PICK, SEND, STOP, UNDO } from './icons';
import { describeElement, startPicker } from './picker';
import { SWARM_SIZE, Swarm } from './swarm';
import { CSS } from './styles';
import { shortSrc } from './targets';
import { PageWatcher } from './watch';

const TEMPLATE = `
<style>${CSS}</style>
<div class="root">
  <div class="layer" aria-hidden="true"></div>
  <ul class="tray" hidden></ul>
  <div class="pick-box" hidden></div>
  <div class="pick-hint" hidden>Click the part of the page you want to change · Esc to cancel</div>
  <section class="panel" role="dialog" aria-label="Hivebubble chat" hidden>
    <header>
      <div class="brand">${HIVE}<span>Hivebubble</span><span class="chip agent" hidden></span><span class="chip spend" hidden></span></div>
      <span class="conn" hidden>Reconnecting…</span>
      <button class="icon-btn online" type="button" title="Put it online" aria-label="Put it online">${GLOBE}</button>
      <button class="icon-btn undo" type="button" disabled title="Undo the last change">${UNDO}<span class="txt">Undo</span></button>
      <button class="icon-btn close" type="button" aria-label="Close chat">${CLOSE}</button>
    </header>
    <div class="banner" hidden></div>
    <section class="deploy" aria-label="Put it online" hidden></section>
    <div class="messages" aria-live="polite"></div>
    <div class="composer">
      <div class="picked" hidden><span></span><small class="src"></small><button class="icon-btn unpick" type="button" aria-label="Remove picked element">${CLOSE}</button></div>
      <textarea rows="2" placeholder="Tell the hive what to change…" aria-label="Message"></textarea>
      <div class="row">
        <button class="icon-btn pick" type="button" title="Pick an element on the page">${PICK}<span class="txt">Pick</span></button>
        <button class="icon-btn think" type="button" aria-pressed="false" title="Think harder: the deepest effort, for this message only. Slower, and it costs more.">${BULB}<span class="txt">Harder</span></button>
        <div class="modes" role="group" aria-label="Effort">
          <button type="button" data-mode="quick" title="Faster, one level less effort">Quick</button>
          <button type="button" data-mode="balanced" title="Let the router decide">Auto</button>
          <button type="button" data-mode="thorough" title="Slower, one level more effort">Thorough</button>
        </div>
        <button class="send" type="button" aria-label="Send">${SEND}</button>
      </div>
    </div>
  </section>
  <button class="launcher" type="button" aria-label="Open Hivebubble chat">${HIVE}<span class="idle">${BEE}</span></button>
</div>`;

const CHECK_NAMES: Record<CheckResult['check'], string> = { page: 'page', typecheck: 'types', build: 'build' };

const store = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(`hivebubble:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(`hivebubble:${key}`, value);
    } catch {
      // Storage can be blocked; the bubble still works without it.
    }
  },
};

const money = (usd: number) => `$${usd > 0 && usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`;

export function mount(): void {
  const host = document.createElement('hivebubble-root');
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = TEMPLATE;
  const q = <T extends Element>(sel: string) => shadow.querySelector(sel) as T;

  const panel = q<HTMLElement>('.panel');
  const launcher = q<HTMLButtonElement>('.launcher');
  const messages = q<HTMLElement>('.messages');
  const textarea = q<HTMLTextAreaElement>('textarea');
  const sendBtn = q<HTMLButtonElement>('.send');
  const undoBtn = q<HTMLButtonElement>('.undo');
  const pickBtn = q<HTMLButtonElement>('.pick');
  const thinkBtn = q<HTMLButtonElement>('.think');
  const pickedChip = q<HTMLElement>('.picked');
  const banner = q<HTMLElement>('.banner');
  const agentChip = q<HTMLElement>('.agent');
  const spendChip = q<HTMLElement>('.spend');
  const conn = q<HTMLElement>('.conn');
  const pickBox = q<HTMLElement>('.pick-box');
  const pickHint = q<HTMLElement>('.pick-hint');

  let busy = false;
  let agent: AgentKind = 'mock';
  let picked: PickedElement | null = null;
  let stopPicking: (() => void) | null = null;
  let working: HTMLElement | null = null;
  let activity = 'The hive is working';
  let liveCost: number | null = null;
  let thinkHarder = false;
  let mode: Mode = (store.get('mode') as Mode) || 'balanced';
  let taskEffort: Effort = 'medium';

  const hiveRect = () => launcher.querySelector('.hive')!.getBoundingClientRect();
  const watcher = new PageWatcher(host, (overlay) => swarm.pageError(overlay));
  const swarm = new Swarm({
    layer: q<HTMLElement>('.layer'),
    tray: q<HTMLElement>('.tray'),
    host,
    // Bees leave from, and return to, the hive's entrance hole.
    entrance: () => {
      const r = hiveRect();
      return { x: r.left + r.width * HIVE_ENTRANCE.x, y: r.top + r.height * HIVE_ENTRANCE.y };
    },
    // The workbench sits just left of the hive, next to the tray.
    bench: () => {
      const r = hiveRect();
      return { x: Math.max(40, r.left - 160), y: r.top + 12 };
    },
    focus: () => (picked ? safeQuery(picked.selector) : null),
    avoid: () => (panel.hidden ? null : panel.getBoundingClientRect()),
    watcher,
    onActivity: (text) => {
      activity = text;
      renderWorking();
    },
  });

  // ---- the deploy wizard (README §9) ----------------------------------------
  const composer = q<HTMLElement>('.composer');
  const deployView = new DeployView(
    q<HTMLElement>('.deploy'),
    (msg) => connection.send(msg),
    (text) => {
      showChat();
      textarea.value = text;
      textarea.focus();
    },
    () => showChat(),
  );
  function showDeploy(): void {
    setOpen(true);
    q<HTMLElement>('.deploy').hidden = false;
    messages.hidden = true;
    composer.hidden = true;
    deployView.open();
  }
  function showChat(): void {
    q<HTMLElement>('.deploy').hidden = true;
    messages.hidden = false;
    composer.hidden = false;
    scroll();
  }

  // ---- rendering ---------------------------------------------------------
  const scroll = () => {
    messages.scrollTop = messages.scrollHeight;
  };
  const clearEmpty = () => messages.querySelector('.empty')?.remove();
  const showEmpty = () => {
    if (messages.children.length > 0) return;
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `${BEE}<p>Tell the hive what to change. Pick part of the page first to point at it.</p>`;
    messages.append(empty);
  };

  function append(el: HTMLElement): void {
    clearEmpty();
    messages.append(el);
    if (working) messages.append(working);
    scroll();
  }

  function addMessage(role: ChatEntry['role'], text: string, route?: Route, error = false): void {
    const el = document.createElement('div');
    el.className = `msg ${role}${error ? ' error' : ''}`;
    el.textContent = text;
    append(el);
    if (route) {
      const chip = document.createElement('div');
      chip.className = 'route';
      chip.textContent = `${route.label} · ${route.effort} effort`;
      chip.title = route.reason;
      append(chip);
    }
  }

  /** A message with buttons. Choosing one disables them all. */
  function addCard(text: string, buttons: Array<{ label: string; primary?: boolean; onClick: () => void }>): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    const p = document.createElement('p');
    p.textContent = text;
    const row = document.createElement('div');
    row.className = 'actions';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = b.primary ? 'primary' : '';
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        row.querySelectorAll('button').forEach((x) => (x.disabled = true));
        b.onClick();
      });
      row.append(btn);
    }
    card.append(p, row);
    append(card);
    return card;
  }

  function lastText(): string {
    const msgs = messages.querySelectorAll('.msg');
    return msgs.length ? (msgs[msgs.length - 1].textContent ?? '') : '';
  }

  function renderWorking(): void {
    if (!working) return;
    const cost = agent === 'claude' && liveCost !== null ? ` · ${money(liveCost)}` : '';
    working.querySelector('span')!.textContent = `${activity}…${cost}`;
  }

  function setBusy(next: boolean): void {
    busy = next;
    launcher.classList.toggle('busy', busy);
    sendBtn.classList.toggle('stop', busy);
    sendBtn.innerHTML = busy ? STOP : SEND;
    sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
    if (busy && !working) {
      working = document.createElement('div');
      working.className = 'working';
      working.innerHTML = `${BEE}<span></span>`;
      activity = 'The hive is working';
      liveCost = null;
      messages.append(working);
      renderWorking();
      scroll();
    }
    if (!busy && working) {
      working.remove();
      working = null;
    }
  }

  function setPicked(next: PickedElement | null): void {
    picked = next;
    pickedChip.hidden = !next;
    if (next) {
      pickedChip.querySelector('span')!.textContent = `<${next.tag}> ${next.text || next.selector}`;
      // Where the element is written, when the project has source tags.
      const src = pickedChip.querySelector<HTMLElement>('.src')!;
      src.textContent = shortSrc(next.src) ?? '';
      src.title = next.src ? `Written in ${next.src}` : '';
    }
  }

  function setOpen(open: boolean): void {
    panel.hidden = !open;
    q<HTMLElement>('.root').classList.toggle('open', open);
    launcher.setAttribute('aria-label', open ? 'Close Hivebubble chat' : 'Open Hivebubble chat');
    store.set('open', open ? '1' : '0');
    if (open) {
      showEmpty();
      scroll();
      textarea.focus();
    }
  }

  function setMode(next: Mode): void {
    mode = next;
    store.set('mode', next);
    shadow.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === next)));
  }

  function setThinkHarder(on: boolean): void {
    thinkHarder = on;
    thinkBtn.setAttribute('aria-pressed', String(on));
  }

  function setAgent(next: AgentKind): void {
    agent = next;
    const noKey = next === 'missing-key' || next === 'invalid-key';
    agentChip.hidden = next === 'claude';
    agentChip.classList.toggle('off', noKey);
    agentChip.textContent = next === 'mock' ? 'Demo mode' : next === 'missing-key' ? 'No API key' : next === 'invalid-key' ? 'Key rejected' : '';
    banner.hidden = !noKey;
    banner.textContent =
      next === 'invalid-key'
        ? 'Anthropic rejected your API key. Paste a working key in the Hivebubble app, then restart the project.'
        : 'Add your Anthropic API key in the Hivebubble app (or ANTHROPIC_API_KEY in .env.local) so Claude can make changes.';
  }

  function setSpend(spend: SpendSummary): void {
    spendChip.hidden = agent !== 'claude';
    spendChip.textContent = `${money(spend.todayUsd)} today`;
    spendChip.classList.toggle('off', spend.remainingUsd < 0.01);
    spendChip.title =
      `Today: ${money(spend.todayUsd)} of your ${money(spend.dailyCapUsd)} daily limit (${spend.todayTasks} task${spend.todayTasks === 1 ? '' : 's'}). ` +
      `This month: ${money(spend.monthUsd)} across ${spend.monthTasks} task${spend.monthTasks === 1 ? '' : 's'}.`;
  }

  function checkBadges(results: CheckResult[]): HTMLElement {
    const row = document.createElement('span');
    row.className = 'checks';
    for (const r of results) {
      const badge = document.createElement('span');
      badge.className = `check ${r.skipped ? 'skipped' : r.ok ? 'ok' : 'failed'}`;
      badge.textContent = `${r.skipped ? '–' : r.ok ? '✓' : '✗'} ${CHECK_NAMES[r.check]}`;
      badge.title = r.skipped ? `Skipped: ${r.skipped}` : r.ok ? `The ${CHECK_NAMES[r.check]} check passed.` : (r.detail ?? 'Failed.');
      row.append(badge);
    }
    return row;
  }

  // ---- connection --------------------------------------------------------
  const connection = new Connection(onEvent, (open) => {
    conn.hidden = open;
  });

  function onEvent(e: ServerEvent): void {
    switch (e.type) {
      case 'hello':
        messages.replaceChildren();
        working = null;
        setAgent(e.agent);
        for (const entry of e.history) addMessage(entry.role, entry.text, entry.route);
        swarm.sourceTags = e.sourceTags;
        setSpend(e.spend);
        setBusy(e.busy);
        if (e.busy) swarm.launch(SWARM_SIZE[taskEffort]);
        undoBtn.disabled = !e.canUndo;
        // A new app: what was asked for when creating it waits in the message box.
        if (e.draft && !textarea.value.trim()) {
          textarea.value = e.draft;
          setOpen(true);
        }
        if (!panel.hidden) showEmpty();
        break;
      case 'user':
        addMessage('user', e.text, e.route);
        taskEffort = e.route.effort;
        break;
      case 'say':
        addMessage(e.role, e.text);
        break;
      case 'status':
        setBusy(e.state === 'working');
        if (e.state === 'working') swarm.launch(SWARM_SIZE[taskEffort]);
        break;
      case 'tool':
        swarm.tool(e);
        break;
      case 'check':
        swarm.check(e);
        break;
      case 'cost':
        liveCost = e.usd;
        renderWorking();
        break;
      case 'retry': {
        addMessage('system', `↻ ${e.reason}`);
        taskEffort = e.route.effort;
        break;
      }
      case 'confirm': {
        const answer = (ok: boolean) => () => connection.send({ type: 'confirm', id: e.id, ok });
        if (e.kind === 'skill') {
          const s = e.skill;
          const by = `${s.author}, ${s.license} license${s.verified ? ', reviewed for Hivebubble' : ', not reviewed'}`;
          const card = addCard(`The “${s.title}” skill could help with this: ${s.description} (${by}.) Add it to this project?`, [
            { label: 'Add it', primary: true, onClick: answer(true) },
            { label: 'Not now', onClick: answer(false) },
          ]);
          const link = document.createElement('a');
          link.href = s.url;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = 'See its files';
          card.querySelector('.actions')!.append(link);
        } else {
          const { route, estimate, spend } = e;
          const guess = estimate.basis === 'typical' ? ' (a rough guess until Hivebubble has seen a few of yours)' : ', based on your past tasks like it';
          const left = `You have ${money(spend.remainingUsd)} left of today's ${money(spend.dailyCapUsd)} limit.`;
          addCard(`This is a big job (${route.label} effort). It usually costs ${money(estimate.lowUsd)}–${money(estimate.highUsd)}${guess}. ${left} Start it?`, [
            { label: 'Start', primary: true, onClick: answer(true) },
            { label: 'Not now', onClick: answer(false) },
          ]);
        }
        if (panel.hidden) setOpen(true);
        break;
      }
      case 'paused':
      case 'spend':
        setSpend(e.spend);
        break;
      case 'deploy-info':
        deployView.setInfo(e);
        break;
      case 'deploy':
        deployView.progress(e);
        swarm.deploy(e);
        if (e.phase === 'live' || e.phase === 'failed') swarm.finish();
        break;
      case 'done': {
        swarm.finish();
        undoBtn.disabled = !e.canUndo;
        if (!e.ok && e.summary && lastText() !== e.summary) addMessage('system', e.summary, undefined, true);
        if (e.durationMs === 0 && !e.checks) break; // Never started (paused, declined, no key).
        const meta = document.createElement('div');
        meta.className = 'meta';
        const parts = [`${e.ok ? 'Done' : 'Stopped'} in ${(e.durationMs / 1000).toFixed(1)}s`];
        if (e.costUsd !== undefined) parts.push(money(e.costUsd));
        if (e.attempts && e.attempts > 1) parts.push(`${e.attempts} tries`);
        meta.append(document.createTextNode(parts.join(' · ')));
        if (e.checks?.length) meta.append(checkBadges(e.checks));
        if (e.canUndo) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'icon-btn';
          b.innerHTML = `${UNDO}<span class="txt">Undo</span>`;
          b.addEventListener('click', () => connection.send({ type: 'undo' }));
          meta.append(b);
        }
        append(meta);
        break;
      }
      case 'undone':
        undoBtn.disabled = !e.canUndo;
        break;
      case 'undo-conflict': {
        const names = e.files.map((f) => f.split('/').pop()).join(', ');
        addCard(`${names} changed after that task (maybe by hand). Undo anyway? Those later changes would be lost.`, [
          { label: 'Undo anyway', primary: true, onClick: () => connection.send({ type: 'undo', force: true }) },
          { label: 'Keep them', onClick: () => undefined },
        ]);
        if (panel.hidden) setOpen(true);
        break;
      }
      case 'error':
        addMessage('system', e.message, undefined, true);
        break;
      case 'route':
        break;
    }
  }

  // Errors on the page while a task runs go to the engine: the page check counts
  // the ones that come from files the task changed.
  window.addEventListener('error', (ev) => {
    if (!busy) return;
    const where = ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : '';
    const stack = ev.error instanceof Error && ev.error.stack ? ev.error.stack : '';
    connection.send({ type: 'page-error', message: ev.message || String(ev.error), source: `${where}\n${stack}`.trim() });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    if (!busy) return;
    const reason = ev.reason instanceof Error ? ev.reason : null;
    connection.send({ type: 'page-error', message: reason ? reason.message : String(ev.reason), source: reason?.stack });
  });

  // ---- actions -----------------------------------------------------------
  function send(): void {
    if (busy) {
      connection.send({ type: 'stop' });
      return;
    }
    const text = textarea.value.trim();
    if (!text) return;
    connection.send({ type: 'chat', text, element: picked ?? undefined, mode, thinkHarder: thinkHarder || undefined });
    textarea.value = '';
    // Think harder applies to one message.
    setThinkHarder(false);
  }

  function beginPick(): void {
    if (stopPicking) return;
    setOpen(false);
    pickHint.hidden = false;
    stopPicking = startPicker(
      host,
      pickBox,
      (el) => {
        stopPicking = null;
        pickHint.hidden = true;
        setPicked(describeElement(el));
        setOpen(true);
      },
      () => {
        stopPicking = null;
        pickHint.hidden = true;
        setOpen(true);
      },
    );
  }

  launcher.addEventListener('click', () => setOpen(Boolean(panel.hidden)));
  q<HTMLButtonElement>('.close').addEventListener('click', () => setOpen(false));
  sendBtn.addEventListener('click', send);
  undoBtn.addEventListener('click', () => connection.send({ type: 'undo' }));
  pickBtn.addEventListener('click', beginPick);
  q<HTMLButtonElement>('.online').addEventListener('click', () => (q<HTMLElement>('.deploy').hidden ? showDeploy() : showChat()));
  thinkBtn.addEventListener('click', () => setThinkHarder(!thinkHarder));
  q<HTMLButtonElement>('.unpick').addEventListener('click', () => setPicked(null));
  shadow.querySelectorAll<HTMLButtonElement>('.modes button').forEach((b) =>
    b.addEventListener('click', () => setMode(b.dataset.mode as Mode)),
  );
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  setMode(mode);
  if (store.get('open') === '1') setOpen(true);
}

function safeQuery(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}
