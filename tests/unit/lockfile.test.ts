// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AlreadyRunningError,
  LOCKFILE_NAME,
  acquireLock,
  readLock,
  releaseLock,
  type LockInfo,
} from '../../src/config/lockfile.js';

const tempDirs: string[] = [];
function tempProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jonobones-lock-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function lockInfo(pid: number): LockInfo {
  return {
    pid,
    port: 26637,
    token: 'secret',
    profile: '/tmp/p',
    startedAt: '2026-06-12T00:00:00.000Z',
    version: '0.1.0',
  };
}

describe('lockfile', () => {
  it('acquires, persists 0600, reads back, releases', () => {
    const dir = tempProfile();
    acquireLock(dir, lockInfo(process.pid));

    const mode = statSync(join(dir, LOCKFILE_NAME)).mode & 0o777;
    expect(mode).toBe(0o600);

    const read = readLock(dir);
    expect(read?.pid).toBe(process.pid);
    expect(read?.port).toBe(26637);

    releaseLock(dir);
    expect(readLock(dir)).toBeNull();
  });

  it('throws AlreadyRunningError while the holder is alive', () => {
    const dir = tempProfile();
    acquireLock(dir, lockInfo(process.pid)); // our own (alive) pid
    expect(() => acquireLock(dir, lockInfo(process.pid))).toThrow(AlreadyRunningError);
  });

  it('replaces a stale lock from a dead process', () => {
    const dir = tempProfile();
    // PIDs near the macOS/Linux max are overwhelmingly unlikely to be live in CI.
    const deadPid = 0x7ffffffe;
    acquireLock(dir, lockInfo(deadPid));
    expect(() => acquireLock(dir, lockInfo(process.pid))).not.toThrow();
    expect(readLock(dir)?.pid).toBe(process.pid);
  });

  it('treats corrupt lock files as stale', () => {
    const dir = tempProfile();
    writeFileSync(join(dir, LOCKFILE_NAME), 'not json');
    expect(() => acquireLock(dir, lockInfo(process.pid))).not.toThrow();
    expect(readLock(dir)?.pid).toBe(process.pid);
  });

  it('does not release a lock owned by another pid', () => {
    const dir = tempProfile();
    acquireLock(dir, lockInfo(0x7ffffffe));
    releaseLock(dir); // not ours — must stay
    expect(readLock(dir)?.pid).toBe(0x7ffffffe);
  });
});
