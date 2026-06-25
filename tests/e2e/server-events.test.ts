// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// E2E: the SSE loop. The example app holds a `watch` connection to the
// daemon while the official CLI (via the Joplin Server) and the app itself
// make changes; every change must surface as an event with the right source.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import { JoplinCli, resolveJoplinCli } from '../interop/helpers.js';
import { runApp, spawnWatch, type AppEnv, type Watcher } from './app.js';
import { createClient, serverConfig, type DaemonClient } from './harness.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, hasDocker, startJoplinServer, type JoplinServerHandle } from './server.js';

const CLI_BIN = resolveJoplinCli();
const DOCKER = hasDocker();
const TOKEN = 'e2e-events-token';

let workDir: string;
let server: JoplinServerHandle;
let daemon: DaemonHandle;
let client: DaemonClient;
let cli: JoplinCli;
let appEnv: AppEnv;
let watcher: Watcher | undefined;

async function newestEventId(): Promise<number> {
  const events = await client.allEvents();
  return events.length ? events[events.length - 1]!.id : 0;
}

describe.skipIf(!CLI_BIN || !DOCKER)('e2e: SSE events end to end', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'jonobones-e2e-events-'));
    server = await startJoplinServer();
    daemon = await startDaemon({
      profileDir: join(workDir, 'daemon-profile'),
      config: serverConfig(server.url, TOKEN),
      writeLock: false,
      autoSync: false,
    });
    client = createClient(`http://127.0.0.1:${daemon.port}/v1`, TOKEN);
    appEnv = { url: `http://127.0.0.1:${daemon.port}`, token: TOKEN };
    await client.syncAndWaitIdle(); // baseline: first scan emits nothing, by design

    cli = new JoplinCli(CLI_BIN!, join(workDir, 'cli-profile'));
    cli.configureJoplinServerSync(server.url, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  afterEach(async () => {
    await watcher?.stop();
    watcher = undefined;
  });

  afterAll(async () => {
    await daemon?.stop();
    await server?.stop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  let cliNoteId: string;

  it('CLI changes arrive over SSE as source:sync events', async () => {
    watcher = spawnWatch(appEnv, { lastEventId: await newestEventId() });
    await watcher.waitForLine((l) => l.type === 'open');

    cli.run('mkbook', 'ev-book');
    cli.run('use', 'ev-book');
    cli.run('mknote', 'ev-note');
    cli.sync();
    await client.syncAndWaitIdle();

    const found = await client.http('GET', '/search?q=ev-note&fields=id');
    cliNoteId = found.body.items[0].id;

    const noteEvent = await watcher.waitForLine(
      (l) => l.type === 'event' && l.data?.item_id === cliNoteId && l.data.change_type === 'create',
    );
    expect(noteEvent.data).toMatchObject({ item_type: 'note', change_type: 'create', source: 'sync' });
    // The notebook arrived as its own sync event too.
    expect(
      watcher.lines.some(
        (l) => l.type === 'event' && l.data?.item_type === 'notebook' && l.data.source === 'sync',
      ),
    ).toBe(true);
  });

  it("the app's own writes arrive as source:api events, no sync involved", async () => {
    watcher = spawnWatch(appEnv, { lastEventId: await newestEventId() });
    await watcher.waitForLine((l) => l.type === 'open');

    const nb = await runApp(appEnv, 'notebook', 'add', 'ev-app-book');
    const note = await runApp(appEnv, 'note', 'add', '--title', 'ev-app-note', '--notebook', nb.id);

    const event = await watcher.waitForLine((l) => l.type === 'event' && l.data?.item_id === note.id);
    expect(event.data).toMatchObject({ item_type: 'note', change_type: 'create', source: 'api' });
  });

  it('a reconnect with Last-Event-ID replays exactly the missed events', async () => {
    const maxId = await newestEventId(); // nothing watching from here on

    cli.run('mknote', 'ev-missed');
    cli.sync();
    await client.syncAndWaitIdle(); // journaled with no subscriber attached

    const found = await client.http('GET', '/search?q=ev-missed&fields=id');
    const missedId = found.body.items[0].id;

    watcher = spawnWatch(appEnv, { lastEventId: maxId });
    await watcher.waitForLine((l) => l.type === 'open');
    await watcher.waitForLine(
      (l) => l.type === 'event' && l.data?.item_id === missedId && l.data?.change_type === 'create',
    );

    const replayedIds = watcher.lines.filter((l) => l.type === 'event').map((l) => l.id!);
    expect(replayedIds.every((id) => id > maxId)).toBe(true);
    expect([...replayedIds].sort((a, b) => a - b)).toEqual(replayedIds); // in order, no duplicates
    expect(new Set(replayedIds).size).toBe(replayedIds.length);
  });

  it('a server-side permanent delete surfaces as a delete event over SSE', async () => {
    watcher = spawnWatch(appEnv, { lastEventId: await newestEventId() });
    await watcher.waitForLine((l) => l.type === 'open');

    // cliNoteId was synced down and scanned in the first test, so it is in
    // the reconciliation snapshot — the precondition for a delete event.
    await server.api.deleteItem(`${cliNoteId}.md`);
    await client.syncAndWaitIdle();

    const event = await watcher.waitForLine(
      (l) => l.type === 'event' && l.data?.item_id === cliNoteId && l.data.change_type === 'delete',
    );
    expect(event.data).toMatchObject({ item_type: 'note', source: 'sync' });
    expect((await client.http('GET', `/notes/${cliNoteId}`)).status).toBe(404);
  });
});

if (!CLI_BIN || !DOCKER) {
  console.warn(
    'e2e suite skipped: needs the joplin CLI (JOPLIN_CLI_BIN or `npm i -g joplin`) and a running docker daemon',
  );
}
