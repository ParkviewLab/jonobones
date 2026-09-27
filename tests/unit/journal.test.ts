// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventJournal, type NewEvent } from '../../src/events/journal.js';

const sqlite3 = createRequire(import.meta.url)('sqlite3');

let dir: string | null = null;
let journal: EventJournal | null = null;

afterEach(async () => {
  await journal?.close();
  journal = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function open(): Promise<EventJournal> {
  dir = mkdtempSync(join(tmpdir(), 'jonobones-journal-test-'));
  journal = await EventJournal.open(join(dir, 'events.sqlite'));
  return journal;
}

const ev = (n: number): NewEvent => ({
  item_type: 'note',
  item_id: n.toString(16).padStart(32, '0'),
  change_type: 'update',
  source: 'api',
});

// Builds a journal file exactly as a pre-fix jonobones would have left one:
// an `events` table with one row already inserted (so `sqlite_sequence`
// already carries a row for it) and no `journal_meta` at all.
function seedPreFixJournal(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (openErr: Error | null) => {
      if (openErr) return reject(openErr);
      db.exec(
        `CREATE TABLE events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           item_type TEXT NOT NULL,
           item_id TEXT NOT NULL,
           change_type TEXT NOT NULL,
           source TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         INSERT INTO events (item_type, item_id, change_type, source, created_at)
         VALUES ('note', '${'a'.repeat(32)}', 'update', 'api', 1000);`,
        (execErr: Error | null) => {
          db.close((closeErr: Error | null) => (execErr || closeErr ? reject(execErr ?? closeErr) : resolve()));
        },
      );
    });
  });
}

describe('EventJournal', () => {
  it('appends with increasing ids and lists after a cursor', async () => {
    const j = await open();
    const a = await j.append(ev(1));
    const b = await j.append(ev(2));
    expect(b.id).toBe(a.id + 1);

    const all = await j.listAfter(0, 10);
    expect(all.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(await j.listAfter(a.id, 10)).toHaveLength(1);
    expect(await j.oldestId()).toBe(a.id);
    expect(await j.newestId()).toBe(b.id);
  });

  it('prunes by age and reports resumability honestly', async () => {
    const j = await open();
    const old = await j.append(ev(1), 1_000); // ancient
    await j.append(ev(2), Date.now());

    expect(await j.isResumable(old.id)).toBe(true);

    const pruned = await j.pruneOlderThan(2_000);
    expect(pruned).toBe(1);

    // Events after the pruned one survive, so cursor=old.id is still fine,
    // but anything older is not.
    expect(await j.isResumable(old.id)).toBe(true);
    expect(await j.isResumable(0)).toBe(false);

    // A cursor in the future is never resumable.
    expect(await j.isResumable(999)).toBe(false);
  });

  it('empty journal: cursor 0 is resumable, others are not', async () => {
    const j = await open();
    expect(await j.isResumable(0)).toBe(true);
    expect(await j.isResumable(3)).toBe(false);
  });

  it('persists meta and known-id snapshots', async () => {
    const j = await open();
    expect(await j.getMeta('k')).toBeNull();
    await j.setMeta('k', '42');
    await j.setMeta('k', '43');
    expect(await j.getMeta('k')).toBe('43');

    await j.replaceKnownIds('note', ['a', 'b']);
    await j.replaceKnownIds('tag', ['t']);
    expect(await j.knownIds('note')).toEqual(new Set(['a', 'b']));
    await j.replaceKnownIds('note', ['b', 'c']);
    expect(await j.knownIds('note')).toEqual(new Set(['b', 'c']));
    expect(await j.knownIds('tag')).toEqual(new Set(['t']));
  });

  it('seeds a fresh journal far above a safe-integer floor, ids increasing by one', async () => {
    const j = await open();
    const a = await j.append(ev(1));
    const b = await j.append(ev(2));
    expect(Number.isSafeInteger(a.id)).toBe(true);
    expect(Number.isSafeInteger(b.id)).toBe(true);
    expect(b.id).toBe(a.id + 1);
    // Date.now() * 1000 is on the order of 1.8e15; a pre-fix journal could
    // never have reached anywhere near that many rows.
    expect(a.id).toBeGreaterThan(1_000_000_000_000);
    expect(await j.getMeta('first_id_base')).toBe(String(a.id - 1));
  });

  it('cursor 0 is resumable on a fresh (seeded) journal until something is pruned', async () => {
    const j = await open();
    expect(await j.isResumable(0)).toBe(true); // empty

    const old = await j.append(ev(1), 1_000); // ancient
    await j.append(ev(2), Date.now());
    expect(await j.isResumable(0)).toBe(true); // nothing pruned yet

    const pruned = await j.pruneOlderThan(2_000);
    expect(pruned).toBe(1);
    expect(await j.isResumable(0)).toBe(false); // the oldest retained id moved past the seeded base + 1

    // The cursor sitting right at the pruned event is still fine, per the
    // existing (unrelated to cursor 0) branch of isResumable.
    expect(await j.isResumable(old.id)).toBe(true);
  });

  it('an existing (unseeded) journal keeps numbering from 1, untouched by the fix', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jonobones-journal-test-'));
    const path = join(dir, 'events.sqlite');
    await seedPreFixJournal(path); // one event already at id 1, as a pre-fix journal would have

    journal = await EventJournal.open(path);
    expect(await journal.getMeta('first_id_base')).toBeNull();
    expect(await journal.oldestId()).toBe(1);

    const next = await journal.append(ev(2));
    expect(next.id).toBe(2);
    expect(await journal.isResumable(0)).toBe(true);
    expect(await journal.isResumable(1)).toBe(true);
  });

  it('a journal recreated after deletion is seeded far above the old one, resetting a stale cursor', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jonobones-journal-test-'));
    const path = join(dir, 'events.sqlite');
    const nowSpy = vi.spyOn(Date, 'now');

    try {
      nowSpy.mockReturnValue(1_700_000_000_000); // the old journal's moment
      let j = await EventJournal.open(path);
      for (let i = 1; i <= 5; i++) await j.append(ev(i));
      const staleCursor = (await j.newestId())!;
      await j.close();

      rmSync(path); // "an operator deletes the journal file while the daemon is stopped"

      nowSpy.mockReturnValue(1_700_000_000_001); // recreated a moment later
      journal = j = await EventJournal.open(path);
      for (let i = 6; i <= 13; i++) await j.append(ev(i)); // 8 new events, as reproduced

      // Reproduced fault: the old code let this resolve to true and served
      // ids 6..8 of the *new* journal as if they continued the old one.
      expect(await j.isResumable(staleCursor)).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
