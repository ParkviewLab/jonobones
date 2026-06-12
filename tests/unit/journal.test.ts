import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventJournal, type NewEvent } from '../../src/events/journal.js';

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
});
