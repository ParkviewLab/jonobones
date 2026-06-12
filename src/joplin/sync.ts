// Sync target configuration and the sync runner. config.json5 is canonical:
// every boot re-applies the mapped values into Joplin's Setting store, so
// the stock profile always reflects the config (never the other way round).

import type { JoplinContext } from './bootstrap.js';

export interface SyncTargetSpec {
  /** Joplin sync target id (SyncTarget*.id()). */
  id: number;
  name: string;
  /** jonobones config key (in the sync section) → Joplin setting key. */
  settings: Record<string, string>;
  required: string[];
}

export const SYNC_TARGETS: Record<string, SyncTargetSpec> = {
  filesystem: {
    id: 2,
    name: 'filesystem',
    settings: { path: 'sync.2.path' },
    required: ['path'],
  },
  onedrive: {
    id: 3,
    name: 'onedrive',
    settings: { auth: 'sync.3.auth' },
    required: ['auth'],
  },
  nextcloud: {
    id: 5,
    name: 'nextcloud',
    settings: { url: 'sync.5.path', username: 'sync.5.username', password: 'sync.5.password' },
    required: ['url', 'username', 'password'],
  },
  webdav: {
    id: 6,
    name: 'webdav',
    settings: { url: 'sync.6.path', username: 'sync.6.username', password: 'sync.6.password' },
    required: ['url', 'username', 'password'],
  },
  dropbox: {
    id: 7,
    name: 'dropbox',
    settings: { auth: 'sync.7.auth' },
    required: ['auth'],
  },
  s3: {
    id: 8,
    name: 's3',
    settings: {
      bucket: 'sync.8.path',
      url: 'sync.8.url',
      region: 'sync.8.region',
      accessKey: 'sync.8.username',
      secretKey: 'sync.8.password',
      forcePathStyle: 'sync.8.forcePathStyle',
    },
    required: ['bucket', 'url', 'accessKey', 'secretKey'],
  },
  joplinServer: {
    id: 9,
    name: 'joplinServer',
    settings: { url: 'sync.9.path', username: 'sync.9.username', password: 'sync.9.password' },
    required: ['url', 'username', 'password'],
  },
  joplinCloud: {
    id: 10,
    name: 'joplinCloud',
    settings: {
      url: 'sync.10.path',
      userContentUrl: 'sync.10.userContentPath',
      username: 'sync.10.username',
      password: 'sync.10.password',
    },
    required: ['username', 'password'],
  },
};

export class SyncConfigError extends Error {}

export interface ResolvedSyncTarget {
  spec: SyncTargetSpec;
  /** Joplin setting key → value to apply. */
  settingValues: Record<string, unknown>;
}

/**
 * Pure mapping from the jonobones sync config section to Joplin settings.
 * Returns null when no target is configured (daemon runs API-only).
 */
export function resolveSyncTarget(syncConfig: Record<string, unknown>): ResolvedSyncTarget | null {
  const target = syncConfig.target;
  if (target === undefined || target === null || target === '' || target === 'none') return null;
  if (typeof target !== 'string' || !(target in SYNC_TARGETS)) {
    throw new SyncConfigError(
      `unknown sync.target ${JSON.stringify(target)} (valid: ${Object.keys(SYNC_TARGETS).join(', ')}, none)`,
    );
  }
  const spec = SYNC_TARGETS[target]!;

  const missing = spec.required.filter((key) => {
    const value = syncConfig[key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length) {
    throw new SyncConfigError(`sync target "${target}" requires config keys: ${missing.join(', ')}`);
  }

  const settingValues: Record<string, unknown> = {};
  for (const [configKey, settingKey] of Object.entries(spec.settings)) {
    const value = syncConfig[configKey];
    if (value === undefined || value === null) continue;
    settingValues[settingKey] = value;
  }
  return { spec, settingValues };
}

export function applySyncTarget(ctx: JoplinContext, resolved: ResolvedSyncTarget): void {
  const { Setting } = ctx.lib;
  Setting.setValue('sync.target', resolved.spec.id);
  for (const [key, value] of Object.entries(resolved.settingValues)) {
    Setting.setValue(key, value);
  }
}

export async function applyE2eePassword(ctx: JoplinContext, masterPassword: string): Promise<void> {
  ctx.lib.Setting.setValue('encryption.masterPassword', masterPassword);
  await ctx.lib.e2eeUtils.loadMasterKeysFromSettings(ctx.services.encryptionService);
}

export interface SyncRunResult {
  ok: boolean;
  error?: string;
  /** Per-item error messages from the progress report (sync continued past them). */
  itemErrors: string[];
}

export class SyncRunner {
  private syncTarget: unknown | null = null;

  public constructor(
    private readonly ctx: JoplinContext,
    public readonly spec: SyncTargetSpec,
  ) {}

  /* eslint-disable @typescript-eslint/no-explicit-any -- lib boundary */
  private target(): any {
    if (!this.syncTarget) {
      const TargetClass = this.ctx.lib.SyncTargetRegistry.classById(this.spec.id);
      const target = new TargetClass(this.ctx.lib.database);
      target.setLogger((this.ctx.lib as any).logger ?? console);
      this.syncTarget = target;
    }
    return this.syncTarget;
  }

  public async synchronizer(): Promise<any> {
    const sync = await this.target().synchronizer();
    sync.setShareService(null);
    return sync;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /** Connectivity check: list the target root without syncing. */
  public async testConnection(): Promise<void> {
    const fileApi = await this.target().fileApi();
    await fileApi.list('', { context: null });
  }

  public async run(): Promise<SyncRunResult> {
    const { Setting } = this.ctx.lib;
    const contextKey = `sync.${this.spec.id}.context`;
    const contextString = Setting.value(contextKey) as string;
    const context = contextString ? JSON.parse(contextString) : {};

    const itemErrors: string[] = [];
    let lastReport: { errors?: unknown[] } = {};

    try {
      const synchronizer = await this.synchronizer();
      const newContext = await synchronizer.start({
        context,
        onProgress: (report: { errors?: unknown[] }) => {
          lastReport = report;
        },
      });
      Setting.setValue(contextKey, JSON.stringify(newContext));
    } catch (error) {
      return { ok: false, error: (error as Error).message, itemErrors };
    }

    for (const e of lastReport.errors ?? []) {
      itemErrors.push(e instanceof Error ? e.message : String(e));
    }

    await this.postSync();
    return { ok: true, itemErrors };
  }

  /** What stock Joplin clients do after a sync cycle. */
  private async postSync(): Promise<void> {
    const { ctx } = this;

    // New master keys may have arrived; (re)load them, then decrypt.
    if (ctx.lib.syncInfoUtils.getEncryptionEnabled()) {
      const password = ctx.lib.Setting.value('encryption.masterPassword') as string;
      if (password) {
        await ctx.lib.e2eeUtils.loadMasterKeysFromSettings(ctx.services.encryptionService);
        try {
          await ctx.services.decryptionWorker.start();
        } catch (error) {
          console.error('decryption worker failed:', (error as Error).message);
        }
      }
    }

    // Fetch resource blobs whose metadata arrived via sync.
    if (!ctx.services.resourceFetcher) {
      const fetcher = new ctx.lib.ResourceFetcher(() => this.target().fileApi());
      ctx.services.resourceFetcher = fetcher;
      ctx.lib.ResourceFetcher.instance_ = fetcher;
    }
    await ctx.services.resourceFetcher.autoAddResources();
    await ctx.services.resourceFetcher.start();
    await ctx.services.resourceFetcher.waitForAllFinished();

    // Keep note history accumulating like a stock client.
    try {
      await ctx.services.revisionService.collectRevisions();
    } catch (error) {
      console.error('revision collection failed:', (error as Error).message);
    }
  }
}

// --- /status data ----------------------------------------------------------

export interface SyncStatusData {
  target: string | null;
  pendingUpload: number;
  conflictCount: number;
}

export async function syncStatusData(ctx: JoplinContext, spec: SyncTargetSpec | null): Promise<SyncStatusData> {
  let pendingUpload = 0;
  if (spec) {
    const result = (await ctx.lib.BaseItemClass.itemsThatNeedSync(spec.id, 1000)) as { items: unknown[] };
    pendingUpload = result.items.length;
  }
  const conflictRows = (await ctx.lib.Note.modelSelectAll(
    'SELECT COUNT(*) as n FROM notes WHERE is_conflict = 1',
    [],
  )) as { n: number }[];
  return { target: spec?.name ?? null, pendingUpload, conflictCount: conflictRows[0]?.n ?? 0 };
}

export interface E2eeStatusData {
  enabled: boolean;
  pendingDecryption: number;
}

export async function e2eeStatusData(ctx: JoplinContext): Promise<E2eeStatusData> {
  const enabled = ctx.lib.syncInfoUtils.getEncryptionEnabled();
  let pendingDecryption = 0;
  for (const table of ['notes', 'folders', 'tags', 'resources']) {
    const rows = (await ctx.lib.Note.modelSelectAll(
      `SELECT COUNT(*) as n FROM ${table} WHERE encryption_applied = 1`,
      [],
    )) as { n: number }[];
    pendingDecryption += rows[0]?.n ?? 0;
  }
  return { enabled, pendingDecryption };
}

export async function profileStatusData(ctx: JoplinContext): Promise<{ path: string; schemaVersion: number }> {
  const rows = (await ctx.lib.Note.modelSelectAll('SELECT version FROM version LIMIT 1', [])) as
    { version: number }[];
  return { path: ctx.joplinProfileDir, schemaVersion: rows[0]?.version ?? 0 };
}
