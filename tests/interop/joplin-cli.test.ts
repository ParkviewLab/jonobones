// M6 interop proof, plaintext: jonobones and the OFFICIAL joplin CLI share
// a filesystem sync target; notes, notebooks, tags, note↔tag links,
// resources, and user_data must round-trip byte-faithfully in both
// directions. This is the executable form of "sync compatibility
// maintained".

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import type { Config } from '../../src/config/types.js';
import { JoplinCli, readProfileDb, resolveJoplinCli } from './helpers.js';

const CLI_BIN = resolveJoplinCli();
const TOKEN = 'interop-token';

const NOTE_BODY = 'Interop body — déjà vu, 草書, 🦴.\n\nSecond paragraph with **markdown**.';
const FILE_BYTES = 'attachment payload from jonobones — 🦴\n';
const CLI_BODY = 'body from the official client — ñöç 接続テスト';

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

describe.skipIf(!CLI_BIN)('interop with the official joplin CLI (plaintext)', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'jonobones-interop-'));
    syncDir = join(workDir, 'sync-target');
    cli = new JoplinCli(CLI_BIN!, join(workDir, 'cli-profile'));

    const config: Config = {
      api: { port: 0, bind: '127.0.0.1', token: TOKEN },
      sync: { target: 'filesystem', interval: 0, path: syncDir },
      e2ee: {},
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
  let notebookId: string;
  let tagId: string;
  let resourceId: string;
  let userDataRaw: string;

  it('jonobones → CLI: items round-trip into the official client', { timeout: 240_000 }, async () => {
    // Build a little knowledge base through the jonobones API.
    notebookId = (await http('POST', '/notebooks', { title: 'jb-book' })).body.id;
    const note = (await http('POST', '/notes', { title: 'jb-note', body: NOTE_BODY, parent_id: notebookId })).body;
    noteId = note.id;

    tagId = (await http('POST', '/tags', { title: 'jb-tag' })).body.id;
    await http('POST', `/tags/${tagId}/notes`, { id: noteId });

    const form = new FormData();
    form.append('props', JSON.stringify({ title: 'jb-file.txt' }));
    form.append('data', new Blob([FILE_BYTES], { type: 'text/plain' }), 'jb-file.txt');
    const upload = await fetch(`${base}/resources`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    resourceId = ((await upload.json()) as { id: string }).id;
    await http('PATCH', `/notes/${noteId}`, { body: `${NOTE_BODY}\n\n[file](:/${resourceId})` });

    await http('PUT', `/notes/${noteId}/userdata/interop-suite/payload`, {
      value: { n: 1, s: 'jonobones', list: [1, 2, 3] },
    });
    userDataRaw = (await http('GET', `/notes/${noteId}?fields=user_data`)).body.user_data;
    expect(userDataRaw).toContain('interop-suite');

    await syncAndWaitIdle();

    // The official client pulls...
    cli.configureFilesystemSync(syncDir);
    cli.sync();

    // ...and its own database must contain everything, byte-faithfully.
    const db = await readProfileDb(join(cli.profileDir, 'database.sqlite'));
    try {
      const cliNote = await db.get('SELECT title, body, parent_id, user_data FROM notes WHERE id = ?', [noteId]);
      expect(cliNote).toBeDefined();
      expect(cliNote!.title).toBe('jb-note');
      expect(cliNote!.body).toBe(`${NOTE_BODY}\n\n[file](:/${resourceId})`);
      expect(cliNote!.parent_id).toBe(notebookId);
      expect(cliNote!.user_data).toBe(userDataRaw); // byte-faithful

      const cliFolder = await db.get('SELECT title FROM folders WHERE id = ?', [notebookId]);
      expect(cliFolder!.title).toBe('jb-book');

      const cliTag = await db.get('SELECT title FROM tags WHERE id = ?', [tagId]);
      expect(cliTag!.title).toBe('jb-tag');
      const link = await db.get('SELECT id FROM note_tags WHERE note_id = ? AND tag_id = ?', [noteId, tagId]);
      expect(link).toBeDefined();

      const cliResource = await db.get('SELECT id, mime, file_extension FROM resources WHERE id = ?', [resourceId]);
      expect(cliResource).toBeDefined();
      expect(cliResource!.mime).toBe('text/plain');

      const blobPath = join(cli.profileDir, 'resources', `${resourceId}.${cliResource!.file_extension as string}`);
      expect(readFileSync(blobPath, 'utf8')).toBe(FILE_BYTES);
    } finally {
      await db.close();
    }
  });

  it('CLI → jonobones: official-client items round-trip back', { timeout: 240_000 }, async () => {
    cli.run('mkbook', 'cli-book');
    cli.run('use', 'cli-book');
    cli.run('mknote', 'cli-note');
    cli.run('set', 'cli-note', 'body', CLI_BODY);
    cli.run('tag', 'add', 'cli-tag', 'cli-note');
    const attachment = join(workDir, 'cli-attach.txt');
    writeFileSync(attachment, 'attachment from the official client\n');
    cli.run('attach', 'cli-note', attachment);

    // The CLI also edits the jonobones-born note: user_data must survive a
    // foreign client's edit + sync cycle untouched. (By id: title selectors
    // resolve within the CLI's active notebook only.)
    cli.run('set', noteId, 'title', 'jb-note (edited by cli)');

    cli.sync();
    await syncAndWaitIdle();

    const found = await http('GET', '/search?q=cli-note&fields=id,title,body,parent_id');
    expect(found.body.items).toHaveLength(1);
    const cliNote = found.body.items[0];
    // The CLI's attach command splices the resource link into the body, so
    // assert containment rather than the exact concatenation.
    expect(cliNote.body).toContain(CLI_BODY);

    const tags = await http('GET', `/notes/${cliNote.id}/tags?fields=title`);
    expect(tags.body.items.map((t: { title: string }) => t.title)).toEqual(['cli-tag']);

    const resources = await http('GET', `/notes/${cliNote.id}/resources?fields=id,mime`);
    expect(resources.body.items).toHaveLength(1);
    expect(cliNote.body).toContain(`:/${resources.body.items[0].id}`);
    const blob = await fetch(`${base}/resources/${resources.body.items[0].id}/file`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await blob.text()).toBe('attachment from the official client\n');

    // The CLI's edit arrived...
    const edited = await http('GET', `/notes/${noteId}?fields=title,user_data`);
    expect(edited.body.title).toBe('jb-note (edited by cli)');
    // ...and user_data survived the round trip byte-identically.
    expect(edited.body.user_data).toBe(userDataRaw);
  });
});

if (!CLI_BIN) {
  console.warn('interop suite skipped: no joplin CLI found (set JOPLIN_CLI_BIN or install `npm i -g joplin`)');
}
