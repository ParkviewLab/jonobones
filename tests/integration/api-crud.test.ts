import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import type { Config } from '../../src/config/types.js';

const TOKEN = 'integration-token';

let profileDir: string;
let daemon: DaemonHandle;
let base: string;

beforeAll(async () => {
  profileDir = mkdtempSync(join(tmpdir(), 'jonobones-api-test-'));
  const config: Config = {
    api: { port: 0, bind: '127.0.0.1', token: TOKEN },
    sync: { target: 'filesystem', interval: 300 },
    e2ee: {},
  };
  daemon = await startDaemon({ profileDir, config, writeLock: false });
  base = `http://127.0.0.1:${daemon.port}/v1`;
}, 60_000);

afterAll(async () => {
  await daemon?.stop();
  rmSync(profileDir, { recursive: true, force: true });
});

interface HttpResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function http(method: string, path: string, body?: unknown, withAuth = true): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (withAuth) headers.authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

describe('notebooks', () => {
  it('creates, fetches, patches', async () => {
    const created = await http('POST', '/notebooks', { title: 'Inbox' });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(created.body.title).toBe('Inbox');

    const got = await http('GET', `/notebooks/${created.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({
      id: created.body.id,
      parent_id: '',
      title: 'Inbox',
      updated_time: expect.any(Number),
    });

    const patched = await http('PATCH', `/notebooks/${created.body.id}`, { title: 'Inbox 2' });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('Inbox 2');
  });

  it('accepts caller-chosen 32-hex ids and 409s on reuse', async () => {
    const id = '0123456789abcdef0123456789abcdef';
    const created = await http('POST', '/notebooks', { id, title: 'Fixed id' });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe(id);

    const dup = await http('POST', '/notebooks', { id, title: 'Again' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('conflict');

    const badId = await http('POST', '/notebooks', { id: 'NOT-HEX', title: 'x' });
    expect(badId.status).toBe(400);
  });

  it('rejects nesting under a missing parent', async () => {
    const res = await http('POST', '/notebooks', { title: 'x', parent_id: 'f'.repeat(32) });
    expect(res.status).toBe(400);
  });
});

describe('notes', () => {
  let notebookId: string;

  beforeAll(async () => {
    notebookId = (await http('POST', '/notebooks', { title: 'Notes home' })).body.id;
  });

  it('requires parent_id on create', async () => {
    expect((await http('POST', '/notes', { title: 'orphan' })).status).toBe(400);
    expect((await http('POST', '/notes', { title: 'orphan', parent_id: 'a'.repeat(32) })).status).toBe(400);
  });

  it('creates and echoes the full item', async () => {
    const res = await http('POST', '/notes', { title: 'First', body: 'Hello **md**', parent_id: notebookId });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('First');
    expect(res.body.body).toBe('Hello **md**');
    expect(res.body.parent_id).toBe(notebookId);
    expect(res.body.markup_language).toBe(1);
  });

  it('lists with default fields, parent filter, pagination and ordering', async () => {
    for (const n of [1, 2, 3]) {
      await http('POST', '/notes', { title: `note-${n}`, body: 'b', parent_id: notebookId });
    }

    const list = await http('GET', `/notes?parent_id=${notebookId}&order_by=title&order_dir=asc&limit=2`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.has_more).toBe(true);
    expect(Object.keys(list.body.items[0]).sort()).toEqual(['id', 'parent_id', 'title', 'updated_time']);

    const page2 = await http('GET', `/notes?parent_id=${notebookId}&order_by=title&order_dir=asc&limit=2&page=2`);
    expect(page2.body.items.length).toBeGreaterThanOrEqual(1);
    expect(page2.body.has_more).toBe(false);

    const titles = [...list.body.items, ...page2.body.items].map((i: { title: string }) => i.title);
    expect(titles).toEqual([...titles].sort());

    const withFields = await http('GET', `/notes?parent_id=${notebookId}&fields=id,body&limit=1`);
    expect(Object.keys(withFields.body.items[0]).sort()).toEqual(['body', 'id']);

    expect((await http('GET', '/notes?limit=1001')).status).toBe(400);
    expect((await http('GET', '/notes?page=0')).status).toBe(400);
    expect((await http('GET', '/notes?order_by=sneaky')).status).toBe(400);
  });

  it('GET by id honors fields; PATCH merges and rejects server-managed fields', async () => {
    const note = (await http('POST', '/notes', { title: 'patch me', body: 'original', parent_id: notebookId })).body;

    const minimal = await http('GET', `/notes/${note.id}`);
    expect(Object.keys(minimal.body).sort()).toEqual(['id', 'parent_id', 'title', 'updated_time']);

    const wide = await http('GET', `/notes/${note.id}?fields=title,body,user_updated_time`);
    expect(wide.body.body).toBe('original');

    const patched = await http('PATCH', `/notes/${note.id}`, { title: 'patched' });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('patched');
    expect(patched.body.body).toBe('original'); // merge, not replace

    expect((await http('PATCH', `/notes/${note.id}`, { updated_time: 1 })).status).toBe(400);
    expect((await http('PATCH', `/notes/${note.id}`, { created_time: 1 })).status).toBe(400);
    expect((await http('PATCH', `/notes/${note.id}`, { encryption_applied: 1 })).status).toBe(400);
    expect((await http('PATCH', `/notes/${note.id}`, { user_data: '{}' })).status).toBe(400);
    expect((await http('PATCH', `/notes/${note.id}`, { nonsense: true })).status).toBe(400);
    expect((await http('PATCH', `/notes/${note.id}`, { id: 'b'.repeat(32) })).status).toBe(400);

    // user_* timestamps ARE writable
    const t = 1700000000000;
    const userTime = await http('PATCH', `/notes/${note.id}`, { user_created_time: t });
    expect(userTime.status).toBe(200);
    expect(userTime.body.user_created_time).toBe(t);
  });

  it('trash → exclude → include_deleted → restore → permanent delete', async () => {
    const note = (await http('POST', '/notes', { title: 'trashable', body: '', parent_id: notebookId })).body;

    expect((await http('DELETE', `/notes/${note.id}`)).status).toBe(204);

    const list = await http('GET', `/notes?parent_id=${notebookId}&limit=1000`);
    expect(list.body.items.find((i: { id: string }) => i.id === note.id)).toBeUndefined();

    const withDeleted = await http('GET', `/notes?parent_id=${notebookId}&include_deleted=true&fields=id,deleted_time&limit=1000`);
    const trashed = withDeleted.body.items.find((i: { id: string }) => i.id === note.id);
    expect(trashed.deleted_time).toBeGreaterThan(0);

    const restored = await http('POST', `/notes/${note.id}/restore`);
    expect(restored.status).toBe(200);

    const restoredFull = await http('GET', `/notes/${note.id}?fields=deleted_time`);
    expect(restoredFull.body.deleted_time).toBe(0);

    // restoring a live note is a conflict
    expect((await http('POST', `/notes/${note.id}/restore`)).status).toBe(409);

    expect((await http('DELETE', `/notes/${note.id}?permanent=true`)).status).toBe(204);
    expect((await http('GET', `/notes/${note.id}`)).status).toBe(404);
  });

  it('notebook trash cascades and restore brings children back', async () => {
    const nb = (await http('POST', '/notebooks', { title: 'cascade' })).body;
    const child = (await http('POST', '/notes', { title: 'inside', body: '', parent_id: nb.id })).body;

    expect((await http('DELETE', `/notebooks/${nb.id}`)).status).toBe(204);

    const childAfter = await http('GET', `/notes/${child.id}?fields=deleted_time`);
    expect(childAfter.body.deleted_time).toBeGreaterThan(0);

    expect((await http('POST', `/notebooks/${nb.id}/restore`)).status).toBe(200);
    const childRestored = await http('GET', `/notes/${child.id}?fields=deleted_time`);
    expect(childRestored.body.deleted_time).toBe(0);
  });

  it('404s with envelope on missing and malformed ids', async () => {
    const missing = await http('GET', `/notes/${'0'.repeat(32)}`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: { code: 'not_found', message: expect.any(String) } });
    expect((await http('GET', '/notes/not-an-id')).status).toBe(404);
  });
});

describe('tags', () => {
  let notebookId: string;
  let noteId: string;
  let tagId: string;

  beforeAll(async () => {
    notebookId = (await http('POST', '/notebooks', { title: 'Tag home' })).body.id;
    noteId = (await http('POST', '/notes', { title: 'taggable', body: '', parent_id: notebookId })).body.id;
  });

  it('creates tags', async () => {
    const res = await http('POST', '/tags', { title: 'alpha' });
    expect(res.status).toBe(201);
    tagId = res.body.id;
    expect(res.body.title).toBe('alpha');
  });

  it('attaches, lists both directions, detaches', async () => {
    expect((await http('POST', `/tags/${tagId}/notes`, { id: noteId })).status).toBe(204);

    const noteTags = await http('GET', `/notes/${noteId}/tags?fields=id,title`);
    expect(noteTags.body.items).toEqual([{ id: tagId, title: 'alpha' }]);

    const tagNotes = await http('GET', `/tags/${tagId}/notes?fields=id,title`);
    expect(tagNotes.body.items).toEqual([{ id: noteId, title: 'taggable' }]);

    expect((await http('POST', `/tags/${tagId}/notes`, { id: 'nope' })).status).toBe(400);
    expect((await http('POST', `/tags/${'1'.repeat(32)}/notes`, { id: noteId })).status).toBe(404);

    expect((await http('DELETE', `/tags/${tagId}/notes/${noteId}`)).status).toBe(204);
    expect((await http('GET', `/notes/${noteId}/tags`)).body.items).toEqual([]);
  });

  it('tag DELETE is always permanent and detaches notes', async () => {
    expect((await http('POST', `/tags/${tagId}/notes`, { id: noteId })).status).toBe(204);
    expect((await http('DELETE', `/tags/${tagId}`)).status).toBe(204);
    expect((await http('GET', `/tags/${tagId}`)).status).toBe(404);
    expect((await http('GET', `/notes/${noteId}/tags`)).body.items).toEqual([]);
    // no restore for tags
    expect((await http('POST', `/tags/${tagId}/restore`)).status).toBe(404);
  });
});

describe('auth on data routes', () => {
  it('401s without a token', async () => {
    const res = await http('GET', '/notes', undefined, false);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });
});
