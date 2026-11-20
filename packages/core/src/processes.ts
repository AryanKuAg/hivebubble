import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import type { CommandSpec } from './project.js';

/**
 * A child process in its own process group, so stopping it also stops what it
 * started (npm → vite, npm → next, …).
 */
export class ManagedProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  private alive = true;

  constructor(spec: CommandSpec, cwd: string, onLine: (line: string) => void) {
    this.child = spawn(spec.cmd, spec.args, {
      cwd,
      env: { ...process.env, ...spec.env, FORCE_COLOR: '0' },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      if (!stream) continue;
      readline.createInterface({ input: stream }).on('line', (line) => onLine(stripAnsi(line)));
    }
    this.exited = new Promise((resolve) => {
      this.child.on('error', (err) => {
        onLine(`Could not start "${spec.cmd}": ${err.message}`);
        this.alive = false;
        resolve(null);
      });
      this.child.on('exit', (code) => {
        this.alive = false;
        resolve(code);
      });
    });
  }

  get running(): boolean {
    return this.alive;
  }

  async stop(): Promise<void> {
    if (!this.alive || this.child.pid === undefined) return;
    this.signal('SIGTERM');
    const timer = setTimeout(() => this.signal('SIGKILL'), 3000);
    await this.exited;
    clearTimeout(timer);
  }

  private signal(sig: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === 'win32') this.child.kill(sig);
      else process.kill(-pid, sig);
    } catch {
      // Already gone.
    }
  }
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      // No IPv6 on this machine means nothing can be using ::1.
      resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT');
    });
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/**
 * True when nothing is listening on the port on either loopback address. Dev
 * servers bind "localhost", which can be 127.0.0.1 or ::1, so both are checked,
 * plus a connection attempt for servers bound to other addresses.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (await canConnect(port)) return false;
  return (await canBind(port, '127.0.0.1')) && (await canBind(port, '::1'));
}

export async function findFreePort(start: number, tries = 50): Promise<number> {
  for (let port = start; port < start + tries; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port between ${start} and ${start + tries - 1}.`);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: 'localhost', port, autoSelectFamily: true });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

/** Wait until something accepts connections on the port, or give up. */
export async function waitForPort(port: () => number, timeoutMs: number, stillRunning: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillRunning()) return false;
    if (await canConnect(port())) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
