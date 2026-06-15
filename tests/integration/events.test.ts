// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../../src/daemon.js';
import type { Config } from '../../src/config/types.js';
import type { JournalEvent } from '../../src/events/journal.js';

const TOKEN = 'events-token';
const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const spikePath = join(repoRoot, 'spike', 'lib-spike.mjs');

let workDir: string;
let syncDir: string;
let daemon: DaemonHandle;
let base: string;

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
  for (let i = 0; i < 120; i++) {
    const status = await http('GET', '/status');
    if (status.body.sync.state === 'idle' && status.body.sync.lastCompletedAt) return;
    if (status.body.sync.state === 'error') throw new Error(status.body.sync.lastResult);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('sync did not reach idle');
}

async function allEvents(): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = await http('GET', `/events?cursor=${cursor}&limit=1000`);
    out.push(...page.body.items);
    if (!page.body.has_more) return out;
    cursor = page.body.cursor;
  }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'jonobones-events-test-'));
  syncDir = join(workDir, 'sync-target');
  const config: Config = {
    api: { port: 0, bind: '127.0.0.1', token: TOKEN },
    sync: { target: 'filesystem', interval: 0, path: syncDir },
    e2ee: {},
    events: { retentionDays: 30 },
  };
  daemon = await startDaemon({ profileDir: join(workDir, 'profile'), config, writeLock: false, autoSync: false });
  base = `http://127.0.0.1:${daemon.port}/v1`;
  // Establish the scan checkpoint/known-ids baseline before the tests write.
  await syncAndWaitIdle();
}, 120_000);

afterAll(async () => {
  await daemon?.stop();
  rmSync(workDir, { recursive: true, force: true });
});

describe('API-sourced events', () => {
  it('records create/update/trash/restore/permanent-delete with source api', async () => {
    const nb = (await http('POST', '/notebooks', { title: 'ev home' })).body;
    const note = (await http('POST', '/notes', { title: 'ev note', body: '', parent_id: nb.id })).body;
    await http('PATCH', `/notes/${note.id}`, { title: 'ev note 2' });
    await http('DELETE', `/notes/${note.id}`); // trash → update
    await http('POST', `/notes/${note.id}/restore`);
    await http('DELETE', `/notes/${note.id}?permanent=true`); // delete

    const events = await allEvents();
    const forNote = events.filter((e) => e.item_id === note.id);
    expect(forNote.map((e) => e.change_type)).toEqual(['create', 'update', 'update', 'update', 'delete']);
    expect(new Set(forNote.map((e) => e.source))).toEqual(new Set(['api']));
    expect(events.find((e) => e.item_id === nb.id)?.change_type).toBe('create');

    // ids strictly increase
    const ids = events.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('userdata writes and tag attach/detach emit note updates', async () => {
    const nb = (await http('POST', '/notebooks', { title: 'ev ud' })).body;
    const note = (await http('POST', '/notes', { title: 'ud target', body: '', parent_id: nb.id })).body;
    const tag = (await http('POST', '/tags', { title: 'ev-tag' })).body;

    const before = (await allEvents()).length;
    await http('PUT', `/notes/${note.id}/userdata/app/k`, { value: 1 });
    await http('POST', `/tags/${tag.id}/notes`, { id: note.id });
    await http('DELETE', `/tags/${tag.id}/notes/${note.id}`);

    const after = await allEvents();
    const fresh = after.slice(before);
    expect(fresh.filter((e) => e.item_id === note.id && e.change_type === 'update')).toHaveLength(3);
  });

  it('paginates with cursor and has_more', async () => {
    const first = await http('GET', '/events?cursor=0&limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.has_more).toBe(true);
    const second = await http('GET', `/events?cursor=${first.body.cursor}&limit=1000`);
    expect(second.body.items[0].id).toBe(first.body.items[1].id + 1);
  });

  it('resets on a future cursor', async () => {
    const res = await http('GET', '/events?cursor=999999');
    expect(res.body.reset).toBe(true);
    expect(typeof res.body.cursor).toBe('number');
  });
});

describe('SSE', () => {
  it('replays from Last-Event-ID, then streams live events', { timeout: 30_000 }, async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events?token=${TOKEN}`, {
      headers: { accept: 'text/event-stream', 'last-event-id': '0' },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames: { id?: string; event?: string; data?: string }[] = [];

    const readUntil = async (predicate: () => boolean) => {
      const deadline = Date.now() + 20_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`SSE timeout; got ${JSON.stringify(frames.slice(-3))}`);
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream ended unexpectedly');
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const sep = buffer.indexOf('\n\n');
          if (sep === -1) break;
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (block.startsWith(':')) continue; // heartbeat
          if (block.startsWith('retry:')) continue;
          const frame: { id?: string; event?: string; data?: string } = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = line.slice(6);
          }
          frames.push(frame);
        }
      }
    };

    // Replay: everything journaled so far arrives first.
    const journaledCount = (await allEvents()).length;
    await readUntil(() => frames.length >= journaledCount);
    expect(frames[0]!.event).toBe('change');
    expect(JSON.parse(frames[0]!.data!).id).toBe(parseInt(frames[0]!.id!, 10));

    // Live: a new API write arrives over the open stream.
    const nb = (await http('POST', '/notebooks', { title: 'sse live' })).body;
    await readUntil(() => frames.some((f) => f.data?.includes(nb.id)));
    const live = frames.find((f) => f.data?.includes(nb.id))!;
    expect(JSON.parse(live.data!)).toMatchObject({
      item_type: 'notebook',
      item_id: nb.id,
      change_type: 'create',
      source: 'api',
    });

    controller.abort();
  });

  it('sends a reset frame for a stale (future) cursor', { timeout: 15_000 }, async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/events?token=${TOKEN}&cursor=999999`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 10_000;
    while (!text.includes('event: reset') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain('event: reset');
    expect(text).toContain('resumeFrom');
    controller.abort();
  });
});

describe('sync-sourced events', () => {
  it('announces items arriving via sync with source sync', { timeout: 60_000 }, async () => {
    const seed = spawnSync(
      process.execPath,
      [spikePath, 'seed', '--profile', join(workDir, 'peer'), '--sync-dir', syncDir, '--title', 'sse-peer-note'],
      { encoding: 'utf8' },
    );
    expect(seed.status).toBe(0);

    await syncAndWaitIdle();

    const events = await allEvents();
    const syncCreates = events.filter((e) => e.source === 'sync' && e.change_type === 'create');
    expect(syncCreates.some((e) => e.item_type === 'note')).toBe(true);
    expect(syncCreates.some((e) => e.item_type === 'notebook')).toBe(true);
  });

  it('detects remote permanent deletes via id reconciliation', { timeout: 60_000 }, async () => {
    // Find the peer's note id from the previous test's sync events.
    const events = await allEvents();
    const noteCreate = events.find((e) => e.source === 'sync' && e.item_type === 'note' && e.change_type === 'create')!;

    // A remote permanent delete = the item file vanishing from the target.
    unlinkSync(join(syncDir, `${noteCreate.item_id}.md`));

    await syncAndWaitIdle();

    const after = await allEvents();
    const deletion = after.find(
      (e) => e.item_id === noteCreate.item_id && e.change_type === 'delete' && e.source === 'sync',
    );
    expect(deletion).toBeDefined();
    // And the note is really gone locally.
    expect((await http('GET', `/notes/${noteCreate.item_id}`)).status).toBe(404);
  });
});

describe('/status events section', () => {
  it('reports oldest/newest journal ids', async () => {
    const res = await http('GET', '/status');
    expect(res.body.events.oldestId).toBe(1);
    expect(res.body.events.newestId).toBeGreaterThan(1);
  });
});
