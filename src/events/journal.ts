// jonobones' own event journal: a separate SQLite file in the jonobones
// profile dir. NEVER a table inside Joplin's database.sqlite — the Joplin
// profile must remain 100% stock (the prime axiom).

import { createRequire } from 'node:module';

const sqlite3 = createRequire(import.meta.url)('sqlite3');

export type EventItemType = 'note' | 'notebook' | 'tag' | 'resource';
export type EventChangeType = 'create' | 'update' | 'delete';
export type EventSource = 'api' | 'sync';

export interface JournalEvent {
  id: number;
  item_type: EventItemType;
  item_id: string;
  change_type: EventChangeType;
  source: EventSource;
}

export interface NewEvent {
  item_type: EventItemType;
  item_id: string;
  change_type: EventChangeType;
  source: EventSource;
}

interface SqliteDb {
  run(sql: string, params: unknown[], cb: (this: { lastID: number }, err: Error | null) => void): void;
  all(sql: string, params: unknown[], cb: (err: Error | null, rows: unknown[]) => void): void;
  get(sql: string, params: unknown[], cb: (err: Error | null, row: unknown) => void): void;
  exec(sql: string, cb: (err: Error | null) => void): void;
  close(cb: (err: Error | null) => void): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE TABLE IF NOT EXISTS journal_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS known_items (
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (item_type, item_id)
);
`;

export class EventJournal {
  private constructor(private readonly db: SqliteDb) {}

  public static async open(path: string): Promise<EventJournal> {
    const db: SqliteDb = await new Promise((resolve, reject) => {
      const handle = new sqlite3.Database(path, (err: Error | null) => {
        if (err) reject(err);
        else resolve(handle as SqliteDb);
      });
    });
    const journal = new EventJournal(db);
    await journal.exec(SCHEMA);
    return journal;
  }

  private exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => this.db.exec(sql, (err) => (err ? reject(err) : resolve())));
  }

  private run(sql: string, params: unknown[]): Promise<number> {
    return new Promise((resolve, reject) =>
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }),
    );
  }

  private all<T>(sql: string, params: unknown[]): Promise<T[]> {
    return new Promise((resolve, reject) =>
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[]))),
    );
  }

  private get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    return new Promise((resolve, reject) =>
      this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined))),
    );
  }

  public async append(event: NewEvent, at = Date.now()): Promise<JournalEvent> {
    const id = await this.run(
      'INSERT INTO events (item_type, item_id, change_type, source, created_at) VALUES (?, ?, ?, ?, ?)',
      [event.item_type, event.item_id, event.change_type, event.source, at],
    );
    return { id, ...event };
  }

  public async listAfter(cursor: number, limit: number): Promise<JournalEvent[]> {
    return this.all<JournalEvent>(
      'SELECT id, item_type, item_id, change_type, source FROM events WHERE id > ? ORDER BY id ASC LIMIT ?',
      [cursor, limit],
    );
  }

  public async oldestId(): Promise<number | null> {
    const row = await this.get<{ id: number }>('SELECT MIN(id) as id FROM events', []);
    return row?.id ?? null;
  }

  public async newestId(): Promise<number | null> {
    const row = await this.get<{ id: number }>('SELECT MAX(id) as id FROM events', []);
    return row?.id ?? null;
  }

  /** A cursor is resumable iff every event after it is still retained. */
  public async isResumable(cursor: number): Promise<boolean> {
    if (cursor < 0) return false;
    const newest = await this.newestId();
    if (newest === null) return cursor === 0;
    if (cursor > newest) return false;
    if (cursor === 0) {
      // Resumable from the very beginning only if nothing was pruned yet.
      const oldest = await this.oldestId();
      return oldest === null || oldest === 1;
    }
    // The cursor row itself may be pruned; what matters is that no event
    // BETWEEN cursor and now was pruned, i.e. the oldest retained id is
    // <= cursor+1.
    const oldest = await this.oldestId();
    return oldest !== null && oldest <= cursor + 1;
  }

  public async pruneOlderThan(cutoffEpochMs: number): Promise<number> {
    const before = await this.get<{ n: number }>('SELECT COUNT(*) as n FROM events WHERE created_at < ?', [
      cutoffEpochMs,
    ]);
    await this.run('DELETE FROM events WHERE created_at < ?', [cutoffEpochMs]);
    return before?.n ?? 0;
  }

  public async getMeta(key: string): Promise<string | null> {
    const row = await this.get<{ value: string }>('SELECT value FROM journal_meta WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  public async setMeta(key: string, value: string): Promise<void> {
    await this.run('INSERT INTO journal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?', [
      key,
      value,
      value,
    ]);
  }

  /** Known-id snapshot used to detect remote permanent deletes. */
  public async knownIds(itemType: EventItemType): Promise<Set<string>> {
    const rows = await this.all<{ item_id: string }>('SELECT item_id FROM known_items WHERE item_type = ?', [
      itemType,
    ]);
    return new Set(rows.map((r) => r.item_id));
  }

  public async replaceKnownIds(itemType: EventItemType, ids: string[]): Promise<void> {
    await this.run('DELETE FROM known_items WHERE item_type = ?', [itemType]);
    for (const id of ids) {
      await this.run('INSERT OR IGNORE INTO known_items (item_type, item_id) VALUES (?, ?)', [itemType, id]);
    }
  }

  public async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.db.close((err) => (err ? reject(err) : resolve())));
  }
}
