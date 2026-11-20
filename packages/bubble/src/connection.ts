import type { ClientMessage, ServerEvent } from '../../core/src/types';
import { socketUrl, type EngineConfig } from './config';

/** WebSocket to the Hivebubble engine, with automatic reconnects (the dev server can restart). */
export class Connection {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private attempts = 0;

  constructor(
    private readonly onEvent: (event: ServerEvent) => void,
    private readonly onState: (open: boolean) => void,
    private readonly config: EngineConfig = { origin: null, token: null },
  ) {
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
      this.onState(false);
      const delay = Math.min(5000, 400 * 2 ** this.attempts++);
      setTimeout(() => this.open(), delay);
    };
  }

  send(msg: ClientMessage): void {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }
}
