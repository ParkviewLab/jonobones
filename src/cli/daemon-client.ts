// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isProcessAlive, readLock, type LockInfo } from '../config/lockfile.js';

export interface DaemonConnection {
  lock: LockInfo;
  base: string;
}

export function findRunningDaemon(profileDir: string): DaemonConnection | null {
  const lock = readLock(profileDir);
  if (!lock || !isProcessAlive(lock.pid)) return null;
  return { lock, base: `http://127.0.0.1:${lock.port}/v1` };
}

export async function daemonRequest(
  conn: DaemonConnection,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${conn.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${conn.lock.token}` },
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}
