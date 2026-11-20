import type { ClientMessage, HostCard, HostId, ServerEvent } from '../../core/src/types';
import { el } from './dom';
import { STEP_ART } from './icons';

type InfoEvent = Extract<ServerEvent, { type: 'deploy-info' }>;
type DeployEvent = Extract<ServerEvent, { type: 'deploy' }>;

const PHASES: Array<{ id: 'build' | 'upload' | 'live'; label: string; art: keyof typeof STEP_ART }> = [
  { id: 'build', label: 'Build it here first', art: 'build' },
  { id: 'upload', label: 'Upload the files', art: 'upload' },
  { id: 'live', label: 'Go live', art: 'live' },
];

/**
 * The deploy wizard inside the bubble (README §9): host cards, connecting the
 * account, what the app needs, then build → upload → live with a QR code and
 * custom-domain steps. Every step comes from the engine's real progress.
 */
export class DeployView {
  private info: InfoEvent | null = null;
  private host: HostId | null = null;
  /** Fresh host info only redraws the host screen, never progress or a result. */
  private screen: 'hosts' | 'progress' | 'result' = 'hosts';
  private readonly body: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly send: (msg: ClientMessage) => void,
    private readonly askHive: (text: string) => void,
    onBack: () => void,
  ) {
    const head = el('div', 'deploy-head');
    const back = el('button', 'link', '← Back to the chat');
    back.type = 'button';
    back.addEventListener('click', onBack);
    head.append(back, el('h2', '', 'Put it online'));
    this.body = el('div', 'deploy-body');
    root.append(head, this.body);
  }

  open(): void {
    if (this.screen === 'result') this.screen = 'hosts';
    this.send({ type: 'deploy-info' });
    if (!this.info) this.body.replaceChildren(el('p', 'muted', 'Checking your hosting accounts…'));
    else if (this.screen === 'hosts') this.render();
  }

  setInfo(info: InfoEvent): void {
    this.info = info;
    if (!this.host || !info.hosts.some((h) => h.id === this.host)) this.host = info.hosts.find((h) => h.recommended)?.id ?? info.hosts[0]?.id ?? null;
    if (this.screen === 'hosts') this.render();
  }

  private card(h: HostCard): HTMLElement {
    const card = el('button', `host${h.id === this.host ? ' selected' : ''}`);
    card.type = 'button';
    card.setAttribute('aria-pressed', String(h.id === this.host));
    const top = el('span', 'top');
    top.append(el('strong', '', h.name));
    if (h.recommended) top.append(el('span', 'badge', h.lastUrl ? 'Used last time' : 'Recommended'));
    card.append(
      top,
      el('span', 'best', h.bestFor),
      el('span', 'meta', `${h.freePlan} · ${h.steps} steps · ${h.time}`),
      el('span', `state ${h.connected ? 'ok' : ''}`, h.connected ? '✓ Account connected' : 'Not connected yet'),
    );
    card.addEventListener('click', () => {
      if (this.screen !== 'hosts') return;
      this.host = h.id;
      this.render();
    });
    return card;
  }

  private step(art: keyof typeof STEP_ART, title: string, ...content: Node[]): HTMLElement {
    const box = el('div', 'step');
    const pic = el('div', 'art');
    pic.innerHTML = STEP_ART[art];
    const text = el('div', 'text');
    text.append(el('h3', '', title), ...content);
    box.append(pic, text);
    return box;
  }

  private render(): void {
    const info = this.info;
    this.body.replaceChildren();
    if (!info) return;
    if (!info.supported) {
      this.body.append(el('p', 'note', `${info.why ?? 'This project can’t be put online from here yet'}.`));
      return;
    }
    const cards = el('div', 'hosts');
    for (const h of info.hosts) cards.append(this.card(h));
    this.body.append(el('p', 'muted', '1. Pick where it should live.'), cards);
    const host = info.hosts.find((h) => h.id === this.host);
    if (!host) return;

    // 2. Connect.
    if (host.connected) {
      this.body.append(this.step('connect', '2. Your account is connected', el('p', 'muted', `Hivebubble uses the ${host.name} token from your Keychain.`)));
    } else {
      const list = el('ol', 'mini');
      for (const s of host.connectSteps) list.append(el('li', '', s));
      const link = el('a', '', `Open ${host.name}’s token page`);
      link.href = host.tokenUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      const again = el('button', 'link', 'Check again');
      again.type = 'button';
      again.addEventListener('click', () => this.send({ type: 'deploy-info' }));
      const row = el('p', 'row');
      row.append(link, again);
      this.body.append(this.step('connect', `2. Connect your ${host.name} account`, list, row));
    }

    // 3. What the app needs.
    const env = el('ul', 'env');
    for (const n of info.env) {
      const li = el('li', n.set ? 'ok' : 'missing', `${n.set ? '✓' : '!'} ${n.name}`);
      li.title = `Used in ${n.usedIn.join(', ')}`;
      env.append(li);
    }
    const missing = info.env.filter((n) => !n.set);
    const envText = info.env.length === 0
      ? 'It doesn’t read any settings, so there is nothing to set up.'
      : missing.length === 0
        ? 'Every setting it reads is in your .env files, and goes into the build.'
        : `${missing.length} setting${missing.length === 1 ? ' isn’t' : 's aren’t'} in your .env files, so the live site won’t have ${missing.length === 1 ? 'it' : 'them'}.`;
    this.body.append(this.step('build', '3. What the app needs', el('p', 'muted', envText), ...(info.env.length ? [env] : [])));

    // 4. Go.
    const go = el('button', 'primary go', host.lastUrl ? `Update the live site on ${host.name}` : `Build and put it online with ${host.name}`);
    go.type = 'button';
    go.disabled = !host.connected;
    go.addEventListener('click', () => this.start(host.id));
    this.body.append(go);
    if (host.lastUrl) {
      const last = el('p', 'muted small', 'Live now at ');
      last.append(this.link(host.lastUrl));
      this.body.append(last);
    }
  }

  private link(url: string): HTMLElement {
    if (!/^https:\/\//.test(url)) return el('span', '', url);
    const a = el('a', '', url.replace(/^https:\/\//, ''));
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    return a;
  }

  private start(host: HostId): void {
    this.screen = 'progress';
    this.host = host;
    const name = this.info?.hosts.find((h) => h.id === host)?.name ?? host;
    this.body.replaceChildren(el('p', 'muted', `Putting it online with ${name}…`), this.progressList());
    this.send({ type: 'deploy', host });
  }

  private progressList(): HTMLElement {
    const list = el('ol', 'progress');
    for (const p of PHASES) {
      const li = el('li', 'pending');
      li.dataset.phase = p.id;
      const pic = el('span', 'art');
      pic.innerHTML = STEP_ART[p.art];
      const text = el('span', 'text');
      text.append(el('strong', '', p.label), el('span', 'detail', ''));
      const bar = el('span', 'bar');
      bar.append(el('i'));
      li.append(pic, text, bar);
      list.append(li);
    }
    return list;
  }

  progress(e: DeployEvent): void {
    if (this.screen !== 'progress') {
      // Started from another tab: follow along.
      this.screen = 'progress';
      this.body.replaceChildren(el('p', 'muted', 'Putting it online…'), this.progressList());
    }
    const order = ['build', 'upload', 'live'];
    const current = e.phase === 'finalize' ? 'live' : e.phase === 'failed' ? null : e.phase;
    for (const li of Array.from(this.body.querySelectorAll<HTMLElement>('.progress li'))) {
      const p = li.dataset.phase!;
      if (current && order.indexOf(p) < order.indexOf(current)) li.className = 'done';
      if (p === current) {
        li.className = e.phase === 'live' ? 'done' : 'active';
        li.querySelector('.detail')!.textContent = e.message;
        const pct = e.total ? Math.round(((e.done ?? 0) / e.total) * 100) : e.phase === 'live' ? 100 : null;
        const bar = li.querySelector<HTMLElement>('.bar i')!;
        bar.style.transform = `scaleX(${pct === null ? 0.15 : pct / 100})`;
        li.classList.toggle('busy', pct === null && e.phase !== 'live');
      }
    }
    if (e.phase === 'live') this.done(e);
    if (e.phase === 'failed') this.failed(e);
  }

  private done(e: DeployEvent): void {
    this.screen = 'result';
    const host = this.info?.hosts.find((h) => h.id === e.host);
    const intro = this.body.querySelector('p.muted');
    const seconds = e.durationMs ? ` in ${Math.max(1, Math.round(e.durationMs / 1000))} seconds` : '';
    if (intro) intro.textContent = `Online with ${host?.name ?? e.host}${seconds}.`;
    const result = el('div', 'result');
    const url = e.url ?? '';
    const head = el('p', 'live', 'It’s live: ');
    head.append(this.link(url));
    result.append(head);
    if (e.qrSvg && /^<svg[\s>]/.test(e.qrSvg) && !/<script|on\w+=/i.test(e.qrSvg)) {
      const qr = el('div', 'qr');
      qr.innerHTML = e.qrSvg;
      qr.setAttribute('role', 'img');
      qr.setAttribute('aria-label', `QR code for ${url}`);
      result.append(qr, el('p', 'muted small', 'Scan it with your phone to see the site there.'));
    }
    if (host) {
      const domain = el('details', 'domain');
      domain.append(el('summary', '', 'Use your own domain name'));
      const list = el('ol', 'mini');
      for (const s of host.domainSteps) list.append(el('li', '', s));
      domain.append(list);
      if (e.adminUrl && /^https:\/\//.test(e.adminUrl)) {
        const admin = el('p', 'small');
        const a = el('a', '', `Open the site in ${host.name}`);
        a.href = e.adminUrl;
        a.target = '_blank';
        a.rel = 'noreferrer';
        admin.append(a);
        domain.append(admin);
      }
      result.append(domain);
    }
    this.body.append(result);
    // The next time the wizard opens, it shows the new address.
    this.send({ type: 'deploy-info' });
  }

  private failed(e: DeployEvent): void {
    this.screen = 'result';
    const intro = this.body.querySelector('p.muted');
    if (intro) intro.textContent = 'It didn’t go online this time.';
    for (const li of Array.from(this.body.querySelectorAll<HTMLElement>('.progress li.active'))) {
      li.className = 'error';
      li.querySelector('.detail')!.textContent = 'Stopped here';
    }
    const box = el('div', 'failure');
    box.append(el('p', '', e.message));
    if (e.buildLog) {
      const log = el('pre', '', e.buildLog);
      box.append(log);
      const fix = el('button', 'primary', 'Ask the hive to fix the build');
      fix.type = 'button';
      fix.addEventListener('click', () => this.askHive(`The production build fails. Please fix it.\n\n${e.buildLog}`));
      box.append(fix);
    }
    const again = el('button', 'link', 'Back to the hosts');
    again.type = 'button';
    again.addEventListener('click', () => {
      this.screen = 'hosts';
      this.render();
    });
    box.append(again);
    this.body.append(box);
  }
}
