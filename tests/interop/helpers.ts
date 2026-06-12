// Helpers for the interop suites: locate and drive the official `joplin`
// CLI, and read its profile database for assertions (we assert on the
// CLI's own database state — its sync wrote it — instead of parsing
// human-oriented CLI output).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const sqlite3 = createRequire(import.meta.url)('sqlite3');

export function resolveJoplinCli(): string | null {
  if (process.env.JOPLIN_CLI_BIN) return process.env.JOPLIN_CLI_BIN;
  try {
    const found = execFileSync('/bin/sh', ['-c', 'command -v joplin'], { encoding: 'utf8' }).trim();
    return found || null;
  } catch {
    return null;
  }
}

export class JoplinCli {
  public constructor(
    private readonly bin: string,
    public readonly profileDir: string,
  ) {}

  public run(...args: string[]): string {
    return execFileSync(this.bin, ['--profile', this.profileDir, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
  }

  public configureFilesystemSync(syncDir: string): void {
    this.run('config', 'sync.target', '2');
    this.run('config', 'sync.2.path', syncDir);
  }

  public sync(): string {
    return this.run('sync');
  }
}

interface SqliteRow {
  [key: string]: unknown;
}

/** Read-only peek into a Joplin profile database. */
export async function readProfileDb(databasePath: string): Promise<{
  get: (sql: string, params?: unknown[]) => Promise<SqliteRow | undefined>;
  all: (sql: string, params?: unknown[]) => Promise<SqliteRow[]>;
  close: () => Promise<void>;
}> {
  const db = await new Promise<InstanceType<typeof sqlite3.Database>>((resolve, reject) => {
    const handle = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, (err: Error | null) => {
      if (err) reject(err);
      else resolve(handle);
    });
  });
  return {
    get: (sql, params = []) =>
      new Promise((resolve, reject) =>
        db.get(sql, params, (err: Error | null, row: SqliteRow | undefined) => (err ? reject(err) : resolve(row))),
      ),
    all: (sql, params = []) =>
      new Promise((resolve, reject) =>
        db.all(sql, params, (err: Error | null, rows: SqliteRow[]) => (err ? reject(err) : resolve(rows))),
      ),
    close: () =>
      new Promise((resolve, reject) => db.close((err: Error | null) => (err ? reject(err) : resolve()))),
  };
}
