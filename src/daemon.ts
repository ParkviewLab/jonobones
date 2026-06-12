import { mkdirSync } from 'node:fs';
import { buildServer, startServer } from './api/server.js';
import { acquireLock, releaseLock } from './config/lockfile.js';
import type { Config } from './config/types.js';
import { bootstrapJoplin, type JoplinContext } from './joplin/bootstrap.js';
import {
  SyncRunner,
  applyE2eePassword,
  applySyncTarget,
  resolveSyncTarget,
  type ResolvedSyncTarget,
} from './joplin/sync.js';
import { SyncScheduler } from './sync/scheduler.js';
import { VERSION } from './version.js';
import type { FastifyInstance } from 'fastify';
import type { SyncRunResult } from './joplin/sync.js';

export interface DaemonHandle {
  app: FastifyInstance;
  joplin: JoplinContext;
  scheduler: SyncScheduler;
  address: string;
  port: number;
  stop(): Promise<void>;
}

export interface StartDaemonOptions {
  profileDir: string;
  config: Config;
  // Tests run on ephemeral ports/profiles and skip the lockfile.
  writeLock?: boolean;
  // Suppress the immediate first sync (the interval and POST /sync still work).
  autoSync?: boolean;
  onSyncCycle?: (result: SyncRunResult) => void;
}

export async function startDaemon({
  profileDir,
  config,
  writeLock = true,
  autoSync = true,
  onSyncCycle,
}: StartDaemonOptions): Promise<DaemonHandle> {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  // Lock first: refuse to double-open the profile before touching SQLite.
  if (writeLock) {
    acquireLock(profileDir, {
      pid: process.pid,
      port: config.api.port,
      token: config.api.token ?? '',
      profile: profileDir,
      startedAt: new Date().toISOString(),
      version: VERSION,
    });
  }

  let joplin: JoplinContext;
  try {
    joplin = await bootstrapJoplin({ profileDir });
  } catch (error) {
    if (writeLock) releaseLock(profileDir);
    throw error;
  }

  // Sync target config is canonical in config.json5; re-apply each boot.
  let resolved: ResolvedSyncTarget | null;
  let runner: SyncRunner | null = null;
  try {
    resolved = resolveSyncTarget(config.sync);
    if (resolved) {
      applySyncTarget(joplin, resolved);
      if (config.e2ee.masterPassword) await applyE2eePassword(joplin, config.e2ee.masterPassword);
      runner = new SyncRunner(joplin, resolved.spec);
    }
  } catch (error) {
    await joplin.shutdown();
    if (writeLock) releaseLock(profileDir);
    throw error;
  }

  const scheduler = new SyncScheduler(runner, config.sync.interval, {
    onCycleComplete: (result) => onSyncCycle?.(result),
  });
  if (autoSync) scheduler.start();

  const app = buildServer(config, joplin, { scheduler, syncSpec: resolved?.spec ?? null });

  let address: string;
  try {
    address = await startServer(app, config);
  } catch (error) {
    await scheduler.stop();
    await joplin.shutdown();
    if (writeLock) releaseLock(profileDir);
    throw error;
  }

  const port = parseInt(new URL(address).port, 10);

  let stopped = false;
  return {
    app,
    joplin,
    scheduler,
    address,
    port,
    async stop() {
      if (stopped) return;
      stopped = true;
      await app.close();
      await scheduler.stop();
      await joplin.shutdown();
      if (writeLock) releaseLock(profileDir);
    },
  };
}
