// Joplin Server lifecycle for the e2e tier: one Docker container per suite
// file, plus the minimal slice of the server's own HTTP API the tests need
// (session login, raw item content, server-side permanent delete).

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

// Pinned for reproducibility; the CI workflow sets the same value as an
// env var so its image cache and the suite can never disagree.
export const JOPLIN_SERVER_IMAGE = process.env.JOPLIN_SERVER_IMAGE ?? 'joplin/server:3.7.1';

// The image's seeded admin account. Verified against the server source: the
// initial migration inserts it with no must-set-password or email gate, so
// clients can sync as admin with zero web-UI interaction.
export const ADMIN_EMAIL = 'admin@localhost';
export const ADMIN_PASSWORD = 'admin';

export function hasDocker(): boolean {
  const res = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return res.status === 0;
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 300_000 });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPing(url: string, timeoutMs: number, containerName?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body.status === 'ok') return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      let logs = '';
      if (containerName) {
        try {
          logs = execFileSync('docker', ['logs', '--tail', '30', containerName], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {
          /* container gone */
        }
      }
      throw new Error(`Joplin Server at ${url} did not become ready in ${timeoutMs}ms\n${logs}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The slice of Joplin Server's API the tests drive directly. */
export class JoplinServerApi {
  private sessionId: string | null = null;

  public constructor(private readonly url: string) {}

  // POST /api/sessions is brute-force rate-limited — log in once, cache.
  private async session(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const res = await fetch(`${this.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    if (!res.ok) throw new Error(`server login failed: ${res.status} ${await res.text()}`);
    this.sessionId = ((await res.json()) as { id: string }).id;
    return this.sessionId;
  }

  /**
   * Permanently delete a synced item server-side (e.g. `<noteId>.md`). The
   * server records a delta Delete change, so syncing clients drop the item —
   * the server-target equivalent of deleting a file from a filesystem target.
   */
  public async deleteItem(name: string): Promise<void> {
    const res = await fetch(`${this.url}/api/items/root:/${name}:`, {
      method: 'DELETE',
      headers: { 'X-API-AUTH': await this.session() },
    });
    if (!res.ok) throw new Error(`deleteItem(${name}) failed: ${res.status} ${await res.text()}`);
  }

  /** Raw content of a synced item as stored on the server. */
  public async getItemContent(name: string): Promise<string> {
    const res = await fetch(`${this.url}/api/items/root:/${name}:/content`, {
      headers: { 'X-API-AUTH': await this.session() },
    });
    if (!res.ok) throw new Error(`getItemContent(${name}) failed: ${res.status} ${await res.text()}`);
    return res.text();
  }
}

export interface JoplinServerHandle {
  url: string;
  port: number;
  name: string;
  api: JoplinServerApi;
  /** docker stop — data persists; for outage scenarios. */
  pause(): Promise<void>;
  /** docker start + wait ready. */
  resume(): Promise<void>;
  /** docker rm -f — gone for good. */
  stop(): Promise<void>;
}

export async function startJoplinServer(): Promise<JoplinServerHandle> {
  try {
    docker('image', 'inspect', JOPLIN_SERVER_IMAGE);
  } catch {
    docker('pull', JOPLIN_SERVER_IMAGE);
  }

  const port = await freePort();
  const name = `jb-e2e-${randomBytes(3).toString('hex')}`;
  const url = `http://127.0.0.1:${port}`;
  // No --rm: it would auto-remove on `docker stop` (breaking pause/resume)
  // and still leak if vitest is SIGKILLed; the global-setup sweep handles
  // cleanup via the label instead.
  docker(
    'run',
    '-d',
    '--label',
    'jonobones-e2e',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:22300`,
    '-e',
    `APP_BASE_URL=${url}`,
    // Joplin's own test switch: disables the per-IP login brute-force
    // limiter (10/min). Every `joplin sync` is a fresh CLI process doing
    // its own POST /api/sessions, so a normal suite cadence would exhaust
    // the limit and later syncs would fail silently (the CLI exits 0).
    '-e',
    'JOPLIN_IS_TESTING=1',
    JOPLIN_SERVER_IMAGE,
  );
  await waitForPing(url, 120_000, name);

  return {
    url,
    port,
    name,
    api: new JoplinServerApi(url),
    pause: async () => {
      docker('stop', name);
    },
    resume: async () => {
      docker('start', name);
      await waitForPing(url, 60_000, name);
    },
    stop: async () => {
      try {
        docker('rm', '-f', name);
      } catch {
        /* already gone */
      }
    },
  };
}
