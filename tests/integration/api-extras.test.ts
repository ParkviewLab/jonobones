import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import type { Config } from '../../src/config/types.js';

const TOKEN = 'extras-token';

let profileDir: string;
let daemon: DaemonHandle;
let base: string;

beforeAll(async () => {
  profileDir = mkdtempSync(join(tmpdir(), 'jonobones-extras-test-'));
  const config: Config = {
    api: { port: 0, bind: '127.0.0.1', token: TOKEN },
    sync: { target: 'none', interval: 0 },
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
  headers: Headers;
}

async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text), headers: res.headers };
}

describe('userdata envelope', () => {
  let notebookId: string;
  let noteId: string;

  beforeAll(async () => {
    notebookId = (await http('POST', '/notebooks', { title: 'ud home' })).body.id;
    noteId = (await http('POST', '/notes', { title: 'ud note', body: '', parent_id: notebookId })).body.id;
  });

  it('PUT, GET key, GET namespace', async () => {
    const put = await http('PUT', `/notes/${noteId}/userdata/myapp/color`, { value: 'teal' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ value: 'teal' });

    const got = await http('GET', `/notes/${noteId}/userdata/myapp/color`);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ value: 'teal' });

    await http('PUT', `/notes/${noteId}/userdata/myapp/coords`, { value: { x: 1, y: [2, 3] } });
    const ns = await http('GET', `/notes/${noteId}/userdata/myapp`);
    expect(ns.status).toBe(200);
    expect(ns.body).toEqual({ color: 'teal', coords: { x: 1, y: [2, 3] } });

    const otherNs = await http('GET', `/notes/${noteId}/userdata/elsewhere`);
    expect(otherNs.body).toEqual({});
  });

  it('writes the proper Joplin envelope (v/t entries) into raw user_data', async () => {
    const raw = await http('GET', `/notes/${noteId}?fields=user_data`);
    const envelope = JSON.parse(raw.body.user_data);
    expect(envelope.myapp.color.v).toBe('teal');
    expect(envelope.myapp.color.t).toBeGreaterThan(0);
    expect(envelope.myapp.color.d).toBeUndefined();
  });

  it('DELETE leaves a tombstone (d:1), GET turns 404', async () => {
    expect((await http('DELETE', `/notes/${noteId}/userdata/myapp/color`)).status).toBe(204);
    expect((await http('GET', `/notes/${noteId}/userdata/myapp/color`)).status).toBe(404);

    const ns = await http('GET', `/notes/${noteId}/userdata/myapp`);
    expect(ns.body.color).toBeUndefined();
    expect(ns.body.coords).toEqual({ x: 1, y: [2, 3] });

    const raw = await http('GET', `/notes/${noteId}?fields=user_data`);
    const envelope = JSON.parse(raw.body.user_data);
    expect(envelope.myapp.color.d).toBe(1); // tombstone, not removal
  });

  it('userdata writes bump updated_time so they sync', async () => {
    const before = (await http('GET', `/notes/${noteId}?fields=updated_time`)).body.updated_time;
    await new Promise((r) => setTimeout(r, 5));
    await http('PUT', `/notes/${noteId}/userdata/myapp/bump`, { value: 1 });
    const after = (await http('GET', `/notes/${noteId}?fields=updated_time`)).body.updated_time;
    expect(after).toBeGreaterThan(before);
  });

  it('works on notebooks, tags and validates inputs', async () => {
    const nb = await http('PUT', `/notebooks/${notebookId}/userdata/myapp/k`, { value: 7 });
    expect(nb.status).toBe(200);

    const tagId = (await http('POST', '/tags', { title: 'ud-tag' })).body.id;
    expect((await http('PUT', `/tags/${tagId}/userdata/myapp/k`, { value: true })).status).toBe(200);
    expect((await http('GET', `/tags/${tagId}/userdata/myapp/k`)).body).toEqual({ value: true });

    expect((await http('PUT', `/notes/${noteId}/userdata/myapp/key`, { notValue: 1 })).status).toBe(400);
    expect((await http('PUT', `/notes/${noteId}/userdata/myapp/${'k'.repeat(256)}`, { value: 1 })).status).toBe(400);
    expect((await http('PUT', `/notes/${'9'.repeat(32)}/userdata/ns/k`, { value: 1 })).status).toBe(404);
  });
});

describe('resources', () => {
  let resourceId: string;
  const FILE_BYTES = 'jonobones resource payload — 草 🦴\n';

  it('uploads via multipart and echoes metadata', async () => {
    const form = new FormData();
    form.append('props', JSON.stringify({ title: 'hello.txt' }));
    form.append('data', new Blob([FILE_BYTES], { type: 'text/plain' }), 'hello.txt');

    const res = await fetch(`${base}/resources`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(res.status).toBe(201);
    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(body.title).toBe('hello.txt');
    expect(body.mime).toBe('text/plain');
    expect(body.size).toBeGreaterThan(0);
    resourceId = body.id;
  });

  it('downloads the identical blob with content headers', async () => {
    const res = await fetch(`${base}/resources/${resourceId}/file`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(FILE_BYTES);
  });

  it('lists and gets resources with §5.1 conventions', async () => {
    const list = await http('GET', '/resources?fields=id,title,mime');
    expect(list.body.items.some((r: { id: string }) => r.id === resourceId)).toBe(true);

    const got = await http('GET', `/resources/${resourceId}`);
    expect(Object.keys(got.body).sort()).toEqual(['id', 'title', 'updated_time']);
  });

  it('appears under /notes/:id/resources when linked from a note body', async () => {
    const nbId = (await http('POST', '/notebooks', { title: 'res home' })).body.id;
    const note = (
      await http('POST', '/notes', {
        title: 'with attachment',
        body: `see [file](:/${resourceId})`,
        parent_id: nbId,
      })
    ).body;

    const linked = await http('GET', `/notes/${note.id}/resources?fields=id,mime`);
    expect(linked.body.items).toEqual([{ id: resourceId, mime: 'text/plain' }]);
  });

  it('PATCH allows title and user_* only; DELETE is permanent', async () => {
    expect((await http('PATCH', `/resources/${resourceId}`, { title: 'renamed.txt' })).body.title).toBe('renamed.txt');
    expect((await http('PATCH', `/resources/${resourceId}`, { mime: 'image/png' })).status).toBe(400);
    expect((await http('PATCH', `/resources/${resourceId}`, { size: 1 })).status).toBe(400);

    // userdata works on resources too (§5.7 includes them)
    expect((await http('PUT', `/resources/${resourceId}/userdata/myapp/k`, { value: 'r' })).status).toBe(200);

    expect((await http('DELETE', `/resources/${resourceId}`)).status).toBe(204);
    expect((await http('GET', `/resources/${resourceId}`)).status).toBe(404);
    expect((await http('GET', `/resources/${resourceId}/file`)).status).toBe(404);
  });

  it('accepts caller-chosen ids and 400s without a data part', async () => {
    const id = 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
    const form = new FormData();
    form.append('props', JSON.stringify({ id }));
    form.append('data', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    const res = await fetch(`${base}/resources`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe(id);

    const empty = new FormData();
    empty.append('props', '{}');
    const bad = await fetch(`${base}/resources`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: empty,
    });
    expect(bad.status).toBe(400);
  });
});

describe('search', () => {
  it('finds notes by body content', async () => {
    const nbId = (await http('POST', '/notebooks', { title: 'search home' })).body.id;
    await http('POST', '/notes', { title: 'fruit one', body: 'a ripe banana for breakfast', parent_id: nbId });
    await http('POST', '/notes', { title: 'fruit two', body: 'a bowl of cherries', parent_id: nbId });

    const hit = await http('GET', '/search?q=banana&fields=id,title');
    expect(hit.status).toBe(200);
    expect(hit.body.items).toHaveLength(1);
    expect(hit.body.items[0].title).toBe('fruit one');

    expect((await http('GET', '/search')).status).toBe(400);
    expect((await http('GET', '/search?q=banana&limit=0')).status).toBe(400);
  });
});

describe('revisions and conflicts', () => {
  it('GET /revisions returns the (empty) table with conventions applied', async () => {
    const res = await http('GET', '/revisions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], has_more: false });
  });

  it('GET /conflicts lists is_conflict notes including conflict_original_id', async () => {
    expect((await http('GET', '/conflicts')).body.items).toEqual([]);

    // Conflicts are produced by sync, not the API — plant one through the
    // lib (as a sync cycle would) to verify the read path.
    const nbId = (await http('POST', '/notebooks', { title: 'conf home' })).body.id;
    const original = (await http('POST', '/notes', { title: 'orig', body: '', parent_id: nbId })).body;
    await daemon.joplin.lib.Note.save({
      title: 'orig (conflict copy)',
      body: 'remote version',
      parent_id: nbId,
      is_conflict: 1,
      conflict_original_id: original.id,
    });

    const res = await http('GET', '/conflicts');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].conflict_original_id).toBe(original.id);

    // conflict copies never appear in normal note lists
    const list = await http('GET', '/notes?limit=1000&fields=id,title');
    expect(list.body.items.some((n: { title: string }) => n.title.includes('conflict copy'))).toBe(false);
  });
});
