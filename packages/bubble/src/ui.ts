import type { AgentKind, ChatEntry, Effort, Mode, PickedElement, Route, ServerEvent } from '../../core/src/types';
import { Connection } from './connection';
import { BEE, CLOSE, HIVE, HIVE_ENTRANCE, PICK, SEND, STOP, UNDO } from './icons';
import { describeElement, startPicker } from './picker';
import { SWARM_SIZE, Swarm, describeTool } from './swarm';
import { CSS } from './styles';

const TEMPLATE = `
<style>${CSS}</style>
<div class="root">
  <div class="layer"></div>
  <ul class="tray" hidden></ul>
  <div class="pick-box" hidden></div>
  <div class="pick-hint" hidden>Click the part of the page you want to change · Esc to cancel</div>
  <section class="panel" role="dialog" aria-label="Hivebubble chat" hidden>
    <header>
      <div class="brand">${HIVE}<span>Hivebubble</span><span class="chip agent" hidden></span></div>
      <span class="conn" hidden>Reconnecting…</span>
      <button class="icon-btn undo" type="button" disabled title="Undo the last change">${UNDO}<span class="txt">Undo</span></button>
      <button class="icon-btn close" type="button" aria-label="Close chat">${CLOSE}</button>
    </header>
    <div class="banner" hidden></div>
    <div class="messages" aria-live="polite"></div>
    <div class="composer">
      <div class="picked" hidden><span></span><button class="icon-btn unpick" type="button" aria-label="Remove picked element">${CLOSE}</button></div>
      <textarea rows="2" placeholder="Tell the hive what to change…" aria-label="Message"></textarea>
      <div class="row">
        <button class="icon-btn pick" type="button" title="Pick an element on the page">${PICK}<span class="txt">Pick</span></button>
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
  const pickedChip = q<HTMLElement>('.picked');
  const banner = q<HTMLElement>('.banner');
  const agentChip = q<HTMLElement>('.agent');
  const conn = q<HTMLElement>('.conn');
  const pickBox = q<HTMLElement>('.pick-box');
  const pickHint = q<HTMLElement>('.pick-hint');

  let busy = false;
  let picked: PickedElement | null = null;
  let stopPicking: (() => void) | null = null;
  let working: HTMLElement | null = null;
  let mode: Mode = (store.get('mode') as Mode) || 'balanced';
  let taskEffort: Effort = 'medium';

  const swarm = new Swarm(
    q<HTMLElement>('.layer'),
    q<HTMLElement>('.tray'),
    () => {
      // Bees leave from, and return to, the hive's entrance hole.
      const r = launcher.querySelector('.hive')!.getBoundingClientRect();
      return { x: r.left + r.width * HIVE_ENTRANCE.x, y: r.top + r.height * HIVE_ENTRANCE.y };
    },
    () => (picked ? safeQuery(picked.selector) : null),
  );

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

  function addMessage(role: ChatEntry['role'], text: string, route?: Route, error = false): void {
    clearEmpty();
    const el = document.createElement('div');
    el.className = `msg ${role}${error ? ' error' : ''}`;
    el.textContent = text;
    messages.append(el);
    if (route) {
      const chip = document.createElement('div');
      chip.className = 'route';
      chip.textContent = `${route.label} · ${route.effort} effort`;
      chip.title = route.reason;
      messages.append(chip);
    }
    if (working) messages.append(working);
    scroll();
  }

  function lastText(): string {
    const msgs = messages.querySelectorAll('.msg');
    return msgs.length ? (msgs[msgs.length - 1].textContent ?? '') : '';
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
      working.innerHTML = `${BEE}<span>The hive is working…</span>`;
      messages.append(working);
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
      const span = pickedChip.querySelector('span')!;
      span.textContent = `<${next.tag}> ${next.text || next.selector}`;
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

  function setAgent(agent: AgentKind): void {
    const noKey = agent === 'missing-key' || agent === 'invalid-key';
    agentChip.hidden = agent === 'claude';
    agentChip.classList.toggle('off', noKey);
    agentChip.textContent = agent === 'mock' ? 'Demo mode' : agent === 'missing-key' ? 'No API key' : agent === 'invalid-key' ? 'Key rejected' : '';
    banner.hidden = !noKey;
    banner.textContent =
      agent === 'invalid-key'
        ? 'Anthropic rejected your API key. Paste a working key in the Hivebubble app, then restart the project.'
        : 'Add your Anthropic API key in the Hivebubble app (or ANTHROPIC_API_KEY in .env.local) so Claude can make changes.';
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
        for (const entry of e.history) addMessage(entry.role, entry.text, entry.route);
        setAgent(e.agent);
        setBusy(e.busy);
        if (e.busy) swarm.launch(SWARM_SIZE[taskEffort]);
        undoBtn.disabled = !e.canUndo;
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
        if (working && e.phase === 'start') working.querySelector('span')!.textContent = `${describeTool(e)}…`;
        break;
      case 'done': {
        swarm.finish();
        undoBtn.disabled = !e.canUndo;
        if (!e.ok && e.summary && lastText() !== e.summary) addMessage('system', e.summary, undefined, true);
        const meta = document.createElement('div');
        meta.className = 'meta';
        const parts = [`${e.ok ? 'Done' : 'Stopped'} in ${(e.durationMs / 1000).toFixed(1)}s`];
        if (e.costUsd !== undefined) parts.push(`$${e.costUsd.toFixed(3)}`);
        meta.append(document.createTextNode(parts.join(' · ')));
        if (e.ok && e.canUndo) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'icon-btn';
          b.innerHTML = `${UNDO}<span class="txt">Undo</span>`;
          b.addEventListener('click', () => connection.send({ type: 'undo' }));
          meta.append(b);
        }
        clearEmpty();
        messages.append(meta);
        scroll();
        break;
      }
      case 'undone':
        undoBtn.disabled = !e.canUndo;
        break;
      case 'error':
        addMessage('system', e.message, undefined, true);
        break;
      case 'route':
        break;
    }
  }

  // ---- actions -----------------------------------------------------------
  function send(): void {
    if (busy) {
      connection.send({ type: 'stop' });
      return;
    }
    const text = textarea.value.trim();
    if (!text) return;
    connection.send({ type: 'chat', text, element: picked ?? undefined, mode });
    textarea.value = '';
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
