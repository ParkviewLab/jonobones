// Shared glue for the e2e suites: daemon config factory for the
// joplinServer target, an authenticated HTTP client with the
// sync-and-wait-idle pattern, and spawned-daemon helpers (the shipped
// binary in its own process — required wherever a test needs a daemon
// restart, because @joplin/lib is process-global and an in-process
// context can never be torn down and rebuilt).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../src/config/types.js';
import type { JournalEvent } from '../../src/events/journal.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './server.js';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');

export function serverConfig(serverUrl: string, token: string, overrides: Partial<Config> = {}): Config {
  return {
    api: { port: 0, bind: '127.0.0.1', token },
    // interval 0: syncs happen only when a test asks for one, so timer
    // cycles can never interleave with the scenario under test.
    sync: {
      target: 'joplinServer',
      interval: 0,
      url: serverUrl,
      username: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    },
    e2ee: {},
    events: { retentionDays: 30 },
    ...overrides,
  };
}

export interface HttpResult {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface DaemonClient {
  base: string;
  http(method: string, path: string, body?: unknown): Promise<HttpResult>;
  /** POST /sync, then poll /status until idle. Idle ⇒ post-sync scan done. */
  syncAndWaitIdle(): Promise<void>;
  /** Poll /status until the sync state machine reports an error. */
  waitForSyncError(): Promise<string>;
  allEvents(): Promise<JournalEvent[]>;
}

export function createClient(base: string, token: string): DaemonClient {
  async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text === '' ? null : JSON.parse(text) };
  }

  return {
    base,
    http,
    async syncAndWaitIdle() {
      await http('POST', '/sync');
      for (let i = 0; i < 240; i++) {
        const status = await http('GET', '/status');
        if (status.body.sync.state === 'idle' && status.body.sync.lastCompletedAt) return;
        if (status.body.sync.state === 'error') throw new Error(status.body.sync.lastResult);
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('sync did not reach idle');
    },
    async waitForSyncError() {
      for (let i = 0; i < 240; i++) {
        const status = await http('GET', '/status');
        if (status.body.sync.state === 'error') return status.body.sync.lastResult as string;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('sync did not reach the error state');
    },
    async allEvents() {
      const out: JournalEvent[] = [];
      let cursor = 0;
      for (;;) {
        const page = await http('GET', `/events?cursor=${cursor}&limit=1000`);
        out.push(...page.body.items);
        if (!page.body.has_more) return out;
        cursor = page.body.cursor;
      }
    },
  };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Write the minimal config.json5 a spawned daemon needs for target 9. */
export function writeDaemonConfig(
  profileDir: string,
  opts: { port: number; token: string; serverUrl: string },
): void {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(profileDir, 'config.json5'),
    JSON.stringify({
      api: { port: opts.port, bind: '127.0.0.1', token: opts.token },
      sync: {
        target: 'joplinServer',
        interval: 0,
        url: opts.serverUrl,
        username: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      },
    }),
    { mode: 0o600 },
  );
}

export interface SpawnedDaemon {
  output: string[];
  /** SIGTERM; resolves with the exit code (0 = clean shutdown). */
  stop(): Promise<number | null>;
}

/** Spawn `bin/jonobones.js start` on an existing profile; resolves once /v1/health serves. */
export async function spawnDaemon(profileDir: string, port: number): Promise<SpawnedDaemon> {
  const proc = spawn(process.execPath, [join(repoRoot, 'bin', 'jonobones.js'), 'start', '--profile', profileDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  proc.stdout.on('data', (c: Buffer) => output.push(c.toString('utf8')));
  proc.stderr.on('data', (c: Buffer) => output.push(c.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`spawned daemon never served /v1/health\n${output.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    output,
    stop: () => {
      proc.kill('SIGTERM');
      return exited;
    },
  };
}
