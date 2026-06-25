// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { openSync, closeSync, writeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const LOCKFILE_NAME = 'lock.json';

// Discovery contract (plan §2.10): local clients read this file to find the
// daemon. 0600 because it contains the API token.
export interface LockInfo {
  pid: number;
  port: number;
  token: string;
  profile: string;
  startedAt: string;
  version: string;
}

export class AlreadyRunningError extends Error {
  public constructor(public readonly lock: LockInfo) {
    super(`jonobones is already running on port ${lock.port} (pid ${lock.pid})`);
  }
}

function lockPath(profileDir: string): string {
  return join(profileDir, LOCKFILE_NAME);
}

export function readLock(profileDir: string): LockInfo | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath(profileDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as LockInfo;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function writeLockExclusive(profileDir: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath(profileDir), 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(info, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

// Exclusive per-profile lock. Throws AlreadyRunningError when a live daemon
// holds the lock; silently replaces a stale lock left by a dead process.
export function acquireLock(profileDir: string, info: LockInfo): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (writeLockExclusive(profileDir, info)) return;
    const existing = readLock(profileDir);
    if (existing && isProcessAlive(existing.pid)) throw new AlreadyRunningError(existing);
    try {
      unlinkSync(lockPath(profileDir));
    } catch {
      // Lost a race with another process cleaning up; retry the exclusive create.
    }
  }
  throw new Error(`could not acquire ${lockPath(profileDir)} after retry`);
}

export function releaseLock(profileDir: string): void {
  const existing = readLock(profileDir);
  if (!existing || existing.pid !== process.pid) return;
  try {
    unlinkSync(lockPath(profileDir));
  } catch {
    // Already gone.
  }
}
