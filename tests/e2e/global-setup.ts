// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Sweeps orphaned e2e resources (label jonobones-e2e) before and after the
// run, so a crashed or interrupted previous run can't leak Joplin Server /
// app containers, volumes, or networks — or occupy ports.

import { execFileSync } from 'node:child_process';

function listIds(...args: string[]): string[] {
  return execFileSync('docker', args, { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function sweep(): void {
  try {
    const containers = listIds('ps', '-aq', '--filter', 'label=jonobones-e2e');
    if (containers.length) {
      execFileSync('docker', ['rm', '-f', ...containers], { encoding: 'utf8' });
      console.warn(`e2e: removed ${containers.length} leftover jonobones-e2e container(s)`);
    }
    // Containers first; volumes and networks only detach once they're gone.
    const volumes = listIds('volume', 'ls', '-q', '--filter', 'label=jonobones-e2e');
    if (volumes.length) {
      execFileSync('docker', ['volume', 'rm', ...volumes], { encoding: 'utf8' });
      console.warn(`e2e: removed ${volumes.length} leftover jonobones-e2e volume(s)`);
    }
    const networks = listIds('network', 'ls', '-q', '--filter', 'label=jonobones-e2e');
    if (networks.length) {
      execFileSync('docker', ['network', 'rm', ...networks], { encoding: 'utf8' });
      console.warn(`e2e: removed ${networks.length} leftover jonobones-e2e network(s)`);
    }
  } catch {
    // No docker daemon — the suites will skip themselves anyway.
  }
}

export default function globalSetup(): () => void {
  sweep();
  return sweep;
}
