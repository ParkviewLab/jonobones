// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// E2E: resilience. Daemon restarts must not replay or lose events
// (checkpoint + journal persist), concurrent edits must produce Joplin
// conflict semantics, and a server outage must degrade gracefully and
// recover cleanly.
//
// This suite drives a SPAWNED daemon (the shipped binary, own process):
// @joplin/lib is process-global, so an in-process daemon can never be
// restarted — and a real process restart is the honest test anyway.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JoplinCli, resolveJoplinCli } from '../interop/helpers.js';
import { spawnWatch, type AppEnv } from './app.js';
import {
  createClient,
  freePort,
  spawnDaemon,
  writeDaemonConfig,
  type DaemonClient,
  type SpawnedDaemon,
} from './harness.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, hasDocker, startJoplinServer, type JoplinServerHandle } from './server.js';

const CLI_BIN = resolveJoplinCli();
const DOCKER = hasDocker();
const TOKEN = 'e2e-resilience-token';

let workDir: string;
let profileDir: string;
let port: number;
let server: JoplinServerHandle;
let daemon: SpawnedDaemon;
let client: DaemonClient;
let cli: JoplinCli;
let appEnv: AppEnv;
let resNoteId: string;

describe.skipIf(!CLI_BIN || !DOCKER)('e2e: resilience', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'jonobones-e2e-resilience-'));
    server = await startJoplinServer();

    profileDir = join(workDir, 'daemon-profile');
    port = await freePort();
    writeDaemonConfig(profileDir, { port, token: TOKEN, serverUrl: server.url });
    daemon = await spawnDaemon(profileDir, port);
    client = createClient(`http://127.0.0.1:${port}/v1`, TOKEN);
    appEnv = { url: `http://127.0.0.1:${port}`, token: TOKEN };
    await client.syncAndWaitIdle(); // boot sync = the event-scan baseline

    cli = new JoplinCli(CLI_BIN!, join(workDir, 'cli-profile'));
    cli.configureJoplinServerSync(server.url, ADMIN_EMAIL, ADMIN_PASSWORD);
    cli.run('mkbook', 'res-book');
    cli.run('use', 'res-book');
    cli.run('mknote', 'res-note');
    cli.sync();
    await client.syncAndWaitIdle(); // res-note enters the daemon + the scan snapshot

    const found = await client.http('GET', '/search?q=res-note&fields=id');
    resNoteId = found.body.items[0].id;
  });

  afterAll(async () => {
    await daemon?.stop();
    await server?.stop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('a daemon restart keeps the journal and checkpoint: no spurious events', async () => {
    const before = await client.allEvents();
    expect(before.length).toBeGreaterThan(0);
    const lastId = before[before.length - 1]!.id;

    const exitCode = await daemon.stop();
    expect(exitCode).toBe(0);
    daemon = await spawnDaemon(profileDir, port); // same profile, same port — client survives

    await client.syncAndWaitIdle();
    const after = await client.allEvents();
    // Nothing changed remotely, so the restart + re-scan must emit nothing new.
    expect(after.length).toBe(before.length);
    expect(after[after.length - 1]!.id).toBe(lastId);

    // SSE replay still serves the full pre-restart journal.
    const watcher = spawnWatch(appEnv, { lastEventId: 0 });
    try {
      await watcher.waitForLine((l) => l.type === 'event' && l.id === lastId);
    } finally {
      await watcher.stop();
    }
  });

  it('concurrent edits produce a conflict copy; the remote edit wins the original', async () => {
    cli.run('set', resNoteId, 'body', 'cli conflicting body');
    await client.http('PATCH', `/notes/${resNoteId}`, { body: 'daemon conflicting body' });
    cli.sync(); // remote (server) now has the CLI version
    await client.syncAndWaitIdle(); // daemon: local dirty + remote changed → conflict

    const conflicts = await client.http('GET', '/conflicts?fields=id,title,conflict_original_id');
    const conflict = conflicts.body.items.find(
      (c: { conflict_original_id: string }) => c.conflict_original_id === resNoteId,
    );
    expect(conflict).toBeDefined();

    const original = await client.http('GET', `/notes/${resNoteId}?fields=body`);
    expect(original.body.body).toBe('cli conflicting body');
  });

  it('a server outage surfaces as a sync error, reads keep serving, and sync recovers', async () => {
    await server.pause();

    await client.http('POST', '/sync');
    const lastResult = await client.waitForSyncError();
    expect(lastResult).toBeTruthy();

    // Data plane unaffected: reads still serve from the local profile.
    const note = await client.http('GET', `/notes/${resNoteId}?fields=id,body`);
    expect(note.status).toBe(200);
    expect(note.body.body).toBe('cli conflicting body');

    await server.resume();

    // Recover: poll for a fresh completion. The state machine reports
    // 'error' until a successful cycle finishes, so syncAndWaitIdle
    // (error = fatal) cannot be used across the recovery boundary.
    const statusBefore = await client.http('GET', '/status');
    const completedBefore = statusBefore.body.sync.lastCompletedAt;
    await client.http('POST', '/sync');
    let recovered = false;
    for (let i = 0; i < 240 && !recovered; i++) {
      const status = await client.http('GET', '/status');
      if (status.body.sync.state === 'idle' && status.body.sync.lastCompletedAt !== completedBefore) {
        recovered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(recovered).toBe(true);

    const after = await client.http('GET', `/notes/${resNoteId}?fields=id,body`);
    expect(after.status).toBe(200);
    expect(after.body.body).toBe('cli conflicting body');
  });
});

if (!CLI_BIN || !DOCKER) {
  console.warn(
    'e2e suite skipped: needs the joplin CLI (JOPLIN_CLI_BIN or `npm i -g joplin`) and a running docker daemon',
  );
}
