// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SyncRunner, SyncRunResult } from '../joplin/sync.js';

export type SyncState = 'unconfigured' | 'idle' | 'syncing' | 'error';

export interface SchedulerSnapshot {
  state: SyncState;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastResult: string | null;
}

export interface TriggerResult {
  alreadyRunning: boolean;
}

/**
 * Interval + on-demand sync, single-flight: one sync cycle at a time, a
 * trigger during a run reports alreadyRunning instead of queueing.
 */
export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastResult: string | null = null;
  private lastOk = true;
  private stopped = false;
  private readonly onCycleComplete: (result: SyncRunResult) => void | Promise<void>;

  public constructor(
    private readonly runner: SyncRunner | null,
    private readonly intervalSeconds: number,
    hooks: { onCycleComplete?: (result: SyncRunResult) => void | Promise<void> } = {},
  ) {
    this.onCycleComplete = hooks.onCycleComplete ?? (() => {});
  }

  /** Kicks an immediate first sync, then repeats every intervalSeconds. */
  public start(): void {
    if (!this.runner) return;
    void this.triggerNow();
    if (this.intervalSeconds > 0) {
      this.timer = setInterval(() => void this.triggerNow(), this.intervalSeconds * 1000);
      this.timer.unref();
    }
  }

  public async triggerNow(): Promise<TriggerResult> {
    if (!this.runner || this.stopped) return { alreadyRunning: false };
    if (this.current) return { alreadyRunning: true };

    this.current = this.cycle();
    try {
      await this.current;
    } finally {
      this.current = null;
    }
    return { alreadyRunning: false };
  }

  private async cycle(): Promise<void> {
    this.lastStartedAt = new Date().toISOString();
    const result = await this.runner!.run();

    // The hook (post-sync event scan, journal pruning) runs BEFORE the
    // cycle reports complete: /status idle must imply this cycle's events
    // are journaled. Hook failures are logged, not turned into sync errors.
    try {
      await this.onCycleComplete(result);
    } catch (error) {
      console.error('post-sync hook failed:', error);
    }

    this.lastCompletedAt = new Date().toISOString();
    this.lastOk = result.ok;
    if (!result.ok) {
      this.lastResult = `error: ${result.error}`;
    } else if (result.itemErrors.length) {
      this.lastResult = `completed with ${result.itemErrors.length} item error(s): ${result.itemErrors[0]}`;
    } else {
      this.lastResult = 'ok';
    }
  }

  public snapshot(): SchedulerSnapshot {
    let state: SyncState;
    if (!this.runner) state = 'unconfigured';
    else if (this.current) state = 'syncing';
    else if (!this.lastOk) state = 'error';
    else state = 'idle';
    return {
      state,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      lastResult: this.lastResult,
    };
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.current) await this.current.catch(() => {});
  }
}
