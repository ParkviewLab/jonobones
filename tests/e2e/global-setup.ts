// Sweeps orphaned e2e containers (label jonobones-e2e) before and after the
// run, so a crashed or interrupted previous run can't leak Joplin Server
// containers or occupy ports.

import { execFileSync } from 'node:child_process';

function sweepContainers(): void {
  try {
    const ids = execFileSync('docker', ['ps', '-aq', '--filter', 'label=jonobones-e2e'], {
      encoding: 'utf8',
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (ids.length) {
      execFileSync('docker', ['rm', '-f', ...ids], { encoding: 'utf8' });
      console.warn(`e2e: removed ${ids.length} leftover jonobones-e2e container(s)`);
    }
  } catch {
    // No docker daemon — the suites will skip themselves anyway.
  }
}

export default function globalSetup(): () => void {
  sweepContainers();
  return sweepContainers;
}
