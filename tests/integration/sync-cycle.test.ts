import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import type { Config } from '../../src/config/types.js';

const TOKEN = 'sync-test-token';
const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const spikePath = join(repoRoot, 'spike', 'lib-spike.mjs');

let workDir: string;
let profileDir: string;
let peerProfileDir: string;
let syncDir: string;
let daemon: DaemonHandle;
let base: string;

function runPeer(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [spikePath, ...args], { encoding: 'utf8' });
}

async function http(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

async function syncAndWaitIdle(): Promise<void> {
  await http('POST', '/sync');
  for (let i = 0; i < 120; i++) {
    const status = await http('GET', '/status');
    const sync = status.body.sync;
    if (sync.state === 'idle' && sync.lastCompletedAt) return;
    if (sync.state === 'error') throw new Error(`sync errored: ${sync.lastResult}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('sync did not reach idle in time');
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'jonobones-sync-test-'));
  profileDir = join(workDir, 'daemon-profile');
  peerProfileDir = join(workDir, 'peer-profile');
  syncDir = join(workDir, 'sync-target');

  // A second, independent Joplin-lib client seeds the target first.
  const seed = runPeer(['seed', '--profile', peerProfileDir, '--sync-dir', syncDir, '--title', 'from-peer']);
  expect(seed.status).toBe(0);

  const config: Config = {
    api: { port: 0, bind: '127.0.0.1', token: TOKEN },
    sync: { target: 'filesystem', interval: 0, path: syncDir }, // interval 0: on-demand only (test drives syncs)
    e2ee: {},
    events: { retentionDays: 30 },
  };
  daemon = await startDaemon({ profileDir, config, writeLock: false, autoSync: false });
  base = `http://127.0.0.1:${daemon.port}/v1`;
}, 120_000);

afterAll(async () => {
  await daemon?.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe('sync cycle', () => {
  it('starts unconfigured-free: /status reports the filesystem target', async () => {
    const res = await http('GET', '/status');
    expect(res.status).toBe(200);
    expect(res.body.sync.target).toBe('filesystem');
    expect(res.body.profile.schemaVersion).toBeGreaterThan(40);
    expect(res.body.e2ee.enabled).toBe(false);
  });

  it('pulls what the peer pushed', { timeout: 60_000 }, async () => {
    await syncAndWaitIdle();
    const found = await http('GET', '/search?q=from-peer&fields=id,title');
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0].title).toBe('from-peer');
  });

  it('pushes API writes back to the target, and the peer sees them', { timeout: 60_000 }, async () => {
    const nb = (await http('POST', '/notebooks', { title: 'daemon-side' })).body;
    await http('POST', '/notes', { title: 'from-daemon', body: 'pushed by jonobones', parent_id: nb.id });

    await syncAndWaitIdle();

    // The target dir must look like a stock Joplin sync target.
    const entries = readdirSync(syncDir);
    expect(entries).toContain('info.json');
    expect(entries.filter((e) => e.endsWith('.md')).length).toBeGreaterThanOrEqual(4);

    const peer = runPeer(['expect', '--profile', peerProfileDir, '--sync-dir', syncDir, '--title', 'from-daemon']);
    if (peer.status !== 0) {
      console.error(peer.stdout);
      console.error(peer.stderr);
    }
    expect(peer.status).toBe(0);
  });

  it('reports pendingUpload after an unsynced write', async () => {
    await http('POST', '/notebooks', { title: 'not yet pushed' });
    const status = await http('GET', '/status');
    expect(status.body.sync.pendingUpload).toBeGreaterThanOrEqual(1);
  });

  it('POST /sync answers 202 and tolerates double triggers', async () => {
    const [a, b] = await Promise.all([http('POST', '/sync'), http('POST', '/sync')]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    await syncAndWaitIdle();
  });
});
