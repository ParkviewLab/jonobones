// SPDX-FileCopyrightText: 2026 Gary Frattarola <garyf@parkviewlab.ai>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');

// The M0 derive spike, kept alive as an integration test: two independent
// processes bootstrap @joplin/lib headless and exchange a note through a
// filesystem sync target. If this breaks, the foundation broke.
describe('@joplin/lib derive spike', () => {
  it('two profiles exchange a note via a filesystem sync target', { timeout: 180_000 }, () => {
    const res = spawnSync(process.execPath, [join(repoRoot, 'spike', 'lib-spike.mjs'), 'run'], {
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      console.error(res.stdout);
      console.error(res.stderr);
    }
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('PASS');
  });
});
