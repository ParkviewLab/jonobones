// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Drives examples/jonobones-app.mjs as a child process — the second
// "actor" of the e2e tier, exactly like JoplinCli drives the official
// client. Non-watch commands run synchronously and return parsed JSON;
// `watch` is a long-lived child whose NDJSON stdout the tests await.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
export const APP_PATH = join(repoRoot, 'examples', 'jonobones-app.mjs');

export interface AppEnv {
  url: string;
  token: string;
}

function childEnv(env: AppEnv): NodeJS.ProcessEnv {
  // NODE_OPTIONS '' for the same reason JoplinCli does it: the test
  // runner's injected options must not leak into spawned node children.
  return { ...process.env, NODE_OPTIONS: '', JONOBONES_URL: env.url, JONOBONES_TOKEN: env.token };
}

/**
 * Run a one-shot app command; resolves with its single JSON document.
 * Async on purpose: the daemon under test lives in THIS process, so a
 * synchronous child wait (execFileSync) would block the event loop the
 * daemon needs to answer the child — a guaranteed deadlock.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function runApp(env: AppEnv, ...args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [APP_PATH, ...args],
      { encoding: 'utf8', timeout: 120_000, env: childEnv(env) },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`app ${args.join(' ')} failed: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`, {
              cause: error,
            }),
          );
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop()!));
        } catch (parseError) {
          reject(new Error(`app ${args.join(' ')} produced unparseable output:\n${stdout}`, { cause: parseError }));
        }
      },
    );
  });
}

export interface WatchLine {
  type: 'open' | 'event' | 'reset' | 'closed';
  id?: number;
  data?: { id: number; item_type: string; item_id: string; change_type: string; source: string };
  resumeFrom?: number;
}

export interface Watcher {
  lines: WatchLine[];
  /**
   * Resolves with the first line (past ones included — no missed-event
   * race) matching the predicate; rejects on timeout or child exit with
   * the recent lines + stderr tail attached.
   */
  waitForLine(pred: (line: WatchLine) => boolean, timeoutMs?: number): Promise<WatchLine>;
  stop(): Promise<void>;
}

export function spawnWatch(env: AppEnv, opts: { lastEventId?: number } = {}): Watcher {
  const args = [APP_PATH, 'watch'];
  if (opts.lastEventId !== undefined) args.push('--last-event-id', String(opts.lastEventId));
  const proc: ChildProcess = spawn(process.execPath, args, { env: childEnv(env) });

  const lines: WatchLine[] = [];
  const stderrTail: string[] = [];
  let exited = false;

  interface Waiter {
    pred: (line: WatchLine) => boolean;
    resolve: (line: WatchLine) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }
  const waiters = new Set<Waiter>();

  const diagnostics = () =>
    `last lines: ${JSON.stringify(lines.slice(-5))}; stderr: ${stderrTail.join('') || '(empty)'}`;

  proc.stderr!.on('data', (chunk: Buffer) => {
    stderrTail.push(chunk.toString('utf8'));
    if (stderrTail.length > 20) stderrTail.shift();
  });

  createInterface({ input: proc.stdout! }).on('line', (raw) => {
    if (!raw.trim()) return;
    const line = JSON.parse(raw) as WatchLine;
    lines.push(line);
    for (const waiter of [...waiters]) {
      if (waiter.pred(line)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  });

  proc.on('exit', () => {
    exited = true;
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`watch exited while waiting; ${diagnostics()}`));
    }
  });

  return {
    lines,
    waitForLine(pred, timeoutMs = 60_000) {
      const already = lines.find(pred);
      if (already) return Promise.resolve(already);
      if (exited) return Promise.reject(new Error(`watch already exited; ${diagnostics()}`));
      return new Promise<WatchLine>((resolve, reject) => {
        const waiter: Waiter = {
          pred,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`timed out waiting for watch line; ${diagnostics()}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    stop() {
      if (exited) return Promise.resolve();
      return new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5_000).unref();
      });
    },
  };
}
