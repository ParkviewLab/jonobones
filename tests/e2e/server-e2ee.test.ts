// E2E: end-to-end encryption over a Joplin Server target. The daemon
// enables E2EE (the same lib call a stock client makes) and uploads
// ciphertext; the official CLI joins the encrypted target with the shared
// password and decrypts — then writes its own encrypted note back, which
// the daemon must decrypt transparently.
//
// Deliberately NOT driven by `joplin e2ee enable`: that command races its
// own settings flush on process exit and intermittently no-ops (exit 0,
// no output, encryption still Disabled — observed on Linux CI). The
// CLI-joins path used here (`config encryption.masterPassword` +
// `e2ee decrypt`) is the reliable non-interactive flow, and it is also
// the interop tier's proven pattern.

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

const DAEMON_SECRET = 'daemon-e2ee-secret body — must never appear in server plaintext';
const CLI_SECRET = 'cli-e2ee-secret body — encrypted on upload by the official client';

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

  let daemonNoteId: string;

  it('the daemon enables E2EE and uploads ciphertext', async () => {
    // Enable exactly the way a stock client (and `jonobones init`) does.
    const { lib, services } = daemon.joplin;
    lib.Setting.setValue('encryption.masterPassword', MASTER_PASSWORD);
    await lib.e2eeUtils.generateMasterKeyAndEnableEncryption(services.encryptionService, MASTER_PASSWORD);

    const nb = await runApp(appEnv, 'notebook', 'add', 'secret-book');
    daemonNoteId = (
      await runApp(appEnv, 'note', 'add', '--title', 'daemon-secret-note', '--body', DAEMON_SECRET, '--notebook', nb.id)
    ).id;
    await client.syncAndWaitIdle();

    const infoJson = JSON.parse(await server.api.getItemContent('info.json'));
    expect(infoJson.e2ee.value).toBe(true);

    // Ciphertext at rest: the server-side item is encrypted and leaks nothing.
    const itemContent = await server.api.getItemContent(`${daemonNoteId}.md`);
    expect(itemContent).toContain('encryption_applied: 1');
    expect(itemContent).not.toContain(DAEMON_SECRET);
    expect(itemContent).not.toContain('daemon-secret-note');
  });

  it('the official CLI joins with the shared password and decrypts', async () => {
    cli.run('config', 'encryption.masterPassword', MASTER_PASSWORD);

    // The CLI prints "Completed" and exits 0 even when a sync silently
    // no-ops, so sync until its database observably has the note.
    await cliSyncUntil(cli, async () => {
      const db = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
      try {
        return (await db.get('SELECT id FROM notes WHERE id = ?', [daemonNoteId])) !== undefined;
      } finally {
        await db.close();
      }
    });
    cli.run('e2ee', 'decrypt');

    const db = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
    try {
      const note = await db.get('SELECT title, body, encryption_applied FROM notes WHERE id = ?', [daemonNoteId]);
      expect(note).toBeDefined();
      expect(note!.encryption_applied).toBe(0);
      expect(note!.title).toBe('daemon-secret-note');
      expect(note!.body).toBe(DAEMON_SECRET);
    } finally {
      await db.close();
    }
  });

  it("the CLI's own writes are encrypted on upload and the daemon decrypts them", async () => {
    cli.run('use', 'secret-book');
    cli.run('mknote', 'cli-secret-note');
    cli.run('set', 'cli-secret-note', 'body', CLI_SECRET);

    const db = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
    let cliNoteId: string;
    try {
      const note = await db.get('SELECT id FROM notes WHERE title = ?', ['cli-secret-note']);
      cliNoteId = note!.id as string;
    } finally {
      await db.close();
    }

    await cliSyncUntil(cli, async () => {
      try {
        await server.api.getItemContent(`${cliNoteId}.md`);
        return true;
      } catch {
        return false;
      }
    });

    // Ciphertext at rest for the CLI's upload too.
    const itemContent = await server.api.getItemContent(`${cliNoteId}.md`);
    expect(itemContent).toContain('encryption_applied: 1');
    expect(itemContent).not.toContain(CLI_SECRET);

    await client.syncAndWaitIdle(); // pulls ciphertext; postSync decrypts

    const status = await client.http('GET', '/status');
    expect(status.body.e2ee.enabled).toBe(true);
    expect(status.body.e2ee.pendingDecryption).toBe(0);

    const found = await client.http('GET', '/search?q=cli-e2ee-secret&fields=id,title,body');
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0].id).toBe(cliNoteId);
    expect(found.body.items[0].body).toContain(CLI_SECRET);
  });
});

if (!CLI_BIN || !DOCKER) {
  console.warn(
    'e2e suite skipped: needs the joplin CLI (JOPLIN_CLI_BIN or `npm i -g joplin`) and a running docker daemon',
  );
}
