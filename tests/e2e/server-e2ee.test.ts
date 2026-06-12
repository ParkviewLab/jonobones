// E2E: end-to-end encryption over a Joplin Server target. The official CLI
// enables E2EE; the daemon joins the already-encrypted target with the
// shared password from its config and must decrypt transparently — and its
// own writes must land on the server as ciphertext the CLI can decrypt.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import { JoplinCli, readProfileDb, resolveJoplinCli } from '../interop/helpers.js';
import { runApp, type AppEnv } from './app.js';
import { cliSyncUntil, createClient, serverConfig, type DaemonClient } from './harness.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, hasDocker, startJoplinServer, type JoplinServerHandle } from './server.js';

const CLI_BIN = resolveJoplinCli();
const DOCKER = hasDocker();
const TOKEN = 'e2e-e2ee-token';
const MASTER_PASSWORD = 'correct horse battery staple 🦴 (server)';

const CLI_SECRET = 'srv-e2ee-secret body — must never appear in server plaintext';
const APP_SECRET = 'app-e2ee-secret body — encrypted on upload by the daemon';

let workDir: string;
let server: JoplinServerHandle;
let daemon: DaemonHandle;
let client: DaemonClient;
let cli: JoplinCli;
let appEnv: AppEnv;

describe.skipIf(!CLI_BIN || !DOCKER)('e2e: E2EE over a Joplin Server', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'jonobones-e2e-e2ee-'));
    server = await startJoplinServer();
    daemon = await startDaemon({
      profileDir: join(workDir, 'daemon-profile'),
      config: serverConfig(server.url, TOKEN, { e2ee: { masterPassword: MASTER_PASSWORD } }),
      writeLock: false,
      autoSync: false,
    });
    client = createClient(`http://127.0.0.1:${daemon.port}/v1`, TOKEN);
    appEnv = { url: `http://127.0.0.1:${daemon.port}`, token: TOKEN };
    await client.syncAndWaitIdle(); // baseline against the still-plaintext, empty target

    cli = new JoplinCli(CLI_BIN!, join(workDir, 'cli-profile'));
    cli.configureJoplinServerSync(server.url, ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  afterAll(async () => {
    await daemon?.stop();
    await server?.stop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  let cliNoteId: string;

  it('CLI enables E2EE and uploads ciphertext', async () => {
    cli.run('e2ee', 'enable', '-p', MASTER_PASSWORD);
    cli.run('mkbook', 'secret-book');
    cli.run('use', 'secret-book');
    cli.run('mknote', 'secret-note');
    cli.run('set', 'secret-note', 'body', CLI_SECRET);

    // Pinpoint enable-vs-sync if this ever fails again: the CLI must
    // consider E2EE on before any sync runs. (Don't assert on the legacy
    // master_keys table — modern Joplin keeps keys in the sync info.)
    expect(cli.run('e2ee', 'status')).toContain('Encryption is: Enabled');

    const db = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
    try {
      const note = await db.get('SELECT id FROM notes WHERE title = ?', ['secret-note']);
      cliNoteId = note!.id as string;
    } finally {
      await db.close();
    }

    // Sync until the server observably has the E2EE flag and the note item
    // (a plain cli.sync() can silently no-op — see cliSyncUntil).
    await cliSyncUntil(cli, async () => {
      try {
        if (JSON.parse(await server.api.getItemContent('info.json')).e2ee.value !== true) return false;
        await server.api.getItemContent(`${cliNoteId}.md`);
        return true;
      } catch {
        return false;
      }
    });

    const infoJson = JSON.parse(await server.api.getItemContent('info.json'));
    expect(infoJson.e2ee.value).toBe(true);

    // Ciphertext at rest: the server-side item is encrypted and leaks nothing.
    const itemContent = await server.api.getItemContent(`${cliNoteId}.md`);
    expect(itemContent).toContain('encryption_applied: 1');
    expect(itemContent).not.toContain(CLI_SECRET);
    expect(itemContent).not.toContain('secret-note');
  });

  it('the daemon joins the encrypted target and decrypts with its config password', async () => {
    await client.syncAndWaitIdle(); // pulls master key + ciphertext; postSync decrypts

    const status = await client.http('GET', '/status');
    expect(status.body.e2ee.enabled).toBe(true);
    expect(status.body.e2ee.pendingDecryption).toBe(0);

    const found = await client.http('GET', '/search?q=srv-e2ee-secret&fields=id,title,body');
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0].id).toBe(cliNoteId);
    expect(found.body.items[0].body).toContain(CLI_SECRET);
  });

  it("the daemon's own writes are encrypted on upload and the CLI decrypts them", async () => {
    const nb = await runApp(appEnv, 'notebook', 'add', 'app-secret-book');
    const note = await runApp(
      appEnv,
      'note',
      'add',
      '--title',
      'app-secret-note',
      '--body',
      APP_SECRET,
      '--notebook',
      nb.id,
    );
    await client.syncAndWaitIdle();

    // Ciphertext at rest for the daemon's upload too.
    const itemContent = await server.api.getItemContent(`${note.id}.md`);
    expect(itemContent).toContain('encryption_applied: 1');
    expect(itemContent).not.toContain(APP_SECRET);

    cli.sync();
    cli.run('e2ee', 'decrypt');

    const db = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
    try {
      const row = await db.get('SELECT body, encryption_applied FROM notes WHERE id = ?', [note.id]);
      expect(row).toBeDefined();
      expect(row!.encryption_applied).toBe(0);
      expect(row!.body).toBe(APP_SECRET);
    } finally {
      await db.close();
    }
  });
});

if (!CLI_BIN || !DOCKER) {
  console.warn(
    'e2e suite skipped: needs the joplin CLI (JOPLIN_CLI_BIN or `npm i -g joplin`) and a running docker daemon',
  );
}
