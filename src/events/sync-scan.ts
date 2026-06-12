// Post-sync delta scan: after each sync cycle, find what changed in the
// Joplin tables and emit thin events for it.
//
// - creates/updates (incl. soft trash — deleted_time is just an update):
//   rows with updated_time > checkpoint. Joplin 3.x deletes are mostly soft,
//   so this catches them.
// - remote PERMANENT deletes never bump a surviving row, so they are
//   detected by id reconciliation: diff current table ids against the
//   known_items snapshot taken after the previous scan. This was chosen
//   over consuming Joplin's item_changes rows (type 3) because item_changes
//   coverage for folders/tags is unverified upstream, while the id diff is
//   dependable for every type by construction.
// - API-sourced events since the checkpoint are already in the journal, so
//   those item ids are skipped here (a client following the stream already
//   re-fetched them; thin events make this safe).

import type { JoplinContext } from '../joplin/bootstrap.js';
import type { EventHub } from './hub.js';
import type { EventItemType } from './journal.js';

const TABLES: { table: string; itemType: EventItemType; conditions?: string }[] = [
  { table: 'notes', itemType: 'note' },
  { table: 'folders', itemType: 'notebook' },
  { table: 'tags', itemType: 'tag' },
  { table: 'resources', itemType: 'resource' },
];

const CHECKPOINT_KEY = 'sync_scan_checkpoint';

export async function runPostSyncScan(ctx: JoplinContext, hub: EventHub): Promise<void> {
  const journal = hub.journal;
  const checkpointRaw = await journal.getMeta(CHECKPOINT_KEY);
  const checkpoint = checkpointRaw ? parseInt(checkpointRaw, 10) : 0;
  const firstScan = checkpointRaw === null;

  // Item ids the API already announced since the checkpoint.
  const apiAnnounced = new Set<string>();
  if (!firstScan) {
    let cursor = 0;
    for (;;) {
      const page = await journal.listAfter(cursor, 1000);
      if (!page.length) break;
      for (const event of page) {
        if (event.source === 'api') apiAnnounced.add(`${event.item_type}:${event.item_id}`);
        cursor = event.id;
      }
    }
  }

  let newCheckpoint = checkpoint;

  for (const { table, itemType } of TABLES) {
    const rows = (await ctx.lib.Note.modelSelectAll(
      `SELECT id, created_time, updated_time FROM ${table} WHERE updated_time > ?`,
      [checkpoint],
    )) as { id: string; created_time: number; updated_time: number }[];

    const known = await journal.knownIds(itemType);

    for (const row of rows) {
      if (row.updated_time > newCheckpoint) newCheckpoint = row.updated_time;
      if (apiAnnounced.has(`${itemType}:${row.id}`)) continue;
      // The first scan after init would announce the entire knowledge base;
      // skip it (clients snapshot first anyway) and just take the snapshot.
      if (firstScan) continue;
      await hub.publish({
        item_type: itemType,
        item_id: row.id,
        // In the previous snapshot → it changed; not there → it appeared.
        change_type: known.has(row.id) ? 'update' : 'create',
        source: 'sync',
      });
    }

    // Reconciliation: ids that vanished since the last snapshot were
    // permanently deleted (locally via API — already announced — or
    // remotely via sync).
    const currentRows = (await ctx.lib.Note.modelSelectAll(`SELECT id FROM ${table}`, [])) as { id: string }[];
    const currentIds = currentRows.map((r) => r.id);
    const currentSet = new Set(currentIds);

    if (!firstScan) {
      for (const knownId of known) {
        if (currentSet.has(knownId)) continue;
        if (apiAnnounced.has(`${itemType}:${knownId}`)) continue;
        await hub.publish({ item_type: itemType, item_id: knownId, change_type: 'delete', source: 'sync' });
      }
    }

    await journal.replaceKnownIds(itemType, currentIds);
  }

  await journal.setMeta(CHECKPOINT_KEY, String(newCheckpoint));
}
