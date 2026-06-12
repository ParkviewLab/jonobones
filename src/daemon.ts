import { mkdirSync } from 'node:fs';
import { buildServer, startServer } from './api/server.js';
import { acquireLock, releaseLock } from './config/lockfile.js';
import type { Config } from './config/types.js';
import { bootstrapJoplin, type JoplinContext } from './joplin/bootstrap.js';
import { VERSION } from './version.js';
import type { FastifyInstance } from 'fastify';

export interface DaemonHandle {
  app: FastifyInstance;
  joplin: JoplinContext;
  address: string;
  port: number;
  stop(): Promise<void>;
}

export interface StartDaemonOptions {
  profileDir: string;
  config: Config;
  // Tests run on ephemeral ports/profiles and skip the lockfile.
  writeLock?: boolean;
}

export async function startDaemon({ profileDir, config, writeLock = true }: StartDaemonOptions): Promise<DaemonHandle> {
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

  const app = buildServer(config, joplin);

  let address: string;
  try {
    address = await startServer(app, config);
  } catch (error) {
    await joplin.shutdown();
    if (writeLock) releaseLock(profileDir);
    throw error;
  }

  const port = parseInt(new URL(address).port, 10);

  let stopped = false;
  return {
    app,
    joplin,
    address,
    port,
    async stop() {
      if (stopped) return;
      stopped = true;
      await app.close();
      await joplin.shutdown();
      if (writeLock) releaseLock(profileDir);
    },
  };
}
