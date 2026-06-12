// E2E: sync fidelity through a real Joplin Server (target 9). Three actors
// share one server: the official joplin CLI, an in-process daemon, and the
// example app — plus one spawned `bin/jonobones.js` to prove the
// hand-written-config provisioning path.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import { JoplinCli, readProfileDb, resolveJoplinCli } from '../interop/helpers.js';
import { runApp, type AppEnv } from './app.js';
import { createClient, freePort, serverConfig, spawnDaemon, writeDaemonConfig, type DaemonClient } from './harness.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, hasDocker, startJoplinServer, type JoplinServerHandle } from './server.js';

const CLI_BIN = resolveJoplinCli();
const DOCKER = hasDocker();
const TOKEN = 'e2e-sync-token';

const SRV_BODY = 'written by the official CLI — déjà vu, 草書, 🦴';
const APP_BODY = 'written by the example app — ñöç 接続テスト';
const FILE_BYTES = 'attachment payload for the server e2e — 🦴\n';

let workDir: string;
let server: JoplinServerHandle;
let daemon: DaemonHandle;
let client: DaemonClient;
let cli: JoplinCli;
let appEnv: AppEnv;

describe.skipIf(!CLI_BIN || !DOCKER)('e2e: Joplin Server sync fidelity', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'jonobones-e2e-sync-'));
    server = await startJoplinServer();

    daemon = await startDaemon({
      profileDir: join(workDir, 'daemon-profile'),
      config: serverConfig(server.url, TOKEN),
      writeLock: false,
      autoSync: false,
    });
    client = createClient(`http://127.0.0.1:${daemon.port}/v1`, TOKEN);
    appEnv = { url: `http://127.0.0.1:${daemon.port}`, token: TOKEN };
    // Baseline sync: establishes the event-scan checkpoint and proves
    // connectivity before any scenario runs.
    await client.syncAndWaitIdle();

    cli = new JoplinCli(CLI_BIN!, join(workDir, 'cli-profile'));
    cli.configureJoplinServerSync(server.url, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  afterAll(async () => {
    await daemon?.stop();
    await server?.stop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  let srvNoteId: string;
  let appNoteId: string;
  let appNotebookId: string;

  it('provisions against the server: status reports the target, first sync ok', async () => {
    const status = await client.http('GET', '/status');
    expect(status.body.sync.target).toBe('joplinServer');
    expect(status.body.sync.state).toBe('idle');
    expect(status.body.sync.lastCompletedAt).toBeTruthy();
  });

  it('CLI seeds notes/tags/attachment → daemon syncs them down intact', async () => {
    cli.run('mkbook', 'srv-book');
    cli.run('use', 'srv-book');
    cli.run('mknote', 'srv-note');
    cli.run('set', 'srv-note', 'body', SRV_BODY);
    cli.run('tag', 'add', 'srv-tag', 'srv-note');
    const attachment = join(workDir, 'srv-attach.txt');
    writeFileSync(attachment, FILE_BYTES);
    cli.run('attach', 'srv-note', attachment);
    cli.sync();

    await client.syncAndWaitIdle();

    const found = await client.http('GET', '/search?q=srv-note&fields=id,title,body,parent_id');
    expect(found.body.items).toHaveLength(1);
    srvNoteId = found.body.items[0].id;
    expect(found.body.items[0].body).toContain(SRV_BODY);

    const tags = await client.http('GET', `/notes/${srvNoteId}/tags?fields=title`);
    expect(tags.body.items.map((t: { title: string }) => t.title)).toEqual(['srv-tag']);

    const resources = await client.http('GET', `/notes/${srvNoteId}/resources?fields=id`);
    expect(resources.body.items).toHaveLength(1);
    const blob = await fetch(`${client.base}/resources/${resources.body.items[0].id}/file`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await blob.text()).toBe(FILE_BYTES);
  });

  it('app creates note/file/tag/userdata → CLI syncs them down intact', async () => {
    appNotebookId = (await runApp(appEnv, 'notebook', 'add', 'app-book')).id;
    appNoteId = (
      await runApp(appEnv, 'note', 'add', '--title', 'app-note', '--body', APP_BODY, '--notebook', appNotebookId)
    ).id;
    const attachment = join(workDir, 'app-attach.txt');
    writeFileSync(attachment, FILE_BYTES);
    const attached = await runApp(appEnv, 'attach', appNoteId, attachment);
    await runApp(appEnv, 'tag', appNoteId, 'app-tag');
    await runApp(appEnv, 'userdata', 'set', appNoteId, 'e2e-suite', 'payload', '{"n":1,"ok":true}');

    await runApp(appEnv, 'sync', '--wait');
    cli.sync();

    const db = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
    try {
      const note = await db.get('SELECT title, body, parent_id, user_data FROM notes WHERE id = ?', [appNoteId]);
      expect(note).toBeDefined();
      expect(note!.title).toBe('app-note');
      expect(note!.body).toContain(APP_BODY);
      expect(note!.body).toContain(`:/${attached.resource_id}`);
      expect(note!.parent_id).toBe(appNotebookId);
      // user_data arrived in Joplin's envelope, value intact.
      const userData = JSON.parse(note!.user_data as string);
      expect(userData['e2e-suite'].payload.v).toEqual({ n: 1, ok: true });

      const link = await db.get(
        'SELECT nt.id FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ? AND t.title = ?',
        [appNoteId, 'app-tag'],
      );
      expect(link).toBeDefined();

      const resource = await db.get('SELECT id, file_extension FROM resources WHERE id = ?', [attached.resource_id]);
      expect(resource).toBeDefined();
      const blobPath = join(cli.profileDir, 'resources', `${attached.resource_id}.${resource!.file_extension as string}`);
      expect(readFileSync(blobPath, 'utf8')).toBe(FILE_BYTES);
    } finally {
      await db.close();
    }
  });

  it('edits converge both ways; CLI trash and app restore round-trip', async () => {
    cli.run('set', appNoteId, 'title', 'app-note (cli edit)');
    await client.http('PATCH', `/notes/${srvNoteId}`, { body: 'updated by daemon' });
    cli.sync(); // push the CLI edit
    await client.syncAndWaitIdle(); // push the daemon edit, pull the CLI edit
    cli.sync(); // pull the daemon edit

    expect((await client.http('GET', `/notes/${appNoteId}?fields=title`)).body.title).toBe('app-note (cli edit)');
    const db = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
    try {
      const note = await db.get('SELECT body FROM notes WHERE id = ?', [srvNoteId]);
      expect(note!.body).toBe('updated by daemon');
    } finally {
      await db.close();
    }

    // CLI trashes → daemon sees Joplin's soft delete and excludes it.
    cli.run('rmnote', '--force', srvNoteId);
    cli.sync();
    await client.syncAndWaitIdle();
    const trashed = await client.http('GET', `/notes/${srvNoteId}?fields=id,deleted_time`);
    expect(trashed.body.deleted_time).toBeGreaterThan(0);
    const listed = await client.http('GET', '/notes?limit=1000&fields=id');
    expect(listed.body.items.map((n: { id: string }) => n.id)).not.toContain(srvNoteId);

    // App restores → CLI sees it live again.
    await client.http('POST', `/notes/${srvNoteId}/restore`);
    await client.syncAndWaitIdle();
    cli.sync();
    const db2 = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
    try {
      const note = await db2.get('SELECT deleted_time FROM notes WHERE id = ?', [srvNoteId]);
      expect(note!.deleted_time).toBe(0);
    } finally {
      await db2.close();
    }
  });

  it('a server-side permanent delete removes the note from the daemon', async () => {
    await server.api.deleteItem(`${srvNoteId}.md`);
    await client.syncAndWaitIdle();
    expect((await client.http('GET', `/notes/${srvNoteId}`)).status).toBe(404);
  });

  it('the shipped binary boots from a hand-written config.json5 and syncs', async () => {
    const profileDir = join(workDir, 'spawned-profile');
    const port = await freePort();
    const spawnedToken = 'e2e-spawned-token';
    writeDaemonConfig(profileDir, { port, token: spawnedToken, serverUrl: server.url });

    const spawnedDaemon = await spawnDaemon(profileDir, port);
    try {
      const spawned = createClient(`http://127.0.0.1:${port}/v1`, spawnedToken);
      await spawned.syncAndWaitIdle();
      // It pulled the shared knowledge base from the server.
      const listed = await spawned.http('GET', '/notes?limit=1000&fields=id,title');
      const ids = listed.body.items.map((n: { id: string }) => n.id);
      expect(
        ids,
        `spawned daemon notes: ${JSON.stringify(listed.body.items)}\ndaemon output: ${spawnedDaemon.output.join('')}`,
      ).toContain(appNoteId);
    } finally {
      expect(await spawnedDaemon.stop()).toBe(0);
    }
  });
});

if (!CLI_BIN || !DOCKER) {
  console.warn(
    'e2e suite skipped: needs the joplin CLI (JOPLIN_CLI_BIN or `npm i -g joplin`) and a running docker daemon',
  );
}
