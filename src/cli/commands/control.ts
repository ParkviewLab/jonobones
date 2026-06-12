// stop / status / sync — the control-plane commands that talk to a running
// daemon via its lockfile (pid, port, token).

import { resolveProfileDir } from '../../config/profile.js';
import { readLock, isProcessAlive } from '../../config/lockfile.js';
import type { CliFlags } from '../../config/types.js';
import { daemonRequest, findRunningDaemon } from '../daemon-client.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function commandStop(flags: CliFlags): Promise<void> {
  const profileDir = resolveProfileDir(flags.profile);
  const lock = readLock(profileDir);
  if (!lock || !isProcessAlive(lock.pid)) {
    console.log('jonobones is not running.');
    return;
  }

  process.kill(lock.pid, 'SIGTERM');
  for (let i = 0; i < 40; i++) {
    if (!isProcessAlive(lock.pid)) {
      console.log(`stopped (pid ${lock.pid}).`);
      return;
    }
    await sleep(250);
  }
  console.error(`pid ${lock.pid} did not exit within 10s; it may still be shutting down.`);
  process.exit(1);
}

export async function commandStatus(flags: CliFlags): Promise<void> {
  const profileDir = resolveProfileDir(flags.profile);
  const conn = findRunningDaemon(profileDir);
  if (!conn) {
    console.log(`jonobones is not running (profile: ${profileDir})`);
    process.exit(1);
  }

  console.log(`running: pid ${conn.lock.pid}, ${conn.base} (since ${conn.lock.startedAt}, v${conn.lock.version})`);
  const res = await daemonRequest(conn, 'GET', '/status');
  if (res.status !== 200) {
    console.error(`GET /status returned ${res.status}: ${JSON.stringify(res.body)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(res.body, null, 2));
}

export async function commandSync(flags: CliFlags): Promise<void> {
  const profileDir = resolveProfileDir(flags.profile);
  const conn = findRunningDaemon(profileDir);
  if (!conn) {
    console.error(`jonobones is not running (profile: ${profileDir}) — start it first`);
    process.exit(1);
  }

  const res = await daemonRequest(conn, 'POST', '/sync');
  const body = res.body as { alreadyRunning?: boolean } | null;
  if (res.status !== 202) {
    console.error(`POST /sync returned ${res.status}: ${JSON.stringify(res.body)}`);
    process.exit(1);
  }
  console.log(body?.alreadyRunning ? 'a sync is already running.' : 'sync triggered.');
  console.log('check progress with: jonobones status');
}
