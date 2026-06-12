import type { FastifyInstance } from 'fastify';
import type { JoplinContext } from '../../joplin/bootstrap.js';
import { e2eeStatusData, profileStatusData, syncStatusData, type SyncTargetSpec } from '../../joplin/sync.js';
import type { SyncScheduler } from '../../sync/scheduler.js';

export interface ServiceDeps {
  scheduler: SyncScheduler;
  syncSpec: SyncTargetSpec | null;
  /** M5 fills these from the event journal. */
  eventsStatus?: () => { oldestId: number | null; newestId: number | null };
}

export function registerServiceRoutes(v1: FastifyInstance, ctx: JoplinContext, deps: ServiceDeps): void {
  v1.get('/status', async () => {
    const [sync, e2ee, profile] = await Promise.all([
      syncStatusData(ctx, deps.syncSpec),
      e2eeStatusData(ctx),
      profileStatusData(ctx),
    ]);
    return {
      sync: { ...deps.scheduler.snapshot(), ...sync },
      e2ee,
      profile,
      events: deps.eventsStatus ? deps.eventsStatus() : { oldestId: null, newestId: null },
    };
  });

  v1.post('/sync', async (_request, reply) => {
    // Fire and report; 202 in both cases — the cycle is asynchronous either way.
    const resultPromise = deps.scheduler.triggerNow();
    const alreadyRunning = await Promise.race([
      resultPromise.then((r) => r.alreadyRunning),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    resultPromise.catch(() => {}); // surfaced via /status, not here
    return reply.code(202).send({ syncing: true, alreadyRunning });
  });
}
