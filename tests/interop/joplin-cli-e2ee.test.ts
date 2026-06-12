// M6 interop proof, E2EE: an encrypted filesystem target shared between
// jonobones and the official joplin CLI, both configured with the same
// master password. Proves the daemon both produces and consumes encrypted
// sync data exactly like a stock client.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import type { Config } from '../../src/config/types.js';
import { JoplinCli, readProfileDb, resolveJoplinCli } from './helpers.js';

const CLI_BIN = resolveJoplinCli();
const TOKEN = 'interop-e2ee-token';
const MASTER_PASSWORD = 'correct horse battery staple 🦴';
const SECRET_BODY = 'top secret body — encrypted on the wire, plaintext at rest locally';

let workDir: string;
let syncDir: string;
let daemon: DaemonHandle;
let base: string;
let cli: JoplinCli;

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
  for (let i = 0; i < 240; i++) {
    const status = await http('GET', '/status');
    if (status.body.sync.state === 'idle' && status.body.sync.lastCompletedAt) return;
    if (status.body.sync.state === 'error') throw new Error(status.body.sync.lastResult);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('sync did not reach idle');
}

describe.skipIf(!CLI_BIN)('interop with the official joplin CLI (E2EE)', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'jonobones-interop-e2ee-'));
    syncDir = join(workDir, 'sync-target');
    cli = new JoplinCli(CLI_BIN!, join(workDir, 'cli-profile'));

    const config: Config = {
      api: { port: 0, bind: '127.0.0.1', token: TOKEN },
      sync: { target: 'filesystem', interval: 0, path: syncDir },
      e2ee: { masterPassword: MASTER_PASSWORD },
      events: { retentionDays: 30 },
    };
    daemon = await startDaemon({ profileDir: join(workDir, 'daemon-profile'), config, writeLock: false, autoSync: false });
    base = `http://127.0.0.1:${daemon.port}/v1`;
  }, 180_000);

  afterAll(async () => {
    await daemon?.stop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  let noteId: string;

  it('jonobones encrypts the target like a stock client', { timeout: 240_000 }, async () => {
    const nb = (await http('POST', '/notebooks', { title: 'secret-book' })).body;
    noteId = (await http('POST', '/notes', { title: 'secret-note', body: SECRET_BODY, parent_id: nb.id })).body.id;

    // Enable E2EE exactly the way a stock client would.
    const { lib, services } = daemon.joplin;
    lib.Setting.setValue('encryption.masterPassword', MASTER_PASSWORD);
    await lib.e2eeUtils.generateMasterKeyAndEnableEncryption(services.encryptionService, MASTER_PASSWORD);

    await syncAndWaitIdle();

    // The serialized note on the target must be ciphertext, not plaintext.
    const onDisk = readFileSync(join(syncDir, `${noteId}.md`), 'utf8');
    expect(onDisk).not.toContain(SECRET_BODY);
    expect(onDisk).not.toContain('secret-note');
    expect(onDisk).toContain('encryption_applied: 1');

    const infoJson = readFileSync(join(syncDir, 'info.json'), 'utf8');
    expect(JSON.parse(infoJson).e2ee.value).toBe(true);
  });

  it('the official CLI decrypts it with the shared password', { timeout: 240_000 }, async () => {
    cli.configureFilesystemSync(syncDir);
    cli.run('config', 'encryption.masterPassword', MASTER_PASSWORD);
    cli.sync();
    cli.run('e2ee', 'decrypt');

    const db = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
    try {
      const note = await db.get('SELECT title, body, encryption_applied FROM notes WHERE id = ?', [noteId]);
      expect(note).toBeDefined();
      expect(note!.encryption_applied).toBe(0);
      expect(note!.title).toBe('secret-note');
      expect(note!.body).toBe(SECRET_BODY);
    } finally {
      await db.close();
    }
  });

  it('jonobones decrypts what the official CLI encrypted', { timeout: 240_000 }, async () => {
    cli.run('use', 'secret-book');
    cli.run('mknote', 'cli-secret');
    cli.run('set', 'cli-secret', 'body', 'secret from the official client');
    cli.sync();

    await syncAndWaitIdle();

    // postSync ran the decryption worker (daemon has the master password).
    const found = await http('GET', '/search?q=cli-secret&fields=id,title,body');
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0].body).toBe('secret from the official client');

    const status = await http('GET', '/status');
    expect(status.body.e2ee.enabled).toBe(true);
    expect(status.body.e2ee.pendingDecryption).toBe(0);
  });
});

if (!CLI_BIN) {
  console.warn('E2EE interop suite skipped: no joplin CLI found');
}
