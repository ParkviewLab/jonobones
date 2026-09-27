// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Exercises the polling route (GET /events) against a real, on-disk journal
// that is deleted and recreated exactly as an operator would while the
// daemon is stopped (see docs/operations.md). This builds the Fastify app
// directly around an EventJournal/EventHub pair rather than going through
// startDaemon: @joplin/lib is process-global (src/joplin/bootstrap.ts), so a
// full daemon can be started at most once per process, which the
// stop-delete-restart cycle this test needs would violate.

import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer, startServer } from '../../src/api/server.js';
import { EventHub } from '../../src/events/hub.js';
import { EventJournal } from '../../src/events/journal.js';
import type { Config } from '../../src/config/types.js';
import type { JoplinContext } from '../../src/joplin/bootstrap.js';
import type { FastifyInstance } from 'fastify';

const TOKEN = 'journal-recreation-token';
const config: Config = {
  api: { port: 0, bind: '127.0.0.1', token: TOKEN },
  sync: { target: 'filesystem', interval: 0 },
  e2ee: {},
  events: { retentionDays: 30 },
};

let dir: string | null = null;
let journal: EventJournal | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  await journal?.close();
  journal = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function serve(path: string): Promise<{ journal: EventJournal; base: string }> {
  journal = await EventJournal.open(path);
  const hub = new EventHub(journal);
  // registerEventRoutes only needs `hub`; the joplin object is never
  // dereferenced for it, only checked for truthiness by buildServer.
  app = buildServer(config, {} as JoplinContext, null, hub);
  const address = await startServer(app, config);
  return { journal, base: `${address}/v1` };
}

async function http(base: string, method: string, path: string) {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

describe('a journal deleted and recreated while stopped (fault fixed 2026-09-27)', () => {
  it('resets a client whose cursor came from the deleted journal, over polling', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jonobones-journal-recreate-test-'));
    const path = join(dir, 'events.sqlite');

    const first = await serve(path);
    for (let i = 0; i < 5; i++) {
      await first.journal.append({
        item_type: 'note',
        item_id: i.toString(16).padStart(32, '0'),
        change_type: 'update',
        source: 'api',
      });
    }
    const staleCursor = (await first.journal.newestId())!;
    await app!.close();
    app = null;
    await first.journal.close();
    journal = null;

    // "an operator deletes the journal file while the daemon is stopped"
    unlinkSync(path);

    const second = await serve(path);
    for (let i = 0; i < 8; i++) {
      await second.journal.append({
        item_type: 'note',
        item_id: `b${i}`.padStart(32, '0'),
        change_type: 'create',
        source: 'sync',
      });
    }

    const res = await http(second.base, 'GET', `/events?cursor=${staleCursor}`);
    expect(res.body.reset).toBe(true);
    expect(res.body.items).toEqual([]);
    expect(res.body.cursor).toBe(await second.journal.newestId());
    // The recreated journal's ids share nothing with the deleted one's.
    expect(await second.journal.oldestId()).toBeGreaterThan(1_000_000_000_000);
  });
});
