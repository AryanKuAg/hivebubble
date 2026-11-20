import type { ClientMessage, ServerEvent } from '../../core/src/types';
import { readPairing, socketUrl, type EngineConfig } from './config';

/** WebSocket to the Hivebubble engine, with automatic reconnects (the dev server can restart). */
export class Connection {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private attempts = 0;
  private lastPairAsk = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onEvent: (event: ServerEvent) => void,
    private readonly onState: (open: boolean) => void,
    private config: EngineConfig = { origin: null, token: null },
  ) {
    if (config.token) {
      // A bubble the browser extension added: when Hivebubble restarts (new secret,
      // maybe a new port), the extension answers with the new pairing.
      document.addEventListener('hivebubble:paired', (e) => {
        const next = readPairing((e as CustomEvent).detail);
        if (!next || (next.origin === this.config.origin && next.token === this.config.token)) return;
        this.config = next;
        this.attempts = 0;
        const live = this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING);
        if (live) {
          this.ws!.close();
        } else {
          // Waiting to retry: go now, to the new address.
          if (this.retry) clearTimeout(this.retry);
          this.open();
        }
      });
    }
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(socketUrl(this.config));
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.onState(true);
      for (const msg of this.queue.splice(0)) ws.send(msg);
    };
    ws.onmessage = (e) => {
      try {
        this.onEvent(JSON.parse(String(e.data)) as ServerEvent);
      } catch {
        // Ignore malformed frames.
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onState(false);
      if (this.config.token && this.attempts >= 1 && Date.now() - this.lastPairAsk > 3000) {
        this.lastPairAsk = Date.now();
        document.dispatchEvent(new CustomEvent('hivebubble:pair'));
      }
      const delay = Math.min(5000, 400 * 2 ** this.attempts++);
      this.retry = setTimeout(() => {
        this.retry = null;
        if (this.ws === ws) this.open();
      }, delay);
    };
  }

  send(msg: ClientMessage): void {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }
}
